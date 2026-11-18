import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { blockStart, seriesBreakH4 } from "../src/strategies/series-break-h4";
import { at, bar, symbolData, testConfig, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
const T0 = at("2024-01-08T00:00"); // a Monday, server time; no DST change in the test

/** An H4 candle as offsets from P. */
type Candle = readonly [open: number, high: number, low: number, close: number];

const QUIET: Candle = [0, 0.001, -0.001, 0];

interface Plan {
  readonly sign?: 1 | -1;
  /** Number of white candles after the reset candle. */
  readonly whites?: number;
  /** Step of each white candle's close. */
  readonly step?: number;
  /** Indices (1-based, among the whites) that are black instead. */
  readonly blacks?: readonly number[];
  /** Extra height of the signal candle's high. */
  readonly spike?: number;
}

/**
 * 20 quiet candles (ATR 0.0020), a reset candle whose low breaks the quiet
 * lows, `whites` white candles with rising lows, the signal candle that breaks
 * the last low, two falling candles to the take, then quiet candles.
 */
function candles(plan: Plan = {}): Candle[] {
  const whites = plan.whites ?? 7;
  const step = plan.step ?? 0.0015;
  const list: Candle[] = [];
  for (let i = 0; i < 20; i++) list.push(QUIET);
  list.push([0, 0.001, -0.0015, 0]);
  let close = 0;
  for (let i = 1; i <= whites; i++) {
    const open = close;
    if (plan.blacks?.includes(i)) {
      // Gap up, then close a little lower: black, but the low still rises.
      const o = open + step + 0.0005;
      close = o - 0.0005;
      list.push([o, o + 0.0003, open - 0.0003 + 0.0001, close]);
    } else {
      close = open + step;
      list.push([open, close + 0.0003, open - 0.0003, close]);
    }
  }
  const lastLow = (list.at(-1) as Candle)[2];
  const signal: Candle = [close, close + 0.0002 + (plan.spike ?? 0), lastLow - 0.001, close - 0.0025];
  list.push(signal);
  list.push([signal[3], signal[3] + 0.0002, signal[3] - 0.004, signal[3] - 0.004]);
  list.push([signal[3] - 0.004, signal[3] - 0.0038, signal[3] - 0.008, signal[3] - 0.008]);
  for (let i = 0; i < 20; i++) list.push(QUIET.map((v) => v + (signal[3] - 0.008)) as unknown as Candle);
  return list;
}

/** Four H1 bars per candle that add up to it. */
function hourly(list: readonly Candle[], sign: 1 | -1 = 1, drop: (hour: number) => boolean = () => false): Bar[] {
  const bars: Bar[] = [];
  const m = (v: number): number => px(P + sign * v);
  list.forEach(([o, h, l, c], k) => {
    const hours: Candle[] = [
      [o, h, Math.min(o, c), o],
      [o, Math.max(o, c), l, o],
      [o, Math.max(o, c), Math.min(o, c), c],
      [c, c, c, c],
    ];
    hours.forEach(([ho, hh, hl, hc], j) => {
      const index = k * 4 + j;
      if (drop(index)) return;
      const high = sign === 1 ? hh : hl;
      const low = sign === 1 ? hl : hh;
      bars.push(bar(T0 + index * HOUR, m(ho), m(high), m(low), m(hc)));
    });
  });
  return bars;
}

function run(bars: Bar[]): BacktestResult {
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: seriesBreakH4,
    span: { start: T0, end: (bars.at(-1) as Bar).time + HOUR },
    config: testConfig(),
  });
}

/** Index of the signal candle in the default plan. */
const SIGNAL = 20 + 1 + 7;

describe("SeriesBreakH4 on hand-made H4 candles", () => {
  const result = run(hourly(candles()));
  const trade = result.trades[0] as Trade;

  it("sells at the hour after the candle that breaks the series low", () => {
    expect(result.trades.map((item) => item.direction)).toEqual(["SELL"]);
    expect(result.skipped).toEqual([]);
    expect(trade.entryTime).toBe(T0 + (SIGNAL + 1) * 4 * HOUR);
    expect(trade.entryPrice).toBe(px(P + 0.0105 - 0.0025));
  });

  it("puts the stop above the series high and the take at 2R", () => {
    // Highest high: the last white candle, 0.0105 + 0.0003.
    expect(trade.stopLoss).toBeGreaterThan(P + 0.0108);
    expect(trade.stopLoss).toBeLessThan(P + 0.0108 + 0.0005);
    expect(trade.takeProfit).toBe(px(trade.entryPrice - 2 * trade.stopDistance));
    expect(trade.exitReason).toBe("take");
  });

  it("describes the series", () => {
    expect(trade.reason).toContain("серия вверх 8 св. H4");
    expect(trade.reason).toContain("белых 7");
  });
});

describe("SeriesBreakH4 rules", () => {
  it("mirrors for a buy after a falling series", () => {
    const result = run(hourly(candles(), -1));
    expect(result.trades.map((item) => [item.direction, item.exitReason])).toEqual([["BUY", "take"]]);
  });

  it("needs at least six candles in the series", () => {
    // Reset candle plus four whites: five.
    expect(run(hourly(candles({ whites: 4 }))).trades).toEqual([]);
    // Reset candle plus five whites: six.
    expect(run(hourly(candles({ whites: 5 }))).trades.map((item) => item.direction)).toEqual(["SELL"]);
  });

  it("needs two thirds of the series to be white", () => {
    // Three of seven whites turned black: 4 of 8 white.
    expect(run(hourly(candles({ blacks: [2, 4, 6] }))).trades).toEqual([]);
  });

  it("needs a move of at least 2 x ATR", () => {
    // Seven steps of 0.0004: 0.0028, under 2 x 0.0020.
    expect(run(hourly(candles({ step: 0.0004 }))).trades).toEqual([]);
  });

  it("skips a stop more than 3 x ATR away", () => {
    const result = run(hourly(candles({ spike: 0.008 })));
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["stop-too-far"]);
  });

  it("drops the signal when the next hour does not open at once", () => {
    const next = (SIGNAL + 1) * 4;
    const result = run(hourly(candles(), 1, (hour) => hour === next));
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["gap-after-signal"]);
  });

  it("does not count a block with fewer than three hours as a candle", () => {
    // Six candles in the series, but the third white loses two hours: five.
    const third = (20 + 1 + 3) * 4;
    const result = run(hourly(candles({ whites: 5 }), 1, (hour) => hour === third + 1 || hour === third + 2));
    expect(result.trades).toEqual([]);
  });

  it("starts blocks at server-time multiples of four hours", () => {
    expect(blockStart(at("2024-01-08T13:30"), ZONE)).toBe(at("2024-01-08T12:00"));
    expect(blockStart(at("2024-01-08T23:00"), ZONE)).toBe(at("2024-01-08T20:00"));
  });

  it("declares its fixed parameters and its eleven instruments", () => {
    expect(seriesBreakH4.params).toMatchObject({
      blockHours: 4,
      minHoursInBlock: 3,
      minSeriesBars: 6,
      minMoveAtr: 2,
      atrPeriod: 14,
      stopBufferAtr: 0.1,
      maxStopAtr: 3,
      takeProfitR: 2,
    });
    expect(seriesBreakH4.symbols).toHaveLength(11);
  });
});
