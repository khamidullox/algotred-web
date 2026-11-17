import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { atrWilder } from "../src/indicators/atr";
import { rectangleV1 } from "../src/strategies/rectangle-v1";
import { at, bar, flatBars, indexAt, symbolData, testConfig, ZONE } from "./helpers/bars";

const M15 = 15 * 60_000;
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
const START = "2024-05-06T00:00";
const DAYS = 12;

type Quad = readonly [open: number, high: number, low: number, close: number];

function hour(bars: Bar[], iso: string, quads: readonly Quad[]): void {
  const start = indexAt(bars, iso);
  quads.forEach(([open, high, low, close], offset) => {
    const old = bars[start + offset] as Bar;
    bars[start + offset] = bar(old.time, px(open), px(high), px(low), px(close), 0);
  });
}

/** A quiet market: every M15 at P with a 10-pip range, so ATR(14) on H1 is 0.0010. */
function quiet(): Bar[] {
  return flatBars("M15", START, DAYS * 96, P).map((item) =>
    bar(item.time, P, px(P + 0.0005), px(P - 0.0005), P, 0),
  );
}

const IMPULSE = "2024-05-07T09:00";
const hourIso = (offset: number): string =>
  DateTime.fromISO(IMPULSE, { zone: ZONE }).plus({ hours: offset }).toFormat("yyyy-LL-dd'T'HH:mm");

/**
 * The approved pattern, long side: a +40-pip impulse hour, a rectangle of
 * `rectangleBars` hours between +35 and +42 pips, the breakout hour closing at
 * +48, the retest hour dipping to +41 and closing at +46, the entry at the
 * next hour's open (+46) and the take two hours later. `sign` -1 mirrors it.
 */
function pattern(
  bars: Bar[],
  options: {
    sign?: 1 | -1;
    rectangleBars?: number;
    tooTall?: boolean;
    breakdown?: boolean;
    retrace?: boolean;
    noImpulse?: boolean;
  } = {},
): void {
  const sign = options.sign ?? 1;
  const count = options.rectangleBars ?? 9;
  const m = (delta: number): number => P + sign * delta;
  const q = (open: number, up: number, down: number, close: number): Quad =>
    sign === 1 ? [m(open), m(up), m(down), m(close)] : [m(open), m(down), m(up), m(close)];
  const flat = (level: number, up: number, down: number): Quad => q(level, up, down, level);

  if (options.noImpulse) {
    // The same 40 pips, but spread over 13 hours: no six-bar move reaches 2 x ATR.
    for (let k = -12; k <= 0; k++) {
      const level = 0.0003 * (k + 13);
      hour(bars, hourIso(k), [flat(level, level + 0.0005, level - 0.0005), flat(level, level + 0.0005, level - 0.0005), flat(level, level + 0.0005, level - 0.0005), flat(level, level + 0.0005, level - 0.0005)]);
    }
  } else {
    hour(bars, hourIso(0), [
      q(0, 0.001, -0.0005, 0.001),
      q(0.001, 0.002, 0.0008, 0.002),
      q(0.002, 0.003, 0.0018, 0.003),
      q(0.003, 0.0042, 0.0028, 0.004),
    ]);
  }
  for (let i = 1; i <= count; i++) {
    let quad = flat(0.0038, 0.0042, 0.0035);
    if (options.tooTall && i === 3) quad = flat(0.0038, 0.0049, 0.0035);
    if (options.retrace && i === 3) quad = flat(0.0038, 0.0042, 0.0015);
    if (options.breakdown && i === 3) quad = q(0.0038, 0.0039, 0.0028, 0.003);
    hour(bars, hourIso(i), [quad, quad, quad, quad]);
  }
  const b = count + 1;
  hour(bars, hourIso(b), [
    q(0.0038, 0.0045, 0.0037, 0.0044),
    q(0.0044, 0.0047, 0.0043, 0.0046),
    q(0.0046, 0.0049, 0.0045, 0.0048),
    q(0.0048, 0.005, 0.0046, 0.0048),
  ]);
  hour(bars, hourIso(b + 1), [
    q(0.0048, 0.0049, 0.0044, 0.0045),
    q(0.0045, 0.0046, 0.0041, 0.0044),
    q(0.0044, 0.0047, 0.0043, 0.0046),
    q(0.0046, 0.0048, 0.0045, 0.0046),
  ]);
  hour(bars, hourIso(b + 2), [flat(0.0046, 0.0049, 0.0045), flat(0.0047, 0.0049, 0.0045), flat(0.0047, 0.0049, 0.0045), flat(0.0047, 0.0049, 0.0045)]);
  hour(bars, hourIso(b + 3), [flat(0.0047, 0.0049, 0.0045), flat(0.0047, 0.0049, 0.0045), flat(0.0047, 0.0049, 0.0045), flat(0.0047, 0.0049, 0.0045)]);
  hour(bars, hourIso(b + 4), [
    q(0.0047, 0.0065, 0.0046, 0.006),
    flat(0.006, 0.0062, 0.0058),
    flat(0.006, 0.0062, 0.0058),
    flat(0.006, 0.0062, 0.0058),
  ]);
  for (let i = b + 5; i < 24; i++) {
    hour(bars, hourIso(i), [flat(0.006, 0.0062, 0.0058), flat(0.006, 0.0062, 0.0058), flat(0.006, 0.0062, 0.0058), flat(0.006, 0.0062, 0.0058)]);
  }
}

function run(bars: Bar[]): { result: BacktestResult; atrH1: number[] } {
  const data = symbolData("EURUSD", bars);
  return {
    result: runBacktest({
      data: [data],
      strategy: rectangleV1,
      span: { start: at(START), end: at(START) + DAYS * 96 * M15 },
      config: testConfig(),
    }),
    atrH1: atrWilder(data.bars.H1, 14),
  };
}

describe("RectangleV1 on a hand-made pattern", () => {
  const bars = quiet();
  pattern(bars);
  const { result, atrH1 } = run(bars);
  const trade = result.trades[0] as Trade;
  const data = symbolData("EURUSD", bars);
  const atrBreakout = atrH1[indexAt(data.bars.H1, hourIso(10))] as number;

  it("takes exactly one long trade", () => {
    expect(result.trades.map((item) => item.direction)).toEqual(["BUY"]);
    expect(result.skipped).toEqual([]);
  });

  it("enters at the open of the hour after the retest", () => {
    expect(trade.signalTime).toBe(at(hourIso(12)));
    expect(trade.entryTime).toBe(at(hourIso(12)));
    expect(trade.entryPrice).toBe(1.2046);
  });

  it("names the impulse, the rectangle, the breakout and the retest", () => {
    expect(trade.reason).toContain("импульс 2024-05-07 09:00 +0.00400");
    expect(trade.reason).toContain("прямоугольник 1.20350–1.20420 за 9 св.");
    expect(trade.reason).toContain("пробой 2024-05-07 19:00 close 1.20480");
    expect(trade.reason).toContain("ретест 2024-05-07 20:00 low 1.20410");
  });

  it("puts the stop under the retest low by 0.1 x ATR of the breakout bar and the take at 2R", () => {
    const stop = px(1.2041 - 0.1 * atrBreakout);
    expect(trade.stopLoss).toBe(stop);
    expect(trade.takeProfit).toBe(px(1.2046 + 2 * px(1.2046 - stop)));
    expect(trade.exitReason).toBe("take");
    expect(trade.exitTime).toBe(at(hourIso(14)));
    expect(trade.rMultiple).toBeCloseTo(2, 6);
  });
});

describe("RectangleV1 rules", () => {
  it("mirrors for a short", () => {
    const bars = quiet();
    pattern(bars, { sign: -1 });
    const { result } = run(bars);
    expect(result.trades.map((item) => item.direction)).toEqual(["SELL"]);
    expect(result.trades[0]?.entryPrice).toBe(1.1954);
    expect(result.trades[0]?.exitReason).toBe("take");
    expect(result.trades[0]?.reason).toContain("ретест 2024-05-07 20:00 high 1.19590");
  });

  it("needs an impulse before the rectangle", () => {
    const bars = quiet();
    pattern(bars, { noImpulse: true });
    expect(run(bars).result.trades).toEqual([]);
  });

  it("ignores a rectangle shorter than eight bars", () => {
    const bars = quiet();
    pattern(bars, { rectangleBars: 5 });
    expect(run(bars).result.trades).toEqual([]);
  });

  it("drops a rectangle taller than one ATR", () => {
    const bars = quiet();
    pattern(bars, { tooTall: true });
    expect(run(bars).result.trades).toEqual([]);
  });

  it("drops a rectangle that falls below the middle of the impulse", () => {
    const bars = quiet();
    pattern(bars, { retrace: true });
    expect(run(bars).result.trades).toEqual([]);
  });

  it("drops a rectangle broken against the impulse", () => {
    const bars = quiet();
    pattern(bars, { breakdown: true });
    expect(run(bars).result.trades).toEqual([]);
  });

  it("declares its fixed parameters", () => {
    expect(rectangleV1.params).toMatchObject({
      impulseBars: 6,
      impulseAtr: 2,
      maxHeightAtr: 1,
      minBars: 8,
      maxBars: 30,
      breakoutBufferAtr: 0.1,
      retestBars: 6,
      stopBufferAtr: 0.1,
      maxStopAtr: 1.5,
      takeProfitR: 2,
    });
    expect(rectangleV1.executionTimeframe).toBe("M15");
  });
});
