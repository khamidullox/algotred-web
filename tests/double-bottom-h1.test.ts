import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { eventsBetween, type NewsEvent } from "../src/data/calendar";
import type { Bar } from "../src/data/types";
import { runBacktest } from "../src/engine/backtest";
import { roundPrice, symbolSpec } from "../src/engine/symbols";
import type { BacktestResult, Trade } from "../src/engine/types";
import { atrWilder } from "../src/indicators/atr";
import { FX_AND_GOLD } from "../src/strategies/baskets";
import { DOUBLE_BOTTOM, doubleBottomH1, orderWorksAt } from "../src/strategies/double-bottom-h1";
import { at, bar, flatBars, indexAt, symbolData, testConfig, ZONE } from "./helpers/bars";

const M15 = 15 * 60_000;
const P = 1.2;
const PIP = 0.0001;
const SPEC = symbolSpec(testConfig(), "EURUSD");
const START = "2024-05-06T00:00";
const DAYS = 5;
/** Hour 0 of the figure, server time. The order is placed at 21:00 and reached at 22:00: New York 14:00 and 15:00. */
const BASE = "2024-05-07T00:00";

/** An H1 candle in pips from P, for a double bottom; `sign` -1 mirrors it into a double top. */
type Ohlc = readonly [open: number, high: number, low: number, close: number];

/**
 * The figure: a fall of 60 pips in six hours to the first bottom (hour 6,
 * low -60), a bounce to -10 (hour 10), a second bottom at -58 (hour 15) and
 * five higher hours after it, the last of which (hour 20) confirms it.
 */
const FIGURE: readonly Ohlc[] = [
  [0, 5, -5, 0],
  [0, 2, -12, -10],
  [-10, -8, -22, -20],
  [-20, -18, -32, -30],
  [-30, -28, -42, -40],
  [-40, -38, -52, -50],
  [-50, -48, -60, -52],
  [-52, -40, -54, -42],
  [-42, -30, -44, -32],
  [-32, -20, -34, -22],
  [-22, -10, -24, -14],
  [-14, -12, -26, -24],
  [-24, -22, -36, -34],
  [-34, -32, -46, -44],
  [-44, -42, -56, -48],
  [-48, -46, -58, -50],
  [-50, -44, -52, -46],
  [-46, -40, -48, -42],
  [-42, -36, -44, -38],
  [-38, -32, -40, -34],
  [-34, -28, -36, -30],
];

/** Hours 21 on: up through the order level at hour 22, then to 1:1 (hour 26) and 1:2 (hour 30). */
const RISE: readonly Ohlc[] = [
  [-30, -20, -32, -22],
  [-22, -5, -24, -7],
  [-7, 8, -9, 6],
  [6, 22, 4, 20],
  [20, 36, 18, 34],
  [34, 50, 32, 48],
  [48, 64, 46, 62],
  [62, 78, 60, 76],
  [76, 92, 74, 90],
  [90, 106, 88, 104],
];

const HOVER: Ohlc = [-30, -28, -32, -30];
const REACH: Ohlc = [-30, -5, -32, -7];

/** A quiet market: every M15 at P with a 10-pip range, so ATR(14) on H1 is 10 pips and nothing is a swing point. */
function quiet(): Bar[] {
  return flatBars("M15", START, DAYS * 96, P).map((item) => bar(item.time, P, px(P + 5 * PIP), px(P - 5 * PIP), P, 0));
}

function px(value: number): number {
  return roundPrice(SPEC, value);
}

interface Scenario {
  readonly bars: Bar[];
  /** Server time of an hour of the figure. */
  readonly iso: (hour: number) => string;
  readonly sign: 1 | -1;
}

/** Writes hours into a quiet market from `base` on; the last close is held flat to the end. */
function scenario(hours: readonly Ohlc[], options: { sign?: 1 | -1; base?: string } = {}): Scenario {
  const sign = options.sign ?? 1;
  const bars = quiet();
  const base = DateTime.fromISO(options.base ?? BASE, { zone: ZONE });
  const iso = (hour: number): string => base.plus({ hours: hour }).toFormat("yyyy-LL-dd'T'HH:mm");
  const m = (pips: number): number => px(P + sign * pips * PIP);
  const put = (index: number, [open, high, low, close]: Ohlc): void => {
    const old = bars[index] as Bar;
    bars[index] = sign === 1 ? bar(old.time, m(open), m(high), m(low), m(close), 0) : bar(old.time, m(open), m(low), m(high), m(close), 0);
  };
  hours.forEach(([open, high, low, close], offset) => {
    // Four M15 bars that add up to the H1 candle; the high comes in the first.
    const first = indexAt(bars, iso(offset));
    put(first, [open, high, Math.min(open, close), open]);
    put(first + 1, [open, Math.max(open, close), low, open]);
    put(first + 2, [open, Math.max(open, close), Math.min(open, close), close]);
    put(first + 3, [close, close, close, close]);
  });
  const level = (hours.at(-1) as Ohlc)[3];
  for (let i = indexAt(bars, iso(hours.length)); i < bars.length; i++) put(i, [level, level, level, level]);
  return { bars, iso, sign };
}

function event(iso: string, overrides: Partial<NewsEvent> = {}): NewsEvent {
  return {
    time: at(iso),
    currency: "USD",
    country: "US",
    code: "nonfarm-payrolls",
    name: "Nonfarm Payrolls",
    importance: "HIGH",
    timeMode: "DATETIME",
    unit: 0,
    multiplier: 0,
    actual: null,
    forecast: null,
    previous: null,
    revisedPrevious: null,
    ...overrides,
  };
}

/** A release far from every figure: the strategy refuses to run on an empty calendar. */
const FAR = event("2024-05-06T03:00");

function run(bars: Bar[], options: { news?: readonly NewsEvent[]; start?: string } = {}): BacktestResult {
  const news = [...(options.news ?? []), FAR].sort((a, b) => a.time - b.time);
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: doubleBottomH1,
    span: { start: at(options.start ?? START), end: at(START) + DAYS * 96 * M15 },
    config: testConfig(),
    news,
  });
}

function atrAt(bars: Bar[], iso: string): number {
  const h1 = symbolData("EURUSD", bars).bars.H1;
  return atrWilder(h1, 14)[indexAt(h1, iso)] as number;
}

const skips = (result: BacktestResult): [string, string][] => result.skipped.map((item) => [item.reason, item.detail]);
const hours = (...parts: (readonly Ohlc[])[]): Ohlc[] => parts.flat();
const repeat = (candle: Ohlc, count: number): Ohlc[] => Array.from({ length: count }, () => candle);
/** FIGURE with some hours replaced. */
const figureWith = (changes: Record<number, Ohlc>): Ohlc[] => FIGURE.map((candle, hour) => changes[hour] ?? candle);

describe("DoubleBottomH1 on a hand-made double bottom", () => {
  const { bars, iso } = scenario(hours(FIGURE, RISE));
  const result = run(bars);
  const trade = result.trades[0] as Trade;
  const atr = atrAt(bars, iso(20));
  const entry = px(P - 10 * PIP + 0.1 * atr);
  const stop = px(P - 60 * PIP - 0.1 * atr);
  const risk = px(entry - stop);

  it("is built on a scenario where every threshold has room", () => {
    // About 11 pips: the bottoms (2 pips apart) pass 0.5 ATR, the height (50) and the impulse (60) pass 2 ATR.
    expect(atr).toBeGreaterThan(0.00105);
    expect(atr).toBeLessThan(0.0012);
  });

  it("takes exactly one long trade", () => {
    expect(result.trades.map((item) => item.direction)).toEqual(["BUY"]);
    expect(result.skipped).toEqual([]);
  });

  it("places the order at the close of the hour that confirms the second bottom", () => {
    expect(trade.signalTime).toBe(at(iso(21)));
  });

  it("buys with a stop order 0.1 x ATR above the high between the bottoms", () => {
    expect(trade.entryPrice).toBe(entry);
    expect(trade.entryTime).toBe(at(iso(22)));
  });

  it("puts the stop 0.1 x ATR under the lower bottom", () => {
    expect(trade.stopLoss).toBe(stop);
    expect(trade.stopDistance).toBeCloseTo(risk, 9);
  });

  it("closes half at 1:1, moves the rest to breakeven and takes it at 1:2", () => {
    expect(trade.partialPrice).toBe(px(entry + risk));
    expect(trade.partialTime).toBe(at(iso(26)));
    expect(trade.partialLots).toBe(Math.floor((trade.lots * 0.5) / 0.01 + 1e-9) / 100);
    expect(trade.breakevenTime).toBe(at(iso(26)) + M15);
    expect(trade.takeProfit).toBe(px(entry + 2 * risk));
    expect([trade.exitReason, trade.exitPrice, trade.exitTime]).toEqual(["take", px(entry + 2 * risk), at(iso(30))]);
  });

  it("describes the figure for the chart", () => {
    expect(trade.reason).toContain(`L ${entry.toFixed(5)} (high 2024-05-07 10:00)`);
    expect(trade.reason).toContain("середина 1.19900");
    expect(trade.reason).toContain("дно 2024-05-07 06:00 1.19400; дно 2024-05-07 15:00 1.19420");
    expect(trade.reason).toContain("ордер 2024-05-07 21:00");
    expect(trade.reason).toContain(`стоп ${stop.toFixed(5)}`);
  });

  it("finds the first bottom in the history before the run starts", () => {
    // The run starts at hour 12: the first bottom was confirmed at the close of hour 11.
    const late = run(bars, { start: iso(12) });
    expect(late.trades.map((item) => item.entryPrice)).toEqual([entry]);
  });
});

describe("DoubleBottomH1 rules", () => {
  it("mirrors for a double top: a sell stop under the low between the tops", () => {
    const { bars, iso } = scenario(hours(FIGURE, RISE), { sign: -1 });
    const result = run(bars);
    const atr = atrAt(bars, iso(20));
    const entry = px(P + 10 * PIP - 0.1 * atr);
    const stop = px(P + 60 * PIP + 0.1 * atr);
    const [trade] = result.trades as [Trade];
    expect(result.trades).toHaveLength(1);
    expect([trade.direction, trade.entryPrice, trade.stopLoss]).toEqual(["SELL", entry, stop]);
    expect([trade.exitReason, trade.exitPrice]).toEqual(["take", px(entry - 2 * (stop - entry))]);
    expect(trade.reason).toContain("вершина 2024-05-07 06:00 1.20600; вершина 2024-05-07 15:00 1.20580");
  });

  it("places no order when the price reached the order level before the second bottom was confirmed", () => {
    // Hour 20, the fifth after the bottom, trades through the level: the figure is spent.
    const { bars } = scenario(hours(figureWith({ 20: [-34, -5, -36, -30] }), RISE));
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("needs the two bottoms within 0.5 x ATR of each other", () => {
    // The second bottom at -50: 10 pips above the first, between 0.5 and 1 ATR.
    const changed = figureWith({ 14: [-44, -42, -48, -46], 15: [-46, -44, -50, -46], 16: [-46, -44, -49, -46] });
    const { bars, iso } = scenario(hours(changed, RISE));
    const atr = atrAt(bars, iso(20));
    expect(10 * PIP).toBeGreaterThan(0.5 * atr);
    expect(10 * PIP).toBeLessThan(atr);
    expect(run(bars).trades).toEqual([]);
    // The same 10 pips the other way: the second bottom at -70, under the first.
    const lower = scenario(hours(figureWith({ 14: [-44, -42, -62, -60], 15: [-60, -58, -70, -62] }), RISE));
    expect(10 * PIP).toBeGreaterThan(0.5 * atrAt(lower.bars, lower.iso(20)));
    expect(run(lower.bars).trades).toEqual([]);
  });

  it("needs a figure at least 2 x ATR high", () => {
    // The bounce stops at -41: the figure is 19 pips high, between 1.5 and 2 ATR.
    // The hours between the bottoms keep a wide range, so the ATR stays where it was.
    const changed = figureWith({
      7: [-52, -46, -56, -48],
      8: [-48, -41, -56, -50],
      9: [-50, -45, -56, -48],
      10: [-48, -45, -56, -50],
      11: [-50, -45, -56, -48],
      12: [-48, -45, -56, -50],
      13: [-50, -45, -56, -48],
      14: [-48, -45, -56, -50],
      15: [-50, -46, -58, -52],
      16: [-52, -46, -56, -48],
      17: [-48, -46, -56, -50],
      18: [-50, -46, -56, -48],
      19: [-48, -46, -56, -50],
      20: [-50, -46, -56, -48],
    });
    const { bars, iso } = scenario(hours(changed, [[-48, -30, -50, -32]], RISE.slice(1)));
    const atr = atrAt(bars, iso(20));
    expect(19 * PIP).toBeGreaterThan(1.5 * atr);
    expect(19 * PIP).toBeLessThan(2 * atr);
    expect(run(bars).trades).toEqual([]);
  });

  it("needs a fall of 2 x ATR over the six hours before the first bottom", () => {
    // Six hours before the bottom the close is already at -40: 20 pips above it, between 1.5 and 2 ATR.
    const { bars, iso } = scenario(hours(figureWith({ 0: [0, 5, -42, -40] }), RISE));
    const atr = atrAt(bars, iso(20));
    expect(20 * PIP).toBeGreaterThan(1.5 * atr);
    expect(20 * PIP).toBeLessThan(2 * atr);
    expect(run(bars).trades).toEqual([]);
  });

  it("keeps the order for 24 closed hours and withdraws it then", () => {
    // Hours 21 to 44 are the 24 hours of the order: reached in hour 44 it fills, in hour 45 it is gone.
    const inTime = run(scenario(hours(FIGURE, repeat(HOVER, 23), [REACH])).bars);
    expect(inTime.trades.map((item) => item.entryTime)).toEqual([at("2024-05-08T20:00")]);
    const late = run(scenario(hours(FIGURE, repeat(HOVER, 24), [REACH])).bars);
    expect(late.trades).toEqual([]);
    expect(skips(late)).toEqual([["order-cancelled", "не исполнен за 24 свечи H1"]]);
    // The record keeps the order for the chart: its price, when it went and the figure.
    const [skip] = late.skipped;
    expect(skip?.signalTime).toBe(at("2024-05-07T21:00"));
    expect(skip?.order?.kind).toBe("stop");
    expect(skip?.order?.endTime).toBe(at("2024-05-08T21:00"));
    expect(skip?.order?.reason).toContain(`L ${skip?.order?.price.toFixed(5)} (high 2024-05-07 10:00)`);
  });

  it("withdraws the order when the price comes down to the stop", () => {
    // Hour 21 falls through both bottoms, hour 23 then reaches the order level.
    const { bars } = scenario(hours(FIGURE, [[-30, -28, -64, -40], [-40, -30, -42, -32], REACH]));
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(skips(result).map(([reason]) => reason)).toEqual(["order-cancelled"]);
  });

  it("does not trade when the level is reached outside London and New York hours", () => {
    // Six hours later: the order level is reached at 04:00 server time, in the Asian session.
    const { bars } = scenario(hours(FIGURE, RISE), { base: "2024-05-07T06:00" });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(skips(result)).toEqual([["order-cancelled", "цена дошла до ордера, когда он не работал"]]);
  });

  it("does not trade when the level is reached within 30 minutes of an important release", () => {
    const { bars, iso } = scenario(hours(FIGURE, RISE));
    const near = iso(22).replace("22:00", "22:20");
    const blocked = run(bars, { news: [event(near)] });
    expect(blocked.trades).toEqual([]);
    expect(skips(blocked)).toEqual([["order-cancelled", "цена дошла до ордера, когда он не работал"]]);
    // The euro side of EURUSD counts too.
    expect(run(bars, { news: [event(near, { currency: "EUR" })] }).trades).toEqual([]);
    // Another currency, a release of medium importance or one without an exact time do not.
    expect(run(bars, { news: [event(near, { currency: "GBP" })] }).trades).toHaveLength(1);
    expect(run(bars, { news: [event(near, { importance: "MODERATE" })] }).trades).toHaveLength(1);
    expect(run(bars, { news: [event(near, { timeMode: "TENTATIVE" })] }).trades).toHaveLength(1);
  });

  it("skips a figure confirmed while an order is waiting", () => {
    // A third bottom at -57 (hour 23) makes a figure with the second one; the
    // first order, at -8.7, still waits. Hour 29 goes to -20: under the first
    // order, above where an order of the new figure would stand.
    const third: Ohlc[] = [
      [-30, -28, -40, -38],
      [-38, -36, -50, -48],
      [-48, -46, -57, -50],
      [-50, -44, -52, -46],
      [-46, -40, -48, -42],
      [-42, -36, -44, -38],
      [-38, -32, -40, -34],
      [-34, -28, -36, -30],
      [-30, -20, -32, -22],
    ];
    const { bars } = scenario(hours(FIGURE, third), { base: "2024-05-07T06:00" });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(skips(result)).toEqual([["order-cancelled", "не исполнен за 24 свечи H1"]]);
  });

  it("skips a figure confirmed while a position is open", () => {
    // After the fill at hour 22 the price comes back to a third bottom at -57,
    // above the stop; the figure it makes with the second bottom is not traded.
    const back: Ohlc[] = [
      [-30, -20, -32, -22],
      [-22, -5, -24, -7],
      [-7, -5, -20, -18],
      [-18, -16, -32, -30],
      [-30, -28, -44, -42],
      [-42, -40, -57, -50],
      [-50, -44, -52, -46],
      [-46, -40, -48, -42],
      [-42, -36, -44, -38],
      [-38, -32, -40, -34],
      [-34, -28, -36, -30],
    ];
    const { bars } = scenario(hours(FIGURE, back));
    const result = run(bars);
    expect(result.trades.map((item) => item.exitReason)).toEqual(["end-of-data"]);
    expect(result.skipped).toEqual([]);
  });

  it("refuses to run without a calendar", () => {
    const { bars } = scenario(hours(FIGURE, RISE));
    const blind = (): BacktestResult =>
      runBacktest({ data: [symbolData("EURUSD", bars)], strategy: doubleBottomH1, span: { start: at(START), end: at(START) + DAYS * 96 * M15 }, config: testConfig() });
    expect(blind).toThrow(/календар/);
  });

  it("declares its fixed parameters and the eight instruments", () => {
    expect(DOUBLE_BOTTOM).toEqual({
      wingsH1: 5,
      atrPeriod: 14,
      levelToleranceAtr: 0.5,
      minHeightAtr: 2,
      impulseBars: 6,
      impulseAtr: 2,
      entryBufferAtr: 0.1,
      stopBufferAtr: 0.1,
      partialAtR: 1,
      partialFraction: 0.5,
      takeProfitR: 2,
      orderLifeH1: 24,
      newsMinutes: 30,
    });
    expect(doubleBottomH1.symbols).toEqual(FX_AND_GOLD);
    expect(doubleBottomH1.executionTimeframe).toBe("M15");
  });
});

describe("orderWorksAt", () => {
  const ctxWith = (events: readonly NewsEvent[]) => ({
    news: (from: number, to: number, filter?: Parameters<typeof eventsBetween>[3]) => eventsBetween(events, from, to, filter),
  });
  const works = (iso: string, events: readonly NewsEvent[] = []): boolean => orderWorksAt(ctxWith(events), ["EUR", "USD"], at(iso));

  it("needs the whole M15 bar inside 08:00 London to 17:00 New York", () => {
    // In May London 08:00 is 10:00 server time and New York 17:00 is midnight.
    expect(works("2024-05-08T09:45")).toBe(false);
    expect(works("2024-05-08T10:00")).toBe(true);
    expect(works("2024-05-08T23:45")).toBe(true);
    expect(works("2024-05-09T00:00")).toBe(false);
  });

  it("is closed in every bar that overlaps 30 minutes before or after a release", () => {
    const onGrid = [event("2024-05-08T15:30")];
    expect(["14:45", "15:00", "15:15", "15:30", "15:45", "16:00"].map((time) => works(`2024-05-08T${time}`, onGrid))).toEqual([
      true,
      false,
      false,
      false,
      false,
      true,
    ]);
    // A release at 15:35 closes 15:05 to 16:05: the 16:00 bar too.
    const offGrid = [event("2024-05-08T15:35")];
    expect(["14:45", "15:00", "16:00", "16:15"].map((time) => works(`2024-05-08T${time}`, offGrid))).toEqual([true, false, false, true]);
  });
});
