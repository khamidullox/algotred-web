import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data/types";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Strategy, Trade } from "../src/engine/types";
import { US_INDICES } from "../src/strategies/baskets";
import { ibs, IBS_CONTROL, IBS_DIP, ibsDipIndexD1, ibsIndexControl } from "../src/strategies/ibs-dip-index-d1";
import { bar, symbolData, testConfig, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
const P = 1.2;
const PIP = 0.0001;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
/** A price `pips` away from P. */
const m = (pips: number): number => px(P + pips * PIP);
const dayStart = (day: number): number => DateTime.fromISO("2024-01-01T00:00", { zone: ZONE }).plus({ days: day }).toMillis();

/** A day in pips from P. */
type Day = readonly [open: number, high: number, low: number, close: number];

/** A quiet day: back where it opened, in the middle of a 20-pip range. ATR(20) of such days is 20 pips, RSI(2) is 50. */
const QUIET: Day = [0, 10, -10, 0];
/** Thirty quiet days: days 0 to 29. The day after them has index 30. */
const CALM: readonly Day[] = Array.from({ length: 30 }, () => QUIET);
/** Day 30 closes 2 pips above the low of a 60-pip range: IBS 0.03. ATR(20) becomes 22 pips, the stop 44 pips. */
const DIP: Day = [0, 10, -50, -48];
/** Days 31 and 32 climb back: RSI(2) is 52 after the first and 73.3 after the second. */
const BOUNCE: readonly Day[] = [
  [-48, -20, -50, -22],
  [-22, 0, -24, -2],
];
/** `count` days each closing a pip lower from `from`: RSI(2) stays at zero and the day never closes near its low. */
const slide = (from: number, count: number): Day[] =>
  Array.from({ length: count }, (_, k) => [from - k, from - k + 2, from - k - 3, from - k - 1] as Day);
const quietAt = (level: number, count: number): Day[] =>
  Array.from({ length: count }, () => [level, level + 10, level - 10, level] as Day);

/**
 * Every day is 24 hourly bars: the first reaches the high and comes back, the
 * second reaches the low and comes back, the last one closes the day. The
 * strategies trade the index CFDs; here their rules run on EURUSD-shaped prices.
 */
function run(strategy: Strategy, days: readonly Day[]): BacktestResult {
  const bars: Bar[] = [];
  days.forEach(([open, high, low, close], day) => {
    for (let hour = 0; hour < 24; hour++) {
      const time = dayStart(day) + hour * HOUR;
      if (hour === 0) bars.push(bar(time, m(open), m(high), m(open), m(open)));
      else if (hour === 1) bars.push(bar(time, m(open), m(open), m(low), m(open)));
      else if (hour === 23) bars.push(bar(time, m(open), m(Math.max(open, close)), m(Math.min(open, close)), m(close)));
      else bars.push(bar(time, m(open), m(open), m(open), m(open)));
    }
  });
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: { ...strategy, symbols: ["EURUSD"] },
    span: { start: dayStart(0), end: dayStart(days.length) },
    config: testConfig(),
  });
}

const only = (result: BacktestResult): Trade => {
  expect(result.trades).toHaveLength(1);
  return result.trades[0] as Trade;
};

describe("IbsDipIndexD1: the trade", () => {
  it("buys at the next open after a close near the low and leaves after RSI(2) above 70", () => {
    const result = run(ibsDipIndexD1, [...CALM, DIP, ...BOUNCE, ...quietAt(-2, 8)]);
    const trade = only(result);
    expect(result.skipped).toEqual([]);
    expect(trade.direction).toBe("BUY");
    expect(trade.signalTime).toBe(dayStart(31));
    expect(trade.entryTime).toBe(dayStart(31));
    expect(trade.entryPrice).toBe(m(-48));
    // Rule 3: 2 x ATR(20); ATR is (19 x 20 + 60) / 20 = 22 pips after the dip.
    expect(trade.stopDistance).toBe(px(44 * PIP));
    expect(trade.stopLoss).toBe(m(-92));
    expect(trade.takeProfit).toBeNull();
    // Rule 4: RSI(2) is 52 after day 31 and 73.3 after day 32.
    expect(trade.exitReason).toBe("strategy");
    expect(trade.exitTime).toBe(dayStart(33));
    expect(trade.exitPrice).toBe(m(-2));
    expect(trade.rMultiple).toBeCloseTo(46 / 44, 10);
    expect(trade.reason).toBe("D1 2024-01-31 close 1.19520: IBS 0.03 (low 1.19500, high 1.20100); ATR(20) 0.00220");
  });

  it("leaves after ten daily closes when RSI(2) never recovers", () => {
    // Day 35 closes near its low again: with a position open it is not a new signal.
    const days = [...CALM, DIP, ...slide(-48, 4), [-52, -50, -82, -81] as Day, ...slide(-81, 5), ...quietAt(-86, 6)];
    const result = run(ibsDipIndexD1, days);
    const trade = only(result);
    expect(result.skipped).toEqual([]);
    expect(trade.entryTime).toBe(dayStart(31));
    expect(trade.exitReason).toBe("strategy");
    expect(trade.exitTime).toBe(dayStart(41));
    expect(trade.exitPrice).toBe(m(-86));
  });

  it("is stopped 2 x ATR(20) under the entry", () => {
    const trade = only(run(ibsDipIndexD1, [...CALM, DIP, [-48, -46, -100, -60], ...quietAt(-60, 6)]));
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitPrice).toBe(m(-92));
    expect(trade.exitTime).toBe(dayStart(31) + HOUR);
    expect(trade.rMultiple).toBeCloseTo(-1, 10);
  });

  it("counts the days of every trade from zero", () => {
    // The first trade lasts two closes; the second one must still get its ten.
    const second: Day = [-2, 8, -52, -50];
    const days = [...CALM, DIP, ...BOUNCE, ...quietAt(-2, 3), second, ...slide(-50, 10), ...quietAt(-60, 6)];
    const result = run(ibsDipIndexD1, days);
    expect(result.trades.map((trade) => [trade.entryTime, trade.exitTime])).toEqual([
      [dayStart(31), dayStart(33)],
      [dayStart(37), dayStart(47)],
    ]);
  });
});

describe("IbsDipIndexD1: the signal (rule 1)", () => {
  it("needs the close in the lowest tenth of the day's range", () => {
    // A range of 100 pips: 9 pips above the low is a signal, 11 pips is not.
    expect(run(ibsDipIndexD1, [...CALM, [0, 50, -50, -41], ...quietAt(-41, 6)]).trades).toHaveLength(1);
    const none = run(ibsDipIndexD1, [...CALM, [0, 50, -50, -39], ...quietAt(-39, 6)]);
    expect(none.trades).toHaveLength(0);
    expect(none.skipped).toEqual([]);
  });

  it("does not sell a close near the high", () => {
    const result = run(ibsDipIndexD1, [...CALM, [0, 50, -10, 48], ...quietAt(48, 6)]);
    expect(result.trades).toHaveLength(0);
    expect(result.skipped).toEqual([]);
  });

  it("takes no signal from a day without a range", () => {
    const result = run(ibsDipIndexD1, [...CALM, [0, 0, 0, 0], ...quietAt(0, 6)]);
    expect(result.trades).toHaveLength(0);
    expect(ibs(bar(0, 1.2, 1.2, 1.2, 1.2))).toBeNaN();
  });

  it("waits for ATR(20)", () => {
    // A dip on day 10: the ATR has no value yet.
    const result = run(ibsDipIndexD1, [...CALM.slice(0, 10), DIP, ...quietAt(-48, 6)]);
    expect(result.trades).toHaveLength(0);
    expect(result.skipped).toEqual([]);
  });

  it("measures where the close lies between the low and the high", () => {
    expect(ibs(bar(0, 1.2, 1.21, 1.2, 1.2))).toBe(0);
    expect(ibs(bar(0, 1.2, 1.21, 1.2, 1.21))).toBe(1);
    expect(ibs(bar(0, 1.2, 1.3, 1.1, 1.15))).toBeCloseTo(0.25, 12);
  });
});

describe("IbsIndexControl", () => {
  it("enters after a close in the middle of the range and holds ten daily closes", () => {
    const result = run(ibsIndexControl, quietAt(0, 45));
    // ATR(20) has its first value on day 20.
    const [first, second] = result.trades as [Trade, Trade];
    expect(first.direction).toBe("BUY");
    expect(first.entryTime).toBe(dayStart(21));
    expect(first.stopDistance).toBe(px(40 * PIP));
    expect(first.exitTime).toBe(dayStart(31));
    expect(second.entryTime).toBe(dayStart(32));
  });

  it("stays out after a dip and after a close in the upper part of the range", () => {
    // Day 20 closes near the low, day 21 at 70% of the range, day 22 in the middle.
    const days = [...CALM.slice(0, 20), [0, 10, -50, -48] as Day, [-48, -38, -58, -44] as Day, ...quietAt(-44, 20)];
    const control = run(ibsIndexControl, days);
    expect((control.trades[0] as Trade).entryTime).toBe(dayStart(23));
    // The main rule takes exactly the day the control leaves out.
    expect((run(ibsDipIndexD1, days).trades[0] as Trade).entryTime).toBe(dayStart(21));
  });
});

describe("IbsDipIndexD1: what is fixed", () => {
  it("trades the three US index CFDs on H1 with the numbers chosen in TZ 17.17", () => {
    expect(ibsDipIndexD1.name).toBe("IbsDipIndexD1");
    expect(ibsIndexControl.name).toBe("IbsIndexControl");
    for (const strategy of [ibsDipIndexD1, ibsIndexControl]) {
      expect(strategy.symbols).toEqual(US_INDICES);
      expect(strategy.executionTimeframe).toBe("H1");
    }
    expect(IBS_DIP).toEqual({ ibsBelow: 0.1, rsiPeriod: 2, exitAboveRsi: 70, maxDays: 10, atrPeriod: 20, atrMultiple: 2 });
    expect(IBS_CONTROL).toEqual({ ibsFrom: 0.45, ibsBelow: 0.55 });
    expect(ibsDipIndexD1.params.ibsBelow).toBe(0.1);
    expect(ibsIndexControl.params).toMatchObject({ ibsFrom: 0.45, ibsBelow: 0.55, exitAboveRsi: 70, maxDays: 10 });
  });
});
