import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { ClosedBarsView } from "../src/engine/closed-bars";
import { atrWilder } from "../src/indicators/atr";
import { failedBreakoutV1, levelBefore } from "../src/strategies/failed-breakout-v1";
import { at, bar, flatBars, indexAt, symbolData, testConfig, ZONE } from "./helpers/bars";

const M15 = 15 * 60_000;
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
const START = "2024-05-06T00:00";
const DAYS = 4;
/** Server time of hour 0 of the pattern: London 07:00, so the entry hour is in session. */
const BASE = "2024-05-07T09:00";

/** Prices as offsets from P for a breakout up; `sign` -1 mirrors them. */
type Ohlc = readonly [open: number, high: number, low: number, close: number];

const LEVEL_BAR: Ohlc = [0, 0.002, -0.0005, 0];
const BREAKOUT: Ohlc = [0, 0.0026, -0.0005, 0.0024];
const HOLD: Ohlc = [0.0024, 0.0028, 0.0021, 0.0023];
const FAILURE: Ohlc = [0.0023, 0.0025, 0.0012, 0.0014];
/** The hour after the failure: from the entry at +14 pips down to the take. */
const TAKE_HOUR: readonly Ohlc[] = [
  [0.0014, 0.0015, 0.0008, 0.0008],
  [0.0008, 0.0009, 0.0002, 0.0002],
  [0.0002, 0.0003, -0.001, -0.001],
  [-0.001, -0.0009, -0.0021, -0.002],
];

/** A quiet market: every M15 at P with a 10-pip range, so ATR(14) on H1 is 0.0010. */
function quiet(): Bar[] {
  return flatBars("M15", START, DAYS * 96, P).map((item) =>
    bar(item.time, P, px(P + 0.0005), px(P - 0.0005), P, 0),
  );
}

interface PatternOptions {
  readonly sign?: 1 | -1;
  readonly base?: string;
  /** Hour of the bar that sets the level L = +20 pips; the breakout is hour 5. */
  readonly levelHour?: number;
  readonly breakout?: Ohlc;
  /** Hours 6, 7, ... between the breakout and the failure. */
  readonly hold?: readonly Ohlc[];
  readonly failure?: Ohlc;
  /** "take": the next hour falls to the take; a number: flat at that offset from then on. */
  readonly after?: "take" | number;
}

/**
 * The approved pattern, short side: L = +20 pips set at hour 0, four quiet
 * hours, the breakout hour 5 closing at +24, one hour holding above L, the
 * failure hour closing at +14, the entry at the next M15 open and the take
 * within the next hour. Returns the server time of an hour of the pattern.
 */
function pattern(bars: Bar[], options: PatternOptions = {}): (hour: number) => string {
  const sign = options.sign ?? 1;
  const base = DateTime.fromISO(options.base ?? BASE, { zone: ZONE });
  const iso = (hour: number): string => base.plus({ hours: hour }).toFormat("yyyy-LL-dd'T'HH:mm");
  const m = (delta: number): number => px(P + sign * delta);
  const put = (index: number, [open, high, low, close]: Ohlc): void => {
    const old = bars[index] as Bar;
    bars[index] =
      sign === 1
        ? bar(old.time, m(open), m(high), m(low), m(close), 0)
        : bar(old.time, m(open), m(low), m(high), m(close), 0);
  };
  /** Four M15 bars that add up to the given H1 bar. */
  const hour = (offset: number, [open, high, low, close]: Ohlc): void => {
    const first = indexAt(bars, iso(offset));
    put(first, [open, high, Math.min(open, close), open]);
    put(first + 1, [open, Math.max(open, close), low, open]);
    put(first + 2, [open, Math.max(open, close), Math.min(open, close), close]);
    put(first + 3, [close, close, close, close]);
  };

  hour(options.levelHour ?? 0, LEVEL_BAR);
  hour(5, options.breakout ?? BREAKOUT);
  const hold = options.hold ?? [HOLD];
  hold.forEach((item, k) => hour(6 + k, item));
  const failure = 6 + hold.length;
  hour(failure, options.failure ?? FAILURE);
  const after = options.after ?? "take";
  let flatFrom = failure + 1;
  if (after === "take") {
    const first = indexAt(bars, iso(failure + 1));
    TAKE_HOUR.forEach((quad, k) => put(first + k, quad));
    flatFrom = failure + 2;
  }
  const level = after === "take" ? -0.002 : after;
  for (let i = indexAt(bars, iso(flatFrom)); i < bars.length; i++) {
    put(i, [level, level + 0.0005, level - 0.0005, level]);
  }
  return iso;
}

function run(bars: Bar[]): BacktestResult {
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: failedBreakoutV1,
    span: { start: at(START), end: at(START) + DAYS * 96 * M15 },
    config: testConfig(),
  });
}

function atrAt(bars: Bar[], iso: string): number {
  const h1 = symbolData("EURUSD", bars).bars.H1;
  return atrWilder(h1, 14)[indexAt(h1, iso)] as number;
}

describe("FailedBreakoutV1 on a hand-made pattern", () => {
  const bars = quiet();
  const iso = pattern(bars);
  const result = run(bars);
  const trade = result.trades[0] as Trade;
  const atrBreakout = atrAt(bars, iso(5));

  it("takes exactly one short trade against the breakout", () => {
    expect(result.trades.map((item) => item.direction)).toEqual(["SELL"]);
    expect(result.skipped).toEqual([]);
  });

  it("enters at the open of the M15 right after the failure hour", () => {
    expect(trade.signalTime).toBe(at(iso(8)));
    expect(trade.entryTime).toBe(at(iso(8)));
    expect(trade.entryPrice).toBe(1.2014);
  });

  it("names the level, the breakout, the failure and the extreme", () => {
    expect(trade.reason).toContain("L 1.20200 (high 2024-05-07 09:00)");
    expect(trade.reason).toContain("пробой вверх 2024-05-07 14:00 close 1.20240");
    expect(trade.reason).toContain("провал 2024-05-07 16:00 close 1.20140");
    expect(trade.reason).toContain("max 1.20280");
  });

  it("puts the stop 0.1 x ATR of the breakout bar above the highest high since the breakout, take at 2R", () => {
    const stop = px(1.2028 + 0.1 * atrBreakout);
    expect(trade.stopLoss).toBe(stop);
    expect(trade.takeProfit).toBe(px(1.2014 - 2 * px(stop - 1.2014)));
    expect(trade.exitReason).toBe("take");
    expect(trade.exitTime).toBe(at("2024-05-07T17:45"));
    expect(trade.rMultiple).toBeCloseTo(2, 6);
  });
});

describe("FailedBreakoutV1 rules", () => {
  it("mirrors for a long against a breakout down", () => {
    const bars = quiet();
    pattern(bars, { sign: -1 });
    const result = run(bars);
    expect(result.trades.map((item) => item.direction)).toEqual(["BUY"]);
    const trade = result.trades[0] as Trade;
    expect(trade.entryPrice).toBe(1.1986);
    expect(trade.exitReason).toBe("take");
    expect(trade.reason).toContain("L 1.19800 (low 2024-05-07 09:00)");
    expect(trade.reason).toContain("пробой вниз 2024-05-07 14:00 close 1.19760");
    expect(trade.reason).toContain("min 1.19720");
  });

  it("trades a level set four bars before the breakout", () => {
    const bars = quiet();
    pattern(bars, { levelHour: 1 });
    expect(run(bars).trades.map((item) => item.direction)).toEqual(["SELL"]);
  });

  it("ignores a level set three bars before the breakout", () => {
    const bars = quiet();
    pattern(bars, { levelHour: 2 });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("does not count a close exactly at the level as a failure", () => {
    const bars = quiet();
    pattern(bars, { failure: [0.0023, 0.0025, 0.0012, 0.002], after: 0.002 });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("counts a close one point under the level as a failure", () => {
    const bars = quiet();
    pattern(bars, { failure: [0.0023, 0.0025, 0.0012, 0.00199], after: 0.00199 });
    expect(run(bars).trades.map((item) => item.direction)).toEqual(["SELL"]);
  });

  it("accepts the failure on the sixth bar after the breakout", () => {
    const bars = quiet();
    const iso = pattern(bars, { hold: [HOLD, HOLD, HOLD, HOLD, HOLD] });
    const result = run(bars);
    expect(result.trades.map((item) => item.entryTime)).toEqual([at(iso(12))]);
  });

  it("drops the setup when the failure comes on the seventh bar", () => {
    const bars = quiet();
    pattern(bars, { hold: [HOLD, HOLD, HOLD, HOLD, HOLD, HOLD] });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("does not start a new setup on the bar that ended the previous one", () => {
    // Hour 11 is the sixth bar after the breakout: the first setup expires on
    // it, and the same bar would also be a breakout of the hour-5 high.
    const low: Ohlc = [0.0023, 0.0025, 0.0021, 0.0023];
    const bars = quiet();
    pattern(bars, {
      hold: [low, low, low, low, low, [0.0023, 0.0029, 0.0022, 0.0028]],
      failure: [0.0028, 0.0029, 0.0015, 0.0018],
      after: 0.0018,
    });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("starts a new setup on the bar after the previous one ended", () => {
    const low: Ohlc = [0.0023, 0.0025, 0.0021, 0.0023];
    const bars = quiet();
    const iso = pattern(bars, {
      hold: [low, low, low, low, low, low, [0.0023, 0.0029, 0.0022, 0.0028]],
      failure: [0.0028, 0.0029, 0.0015, 0.0018],
      after: 0.0018,
    });
    const result = run(bars);
    expect(result.skipped).toEqual([]);
    expect(result.trades.map((item) => item.entryTime)).toEqual([at(iso(14))]);
    expect(result.trades[0]?.reason).toContain("L 1.20260 (high 2024-05-07 14:00)");
  });

  it("skips the trade when the stop is more than 1.5 x ATR away", () => {
    const bars = quiet();
    pattern(bars, { hold: [[0.0024, 0.0045, 0.0021, 0.0023]] });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["stop-too-far"]);
  });

  it("skips the trade when the stop is less than 0.5 x ATR away", () => {
    const bars = quiet();
    pattern(bars, {
      breakout: [0, 0.00215, -0.0005, 0.00214],
      hold: [],
      failure: [0.00214, 0.00215, 0.0019, 0.00199],
      after: 0.00199,
    });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["stop-too-close"]);
  });

  it("does not trade a failure outside the London and New York sessions", () => {
    // The entry would be at 08:00 server time: 06:00 in London, 01:00 in New York.
    const bars = quiet();
    pattern(bars, { base: "2024-05-07T00:00" });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("drops the signal when the next M15 does not open right after the failure hour", () => {
    const bars = quiet();
    const iso = pattern(bars);
    bars.splice(indexAt(bars, iso(8)), 4);
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["gap-after-signal"]);
  });

  it("takes the latest bar of a repeated extreme as the bar that set the level", () => {
    const source = flatBars("H1", START, 25, P).map((item, index) =>
      bar(item.time, P, index === 3 || index === 10 ? 1.201 : P, P, P),
    );
    const h1 = new ClosedBarsView(source, source.length);
    expect(levelBefore(h1, 24, "up")).toEqual({ price: 1.201, index: 10 });
    expect(levelBefore(h1, 24, "down")).toEqual({ price: P, index: 23 });
    expect(levelBefore(h1, 19, "up")).toBeNull();
  });

  it("declares its fixed parameters", () => {
    expect(failedBreakoutV1.params).toMatchObject({
      levelLookback: 20,
      levelMinAgeBars: 4,
      atrPeriod: 14,
      breakoutBufferAtr: 0.1,
      failureBars: 6,
      stopBufferAtr: 0.1,
      maxStopAtr: 1.5,
      minStopAtr: 0.5,
      takeProfitR: 2,
    });
    expect(failedBreakoutV1.executionTimeframe).toBe("M15");
  });
});
