import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { atrWilder } from "../src/indicators/atr";
import { rsi2ReversionD1 } from "../src/strategies/rsi2-reversion-d1";
import { bar, symbolData, testConfig, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
/**
 * Start of a server-time day. The series runs through the switch to summer
 * time on 2024-03-31, so a day is not always 24 hours of UTC.
 */
const dayStart = (day: number): number =>
  DateTime.fromISO("2024-01-01T00:00", { zone: ZONE }).plus({ days: day }).toMillis();
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
/** Days of the steady trend before the tail: enough for SMA(200). */
const TREND_DAYS = 210;
const AFTER_DAYS = 16;

/**
 * Daily closes as offsets from P: `TREND_DAYS` days moving 10 points a day
 * (up for `trend` 1, down for -1), then the `tail`, then 16 more days moving
 * 10 points a day from the last close (up unless `after` is -1). Each day opens at the previous
 * close and its range reaches 5 points beyond the open and the close; every
 * day is identical H1 bars, so the D1 bar is exactly that day. `sign` -1
 * mirrors every price around P.
 */
function run(
  tail: readonly number[],
  options: { sign?: 1 | -1; trend?: 1 | -1; after?: 1 | -1 } = {},
): {
  result: BacktestResult;
  d1: readonly Bar[];
} {
  const sign = options.sign ?? 1;
  const trend = options.trend ?? 1;
  const offsets: number[] = [];
  for (let day = 0; day < TREND_DAYS; day++) offsets.push(trend * 0.001 * day);
  offsets.push(...tail);
  const last = offsets.at(-1) as number;
  const after = options.after ?? 1;
  for (let day = 1; day <= AFTER_DAYS; day++) offsets.push(last + after * 0.001 * day);

  const closes = offsets.map((offset) => px(P + sign * offset));
  const bars: Bar[] = [];
  closes.forEach((close, day) => {
    const open = day === 0 ? close : (closes[day - 1] as number);
    const high = px(Math.max(open, close) + 0.0005);
    const low = px(Math.min(open, close) - 0.0005);
    for (let time = dayStart(day); time < dayStart(day + 1); time += HOUR) {
      bars.push(bar(time, open, high, low, close));
    }
  });
  const data = symbolData("EURUSD", bars);
  return {
    result: runBacktest({
      data: [data],
      strategy: rsi2ReversionD1,
      span: { start: dayStart(0), end: dayStart(closes.length) },
      config: testConfig(),
    }),
    d1: data.bars.D1,
  };
}

/** Day 210 falls 40 points, day 211 falls 80: RSI(2) 4.76, still far above SMA(200). */
const DIP = [0.205, 0.197];

describe("Rsi2ReversionD1 on a hand-made daily series", () => {
  // Day 212 adds 10 points (close under SMA(5) 0.2034), day 213 adds 60
  // (close 0.204 over SMA(5) 0.2026).
  const { result, d1 } = run([...DIP, 0.198, 0.204]);
  const trade = result.trades[0] as Trade;
  const atr = atrWilder(d1, 20)[211] as number;

  it("takes exactly one long trade", () => {
    expect(result.trades.map((item) => item.direction)).toEqual(["BUY"]);
    expect(result.skipped).toEqual([]);
  });

  it("signals on the close of the dip day and enters at the next D1 open", () => {
    expect(trade.signalTime).toBe(dayStart(212));
    expect(trade.entryTime).toBe(dayStart(212));
    expect(trade.entryPrice).toBe(1.397);
    expect(trade.reason).toMatch(/^D1 close 1\.39700 > SMA\(200\) 1\.3114\d; RSI\(2\) 4\.76; ATR\(20\) 0\.0024\d$/);
  });

  it("puts the stop 2 x ATR(20) of the signal day below the entry", () => {
    // ATR: 0.002 a day, then 0.005 and 0.009 on the dip days: 0.0024925.
    expect(atr).toBeCloseTo(0.0024925, 9);
    // 1.397 - 0.004985 = 1.392015, rounded to the 5 digits of the price.
    expect(trade.stopLoss).toBe(1.39202);
    expect(trade.stopDistance).toBeCloseTo(0.00498, 9);
    expect(trade.takeProfit).toBeNull();
    expect(trade.lots).toBe(0.1);
  });

  it("leaves at the next open after the first close above SMA(5)", () => {
    expect(trade.exitReason).toBe("strategy");
    expect(trade.exitTime).toBe(dayStart(214));
    expect(trade.exitPrice).toBe(1.404);
  });
});

describe("Rsi2ReversionD1 rules", () => {
  it("mirrors for a short in a downtrend", () => {
    const { result } = run([...DIP, 0.198, 0.204], { sign: -1 });
    expect(result.trades.map((item) => item.direction)).toEqual(["SELL"]);
    const trade = result.trades[0] as Trade;
    expect(trade.entryPrice).toBe(1.003);
    expect(trade.exitPrice).toBe(0.996);
    expect(trade.reason).toMatch(/^D1 close 1\.00300 < SMA\(200\) 1\.0885\d; RSI\(2\) 95\.24; /);
  });

  it("does not buy when RSI(2) stays just above 5", () => {
    // Day 211 falls 60 points instead of 80: RSI(2) 5.88.
    const { result } = run([0.205, 0.199, 0.2, 0.201]);
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("does not buy below SMA(200), however low RSI(2) is", () => {
    // A steady fall keeps RSI(2) at 0 all the time; the sharp dip adds nothing.
    const { result } = run([-0.213, -0.221], { trend: -1, after: -1 });
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("holds while the close stays under SMA(5)", () => {
    // Day 213 closes at 0.202: above SMA(4) 0.2005 but under SMA(5) 0.2022.
    // Day 214 closes at 0.203, above SMA(5) 0.201: exit at the open of day 215.
    const { result } = run([...DIP, 0.198, 0.202]);
    const trade = result.trades[0] as Trade;
    expect(trade.exitReason).toBe("strategy");
    expect(trade.exitTime).toBe(dayStart(215));
    expect(trade.exitPrice).toBe(1.403);
  });

  it("ignores a new dip while the position is open", () => {
    // Day 212 falls 20 more points (RSI(2) 3.4) without reaching the stop.
    const { result } = run([...DIP, 0.195, 0.204]);
    expect(result.trades.map((item) => item.exitReason)).toEqual(["strategy"]);
    expect(result.skipped).toEqual([]);
  });

  it("can buy again on the close of the day the stop was hit", () => {
    // Day 212 falls 60 points through the stop; its close is a new signal.
    const { result } = run([...DIP, 0.191, 0.201]);
    expect(result.trades.map((item) => item.exitReason)).toEqual(["stop", "strategy"]);
    const [first, second] = result.trades as [Trade, Trade];
    expect(first.exitTime).toBe(dayStart(212));
    expect(second.signalTime).toBe(dayStart(213));
    expect(second.entryPrice).toBe(1.391);
    expect(second.exitTime).toBe(dayStart(214));
  });

  it("declares its fixed parameters", () => {
    expect(rsi2ReversionD1.params).toMatchObject({
      rsiPeriod: 2,
      buyBelowRsi: 5,
      sellAboveRsi: 95,
      trendSmaPeriod: 200,
      exitSmaPeriod: 5,
      atrPeriod: 20,
      atrMultiple: 2,
    });
    expect(rsi2ReversionD1.executionTimeframe).toBe("H1");
  });
});
