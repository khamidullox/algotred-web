import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { atrWilder } from "../src/indicators/atr";
import { GOLD_FLAT, goldFlatLimitM15 } from "../src/strategies/gold-flat-limit-m15";
import { at, bar, symbolData, testConfig } from "./helpers/bars";

const STEP = 15 * 60_000;
const P = 1.1;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
// The rules are tested on EURUSD prices: the strategy itself trades XAUUSD only.
const strategy = { ...goldFlatLimitM15, symbols: ["EURUSD"] };

type Candle = readonly [open: number, high: number, low: number, close: number];

interface Plan {
  /** Server time of the first bar. Default: Monday 03:00, so the breakout comes at 17:30 (London 15:30). */
  readonly start?: string;
  readonly sign?: 1 | -1;
  /** Flat candles after the impulse. */
  readonly flatBars?: number;
  /** Half the body range of the flat candles. */
  readonly flatHalf?: number;
  /** Candles after the breakout, as offsets from the flat's middle F. */
  readonly after?: readonly Candle[];
}

// Flat middle F; bodies of the flat run from F - 0.0003 to F + 0.0003.
const F = 0.0036;
const RETEST_AND_UP: Candle[] = [
  [F + 0.0006, F + 0.0006, F + 0.0002, F + 0.0004], // back to the top edge: the buy limit fills
  [F + 0.0004, F + 0.0011, F + 0.0003, F + 0.001], // TP1: half closed
  [F + 0.001, F + 0.002, F + 0.0009, F + 0.0019], // TP2: the rest
];

/**
 * 40 quiet candles (ATR about 0.0010), six impulse candles up 0.0006 each,
 * a flat of bodies, a breakout candle closing at F + 0.0006, then `after`.
 */
function candles(plan: Plan = {}): Candle[] {
  const list: Candle[] = [];
  for (let i = 0; i < 40; i++) list.push([0, 0.0005, -0.0005, 0]);
  for (let i = 1; i <= 6; i++) list.push([(i - 1) * 0.0006, i * 0.0006 + 0.0002, (i - 1) * 0.0006 - 0.0002, i * 0.0006]);
  const half = plan.flatHalf ?? 0.0003;
  for (let i = 0; i < (plan.flatBars ?? 12); i++) {
    const up = i % 2 === 0;
    list.push([up ? F - half : F + half, F + half + 0.0002, F - half - 0.0002, up ? F + half : F - half]);
  }
  // The breakout closes 0.0003 above the top edge (0.1 ATR is about 0.0001).
  list.push([F, F + half + 0.0004, F - 0.0001, F + half + 0.0003]);
  list.push(...(plan.after ?? RETEST_AND_UP));
  for (let i = 0; i < 30; i++) list.push([F + 0.0019, F + 0.0021, F + 0.0017, F + 0.0019]);
  return list;
}

function run(plan: Plan = {}): { result: BacktestResult; bars: Bar[]; breakout: number } {
  const sign = plan.sign ?? 1;
  const start = at(plan.start ?? "2024-01-08T03:00");
  const list = candles(plan);
  const m = (v: number): number => px(P + sign * v);
  const bars = list.map(([o, h, l, c], i) => bar(start + i * STEP, m(o), sign === 1 ? m(h) : m(l), sign === 1 ? m(l) : m(h), m(c)));
  const result = runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy,
    span: { start, end: start + bars.length * STEP },
    config: testConfig(),
  });
  return { result, bars, breakout: 40 + 6 + (plan.flatBars ?? 12) };
}

describe("GoldFlatLimitM15 on a hand-made flat", () => {
  const { result, bars, breakout } = run();
  const trade = result.trades[0] as Trade;
  const atr = atrWilder(bars, GOLD_FLAT.atrPeriod)[breakout] as number;
  const top = px(P + F + 0.0003);
  const bottom = px(P + F - 0.0003);
  const stop = px(bottom - 0.1 * atr);
  const distance = top - stop;

  it("buys with a limit on the top edge of the flat bodies after the breakout", () => {
    expect(result.trades.map((item) => item.direction)).toEqual(["BUY"]);
    expect(result.skipped).toEqual([]);
    expect(trade.entryTime).toBe((bars[breakout + 1] as Bar).time);
    expect(trade.entryPrice).toBe(top);
  });

  it("puts the stop under the bottom edge and closes half at 1:1, the rest at 1:2", () => {
    expect(trade.stopLoss).toBe(stop);
    expect(trade.partialPrice).toBe(px(top + distance));
    expect(trade.partialLots).toBe(Math.floor((trade.lots / 2) * 100 + 1e-9) / 100);
    expect([trade.exitReason, trade.exitPrice]).toEqual(["take", px(top + 2 * distance)]);
  });

  it("describes the level and the breakout for the chart", () => {
    expect(trade.reason).toContain(`L ${top.toFixed(5)}`);
    expect(trade.reason).toContain("пробой 2024-01-08 17:30");
  });
});

describe("GoldFlatLimitM15 rules", () => {
  it("mirrors for a sell below the flat", () => {
    const { result } = run({ sign: -1 });
    expect(result.trades.map((item) => [item.direction, item.exitReason])).toEqual([["SELL", "take"]]);
  });

  it("needs eight candles in the flat", () => {
    // The first three candles after the impulse still close 2 ATR above the
    // close six candles back, so each restarts the flat: 10 flat candles leave 7, 11 leave 8.
    expect(run({ flatBars: 10 }).result.trades).toEqual([]);
    expect(run({ flatBars: 11 }).result.trades).toHaveLength(1);
  });

  it("drops a flat wider than 1.5 ATR", () => {
    // The width limit is 1.5 x ATR on the impulse candle, about 0.0011 here
    // (the flat's own wide candles already raise it a little).
    // Bodies 0.0014 wide: a flat, broken out of, an order placed.
    const narrow = run({ flatHalf: 0.0007 }).result;
    expect(narrow.skipped.length + narrow.trades.length).toBe(1);
    // Bodies 0.0024 wide: no flat, so the same breakout places nothing.
    const wide = run({ flatHalf: 0.0012 }).result;
    expect([wide.trades, wide.skipped]).toEqual([[], []]);
  });

  it("withdraws the order when the price reaches 1:1 before the retest", () => {
    const { result } = run({ after: [[F + 0.0006, F + 0.0012, F + 0.0005, F + 0.0011]] });
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["order-cancelled"]);
  });

  it("withdraws the order after four hours", () => {
    const hover: Candle[] = Array.from({ length: 17 }, () => [F + 0.0006, F + 0.0008, F + 0.0005, F + 0.0006]);
    const { result } = run({ after: hover });
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["order-expired"]);
  });

  it("places no order outside London and New York hours", () => {
    // Breakout at 07:00 server time, 05:00 UTC.
    const { result } = run({ start: "2024-01-08T16:30" });
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("sells the other way after the buy is stopped out", () => {
    const { result } = run({
      after: [
        [F + 0.0006, F + 0.0006, F + 0.0002, F + 0.0004], // buy limit fills
        [F + 0.0004, F + 0.0004, F - 0.0012, F - 0.001], // stop, and a close below the bottom edge
        [F - 0.0009, F - 0.0002, F - 0.0009, F - 0.0004], // back up to the bottom edge without touching 1:1: the sell limit fills
        [F - 0.0004, F - 0.0003, F - 0.003, F - 0.0029], // down to both takes
      ],
    });
    expect(result.trades.map((item) => [item.direction, item.exitReason])).toEqual([
      ["BUY", "stop"],
      ["SELL", "take"],
    ]);
  });

  it("declares its fixed parameters and trades gold only", () => {
    expect(goldFlatLimitM15.params).toMatchObject({ impulseBars: 6, impulseAtr: 2, minFlatBars: 8, maxFlatBars: 48, flatAtr: 1.5, orderHours: 4 });
    expect(goldFlatLimitM15.symbols).toEqual(["XAUUSD"]);
    expect(goldFlatLimitM15.executionTimeframe).toBe("M15");
  });
});
