import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { atrWilder } from "../src/indicators/atr";
import { lineAt, threeTouchTrendD1 } from "../src/strategies/three-touch-trend-d1";
import { bar, symbolData, testConfig, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
const dayStart = (day: number): number =>
  DateTime.fromISO("2024-01-01T00:00", { zone: ZONE }).plus({ days: day }).toMillis();

type Day = { open: number; high: number; low: number; close: number };

/**
 * Daily bars from closes (offsets from P): each day opens at the previous
 * close and reaches 5 points beyond its body; a strict local peak or trough
 * of the closes reaches 3 points further, so swing points never tie.
 * `override` replaces whole days. `sign` -1 mirrors every price around P.
 */
function days(closes: readonly number[], override: Record<number, Day> = {}, sign: 1 | -1 = 1): Day[] {
  return closes.map((close, i) => {
    const custom = override[i];
    if (custom !== undefined) return custom;
    const open = i === 0 ? close : (closes[i - 1] as number);
    const prev = closes[i - 1];
    const next = closes[i + 1];
    const peak = prev !== undefined && next !== undefined && close > prev && close > next;
    const trough = prev !== undefined && next !== undefined && close < prev && close < next;
    const high = Math.max(open, close) + 0.0005 + (peak ? 0.0003 : 0);
    const low = Math.min(open, close) - 0.0005 - (trough ? 0.0003 : 0);
    return sign === 1 ? { open, high, low, close } : { open: -open, high: -low, low: -high, close: -close };
  });
}

function run(list: readonly Day[]): { result: BacktestResult; d1: readonly Bar[] } {
  const bars: Bar[] = [];
  list.forEach((d, i) => {
    for (let time = dayStart(i); time < dayStart(i + 1); time += HOUR) {
      bars.push(bar(time, px(P + d.open), px(P + d.high), px(P + d.low), px(P + d.close)));
    }
  });
  const data = symbolData("EURUSD", bars);
  return {
    result: runBacktest({
      data: [data],
      strategy: threeTouchTrendD1,
      span: { start: dayStart(0), end: dayStart(list.length) },
      config: testConfig(),
    }),
    d1: data.bars.D1,
  };
}

/** Straight legs between (day, offset) points. */
function legs(points: readonly [number, number][]): number[] {
  const closes: number[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const [d0, v0] = points[k] as [number, number];
    const [d1, v1] = points[k + 1] as [number, number];
    for (let d = d0; d < d1; d++) closes[d] = v0 + ((v1 - v0) * (d - d0)) / (d1 - d0);
  }
  const [lastDay, lastValue] = points.at(-1) as [number, number];
  closes[lastDay] = lastValue;
  return closes;
}

// Flat to day 30; trough L1 on day 44 (1.1692), peak on day 59, trough L2 on
// day 69 (1.1792), peak on day 84 (1.2108), down to day 94, then up.
const ZIGZAG: [number, number][] = [
  [0, 0], [30, 0], [44, -0.03], [59, 0], [69, -0.02], [84, 0.01], [94, -0.008],
];
const LINE = { first: { index: 44, price: P - 0.0308 }, second: { index: 69, price: P - 0.0208 } };

/** Day 95 dips to 2 points under the line and closes 10 points above it; then 20 days up. */
function scenario(sign: 1 | -1 = 1, edit?: (closes: number[]) => void): Day[] {
  const closes = legs(ZIGZAG);
  const touchLine = lineAt(LINE, 95) - P;
  closes[95] = touchLine + 0.001;
  for (let d = 96; d < 116; d++) closes[d] = (closes[d - 1] as number) + 0.002;
  edit?.(closes);
  const touch: Day = {
    open: closes[94] as number,
    high: (closes[94] as number) + 0.0005,
    low: touchLine - 0.0002,
    close: touchLine + 0.001,
  };
  const mirrored = sign === 1 ? touch : { open: -touch.open, high: -touch.low, low: -touch.high, close: -touch.close };
  return days(closes, { 95: mirrored }, sign);
}

describe("ThreeTouchTrendD1 on a hand-made daily zigzag", () => {
  const { result, d1 } = run(scenario());
  const trade = result.trades[0] as Trade;
  const atr = atrWilder(d1, 14)[95] as number;

  it("buys at the open after the third touch of the rising line", () => {
    expect(result.trades.map((item) => item.direction)).toEqual(["BUY"]);
    expect(result.skipped).toEqual([]);
    expect(trade.entryTime).toBe(dayStart(96));
    expect(trade.entryPrice).toBe(px(lineAt(LINE, 95) + 0.001));
  });

  it("puts the stop under the second low and the take at the highest high since it", () => {
    expect(trade.stopLoss).toBe(px(P - 0.0208 - 0.1 * atr));
    expect(trade.takeProfit).toBe(px(P + 0.0108));
    expect(trade.exitReason).toBe("take");
  });

  it("names both points of the line and the touch", () => {
    expect(trade.reason).toContain("линия по минимумам 2024-02-14 1.16920 — 2024-03-10 1.17920");
    expect(trade.reason).toContain("касание 2024-04-05");
  });
});

describe("ThreeTouchTrendD1 rules", () => {
  it("mirrors for a sell at a falling line through two highs", () => {
    const { result } = run(scenario(-1));
    expect(result.trades.map((item) => [item.direction, item.exitReason])).toEqual([["SELL", "take"]]);
    expect(result.trades[0]?.reason).toContain("линия по максимумам");
  });

  it("drops the line after a close below it", () => {
    // Day 90 closes 10 points under the line, then the price comes back.
    const { result } = run(
      scenario(1, (closes) => {
        closes[90] = lineAt(LINE, 90) - P - 0.001;
      }),
    );
    expect(result.trades).toEqual([]);
  });

  it("draws no rising line when the second low is not higher", () => {
    const { result } = run(
      scenario(1, (closes) => {
        for (let d = 59; d <= 69; d++) closes[d] = -0.035 * ((d - 59) / 10) + 0 * (1 - (d - 59) / 10);
        for (let d = 70; d <= 84; d++) closes[d] = -0.035 + (0.045 * (d - 69)) / 15;
      }),
    );
    expect(result.trades.filter((item) => item.direction === "BUY")).toEqual([]);
  });

  it("needs a swing high between the two lows", () => {
    // A flat top from day 52 to 60: equal highs make no swing high.
    const { result } = run(
      scenario(1, (closes) => {
        for (let d = 45; d <= 51; d++) closes[d] = -0.03 + (0.016 * (d - 44)) / 8;
        for (let d = 52; d <= 60; d++) closes[d] = -0.014;
        for (let d = 61; d <= 69; d++) closes[d] = -0.014 - (0.006 * (d - 60)) / 9;
      }),
    );
    expect(result.trades).toEqual([]);
  });

  it("lets a line expire 120 bars after its second point", () => {
    // Nearly flat line (L2 only 1 point above L1); the price waits above it and touches late.
    const late = (touchDay: number): Day[] => {
      const closes = legs([[0, 0], [30, 0], [44, -0.03], [59, 0], [69, -0.0299], [84, 0]]);
      const line = { first: { index: 44, price: P - 0.0308 }, second: { index: 69, price: P - 0.0307 } };
      for (let d = 85; d < touchDay - 8; d++) closes[d] = 0;
      for (let d = touchDay - 8; d < touchDay; d++) closes[d] = (lineAt(line, touchDay) - P + 0.004) * ((d - touchDay + 9) / 8);
      const value = lineAt(line, touchDay) - P;
      closes[touchDay] = value + 0.001;
      for (let d = touchDay + 1; d < touchDay + 40; d++) closes[d] = (closes[d - 1] as number) + 0.001;
      return days(closes, {
        [touchDay]: { open: closes[touchDay - 1] as number, high: (closes[touchDay - 1] as number) + 0.0005, low: value - 0.0002, close: value + 0.001 },
      });
    };
    expect(run(late(180)).result.trades.map((item) => item.direction)).toEqual(["BUY"]);
    expect(run(late(195)).result.trades).toEqual([]);
  });

  it("declares its fixed parameters and its eleven instruments", () => {
    expect(threeTouchTrendD1.params).toMatchObject({ wingsD1: 10, lifeD1: 120, atrPeriod: 14, touchBufferAtr: 0.1, stopBufferAtr: 0.1 });
    expect(threeTouchTrendD1.symbols).toHaveLength(11);
    expect(threeTouchTrendD1.executionTimeframe).toBe("H1");
  });
});
