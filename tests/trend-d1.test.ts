import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { trendD1 } from "../src/strategies/trend-d1";
import { at, bar, symbolData, testConfig } from "./helpers/bars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = at("2024-01-01T00:00");
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;

interface Day {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** 24 identical H1 bars per day, so the D1 bar is exactly the day given. */
function hourly(days: readonly Day[]): Bar[] {
  const bars: Bar[] = [];
  days.forEach((day, index) => {
    for (let hour = 0; hour < 24; hour++) {
      bars.push(
        bar(START + index * DAY + hour * HOUR, day.open, day.high, day.low, day.close),
      );
    }
  });
  return bars;
}

/**
 * 76 days: 60 quiet days with a 20-point range, a breakout on day 60, nine
 * days at the new level, a close through the 20-day channel on day 70, and a
 * quiet tail. `sign` = 1 builds the long case, -1 mirrors it for the short.
 */
function scenario(sign: 1 | -1): Day[] {
  const quiet = (level: number): Day => ({
    open: px(level),
    high: px(level + 0.001),
    low: px(level - 0.001),
    close: px(level),
  });
  const days: Day[] = [];
  for (let index = 0; index < 60; index++) days.push(quiet(P));
  // Breakout: close 30 points beyond the 55-day extreme (P +/- 0.001).
  days.push({
    open: px(P),
    high: px(sign === 1 ? P + 0.0035 : P + 0.0005),
    low: px(sign === 1 ? P - 0.0005 : P - 0.0035),
    close: px(P + sign * 0.003),
  });
  for (let index = 61; index < 70; index++) days.push(quiet(P + sign * 0.003));
  // Day 70 closes one point beyond the 20-day channel on the other side
  // (P -/+ 0.001) but does not reach the stop at 42 points from the entry.
  days.push({
    open: px(P + sign * 0.003),
    high: px(sign === 1 ? P + 0.003 : P + 0.0011),
    low: px(sign === 1 ? P - 0.0011 : P - 0.003),
    close: px(P - sign * 0.0011),
  });
  for (let index = 71; index < 76; index++) days.push(quiet(P - sign * 0.0011));
  return days;
}

function run(sign: 1 | -1) {
  const bars = hourly(scenario(sign));
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: trendD1,
    span: { start: START, end: START + 76 * DAY },
    config: testConfig(),
  });
}

describe("TrendD1 on a hand-made daily series", () => {
  const long = run(1);
  const short = run(-1);

  it("takes exactly one trade in each direction", () => {
    expect(long.trades.map((trade) => trade.direction)).toEqual(["BUY"]);
    expect(short.trades.map((trade) => trade.direction)).toEqual(["SELL"]);
    expect(long.skipped).toEqual([]);
    expect(short.skipped).toEqual([]);
  });

  it("signals on the D1 close of the breakout day and enters at the next D1 open", () => {
    const trade = long.trades[0] as Trade;
    expect(trade.signalTime).toBe(START + 61 * DAY);
    expect(trade.entryTime).toBe(START + 61 * DAY);
    expect(trade.entryPrice).toBe(1.203);
    expect(trade.reason).toBe("D1 close 1.20300 > high(55) 1.20100; ATR(20) 0.00210");
  });

  it("puts the stop 2 x ATR(20) from the entry, with the breakout day in the ATR", () => {
    // 19 quiet days with TR 0.002 and the breakout day with TR 0.004:
    // ATR = (19 * 0.002 + 0.004) / 20 = 0.0021, stop distance 0.0042.
    expect((long.trades[0] as Trade).stopDistance).toBe(0.0042);
    expect((long.trades[0] as Trade).stopLoss).toBe(1.1988);
    expect((short.trades[0] as Trade).stopLoss).toBe(1.2012);
  });

  it("sizes 0.11 lot for 50 USD at a 42-point stop", () => {
    const trade = long.trades[0] as Trade;
    expect(trade.lots).toBe(0.11);
    expect(trade.riskUsd).toBeCloseTo(46.2, 6);
  });

  it("leaves at the next open after a close through the 20-day channel", () => {
    const trade = long.trades[0] as Trade;
    expect(trade.exitReason).toBe("strategy");
    expect(trade.exitTime).toBe(START + 71 * DAY);
    expect(trade.exitPrice).toBe(1.1989);
    expect(trade.reason).toContain("high(55)");
    expect(trade.netPnlUsd).toBeCloseTo(-45.1, 6);
    expect(trade.rMultiple).toBeCloseTo(-45.1 / 46.2, 6);
  });

  it("mirrors exactly for the short", () => {
    const trade = short.trades[0] as Trade;
    expect(trade.entryPrice).toBe(1.197);
    expect(trade.exitPrice).toBe(1.2011);
    expect(trade.netPnlUsd).toBeCloseTo(-45.1, 6);
  });

  it("does not reverse: the breakdown that closes the long is not a short entry", () => {
    // Day 70 closes below the 55-day low as well, yet only the exit happens.
    expect(long.trades).toHaveLength(1);
    expect(long.skipped).toEqual([]);
  });

  it("declares its fixed parameters", () => {
    expect(trendD1.params).toMatchObject({
      entryLookback: 55,
      exitLookback: 20,
      atrPeriod: 20,
      atrMultiple: 2,
    });
    expect(trendD1.executionTimeframe).toBe("H1");
  });
});
