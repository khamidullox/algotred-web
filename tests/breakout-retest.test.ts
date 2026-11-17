import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import {
  breakoutRetestV1A,
  breakoutRetestV1B,
  breakoutRetestV2Breakeven,
  breakoutRetestV2MinStop,
  inSession,
} from "../src/strategies/breakout-retest-v1";
import { at, bar, flatBars, indexAt, symbolData, testConfig, ZONE } from "./helpers/bars";

const M15 = 15 * 60_000;
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;

// Twelve server days from Monday 2024-05-06: more than 200 H1 bars for the
// SMA and a quiet market with a 10-pip range, so ATR(14) on H1 is 0.0010.
const START = "2024-05-06T00:00";
const DAYS = 12;
const QUIET_RANGE = 0.0005;

type Quad = readonly [open: number, high: number, low: number, close: number];

/** Replaces the four M15 bars of one server hour. */
function hour(bars: Bar[], iso: string, quads: readonly Quad[]): void {
  const start = indexAt(bars, iso);
  quads.forEach(([open, high, low, close], offset) => {
    const old = bars[start + offset] as Bar;
    bars[start + offset] = bar(old.time, px(open), px(high), px(low), px(close), 0);
  });
}

function quiet(level = P): Bar[] {
  return flatBars("M15", START, DAYS * 96, level).map((item) =>
    bar(item.time, level, px(level + QUIET_RANGE), px(level - QUIET_RANGE), level, 0),
  );
}

/**
 * A long pattern. Breakout hour at `breakoutIso` (server time): the hour
 * opens at P and closes 10 pips up with a 24-pip range, so L = P + 0.0005
 * and ATR(14) on the breakout bar = (13 x 0.0010 + 0.0024) / 14 = 0.0011.
 * Retest the next hour (low P + 0.0004), confirmation on the first M15 of
 * the hour after, the take reached three hours later. `sign` -1 mirrors
 * everything for a short.
 */
function longPattern(
  bars: Bar[],
  breakoutIso: string,
  options: { retestLow?: number; sign?: 1 | -1; cancel?: boolean; noRetest?: boolean } = {},
): void {
  const sign = options.sign ?? 1;
  const m = (delta: number): number => P + sign * delta;
  const q = (open: number, up: number, down: number, close: number): Quad =>
    sign === 1 ? [open, up, down, close] : [open, down, up, close];
  const start = DateTime.fromISO(breakoutIso, { zone: ZONE });
  const hourIso = (hours: number): string =>
    start.plus({ hours }).toFormat("yyyy-LL-dd'T'HH:mm");
  const flat = (level: number, range: number): Quad =>
    q(m(level), m(level + range), m(level - range), m(level));

  hour(bars, hourIso(0), [
    q(m(0), m(0.0004), m(-0.0005), m(0.0003)),
    q(m(0.0003), m(0.0019), m(0.0002), m(0.0006)),
    q(m(0.0006), m(0.0009), m(0.0005), m(0.0008)),
    q(m(0.0008), m(0.0012), m(0.0007), m(0.001)),
  ]);
  if (options.cancel) {
    // The next hour closes back below the level.
    hour(bars, hourIso(1), [
      q(m(0.001), m(0.001), m(0.0006), m(0.0007)),
      q(m(0.0007), m(0.0007), m(0.0003), m(0.0004)),
      q(m(0.0004), m(0.0005), m(0.0002), m(0.0003)),
      q(m(0.0004), m(0.0005), m(0.0002), m(0.0003)),
    ]);
    return;
  }
  if (options.noRetest) {
    // Six hours above the level plus the buffer, then a dip: too late.
    for (let offset = 1; offset <= 6; offset++) {
      hour(bars, hourIso(offset), [flat(0.001, 0.0001), flat(0.001, 0.0001), flat(0.001, 0.0001), flat(0.001, 0.0001)]);
    }
    hour(bars, hourIso(7), [
      q(m(0.001), m(0.001), m(0.0004), m(0.0008)),
      flat(0.0008, 0.0001),
      flat(0.0008, 0.0001),
      flat(0.0008, 0.0001),
    ]);
    hour(bars, hourIso(8), [
      q(m(0.0008), m(0.0011), m(0.0007), m(0.001)),
      flat(0.001, 0.0001),
      flat(0.001, 0.0001),
      flat(0.001, 0.0001),
    ]);
    return;
  }
  // Retest: dips to the level plus the buffer and closes above the level.
  const retestLow = options.retestLow ?? 0.0004;
  hour(bars, hourIso(1), [
    q(m(0.001), m(0.001), m(0.0006), m(0.0007)),
    q(m(0.0007), m(0.0007), m(retestLow), m(0.0006)),
    q(m(0.0006), m(0.0008), m(0.0006), m(0.0007)),
    q(m(0.0007), m(0.0009), m(0.0006), m(0.0008)),
  ]);
  // Confirmation: the first M15 closes above the high of the previous one (0.0009).
  hour(bars, hourIso(2), [
    q(m(0.0008), m(0.0011), m(0.0007), m(0.001)),
    q(m(0.001), m(0.0012), m(0.0009), m(0.0011)),
    q(m(0.0011), m(0.0013), m(0.001), m(0.0012)),
    q(m(0.0012), m(0.0014), m(0.0011), m(0.0013)),
  ]);
  // Two hours above the stop, then the take (entry + 2 x 7.1 pips) is reached.
  hour(bars, hourIso(3), [flat(0.0013, 0.0002), flat(0.0013, 0.0002), flat(0.0013, 0.0002), flat(0.0013, 0.0002)]);
  hour(bars, hourIso(4), [flat(0.0013, 0.0002), flat(0.0013, 0.0002), flat(0.0013, 0.0002), flat(0.0013, 0.0002)]);
  hour(bars, hourIso(5), [
    q(m(0.0013), m(0.0026), m(0.0012), m(0.0024)),
    flat(0.0024, 0.0002),
    flat(0.0024, 0.0002),
    flat(0.0024, 0.0002),
  ]);
}

function run(bars: Bar[], strategy = breakoutRetestV1A): BacktestResult {
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy,
    span: { start: at(START), end: at(START) + DAYS * 96 * M15 },
    config: testConfig(),
  });
}

// Tuesday 12:00 server time is 10:00 in London: inside the session.
const BREAKOUT = "2024-05-07T12:00";
// The same hour a week later, once 200 H1 bars exist for the SMA.
const BREAKOUT_WEEK_2 = "2024-05-14T12:00";

describe("BreakoutRetestV1-A on a hand-made pattern", () => {
  const bars = quiet();
  longPattern(bars, BREAKOUT);
  const result = run(bars);
  const trade = result.trades[0] as Trade;

  it("takes exactly one long trade", () => {
    expect(result.trades.map((item) => item.direction)).toEqual(["BUY"]);
    expect(result.skipped).toEqual([]);
  });

  it("enters at the open of the M15 after the confirmation", () => {
    // The confirmation closes at 14:15 server time; the entry is the 14:15 open.
    expect(trade.signalTime).toBe(at("2024-05-07T14:15"));
    expect(trade.entryTime).toBe(at("2024-05-07T14:15"));
    expect(trade.entryPrice).toBe(1.201);
  });

  it("puts the stop under the retest low and the take at 2R", () => {
    // Stop = retest low 1.2004 - 0.1 x 0.0011 = 1.20029; distance 7.1 pips.
    expect(trade.stopLoss).toBe(1.20029);
    expect(trade.stopDistance).toBe(0.00071);
    expect(trade.takeProfit).toBe(1.20242);
    expect(trade.reason).toContain("L 1.20050");
    expect(trade.reason).toContain("ATR(14) 0.00110");
    expect(trade.reason).toContain("пробой 2024-05-07 12:00 close 1.20100");
    expect(trade.reason).toContain("ретест 2024-05-07 13:00 low 1.20040");
    expect(trade.reason).toContain("подтверждение 2024-05-07 14:00");
  });

  it("exits at the take", () => {
    expect(trade.exitReason).toBe("take");
    expect(trade.exitTime).toBe(at("2024-05-07T17:00"));
    expect(trade.rMultiple).toBeCloseTo(2, 6);
    // 50 USD / (7.1 pips x 10 USD) = 0.704 -> 0.70 lot.
    expect(trade.lots).toBe(0.7);
  });
});

describe("BreakoutRetestV1 rules", () => {
  it("mirrors for a short", () => {
    const bars = quiet();
    longPattern(bars, BREAKOUT, { sign: -1 });
    const result = run(bars);
    const trade = result.trades[0] as Trade;
    expect(result.trades.map((item) => item.direction)).toEqual(["SELL"]);
    expect(trade.entryPrice).toBe(1.199);
    expect(trade.stopLoss).toBe(1.19971);
    expect(trade.takeProfit).toBe(1.19758);
    expect(trade.exitReason).toBe("take");
    expect(trade.reason).toContain("ретест 2024-05-07 13:00 high 1.19960");
  });

  it("cancels the setup when a bar closes back through the level", () => {
    const bars = quiet();
    longPattern(bars, BREAKOUT, { cancel: true });
    expect(run(bars).trades).toEqual([]);
  });

  it("gives up when no retest comes within six H1 bars", () => {
    const bars = quiet();
    longPattern(bars, BREAKOUT, { noRetest: true });
    expect(run(bars).trades).toEqual([]);
  });

  it("drops the trade when the stop is further than 1.5 x ATR", () => {
    const bars = quiet();
    // Retest low 20 pips under the entry: stop distance 0.00211 > 0.00165.
    longPattern(bars, BREAKOUT, { retestLow: -0.001 });
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(["stop-too-far"]);
  });

  it("does not enter outside the London and New York sessions", () => {
    const bars = quiet();
    // Breakout at 07:00 server: the entry would be 09:15 server = 07:15 London, 02:15 New York.
    longPattern(bars, "2024-05-07T07:00");
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("enters in the New York session when London is closed", () => {
    const bars = quiet();
    // Breakout at 19:00 server: the entry is 21:15 server = 19:15 London, 14:15 New York.
    longPattern(bars, "2024-05-07T19:00");
    expect(run(bars).trades).toHaveLength(1);
  });

  it("knows the session edges", () => {
    expect(inSession(at("2024-05-07T10:00"))).toBe(true); // 08:00 London
    expect(inSession(at("2024-05-07T09:45"))).toBe(false); // 07:45 London
    expect(inSession(at("2024-05-07T19:00"))).toBe(true); // 17:00 London
    expect(inSession(at("2024-05-07T19:15"))).toBe(true); // 12:15 New York
    expect(inSession(at("2024-05-08T00:00"))).toBe(true); // 17:00 New York
    expect(inSession(at("2024-05-08T00:15"))).toBe(false); // 17:15 New York
  });

  it("does not re-enter on the same breakout after the trade", () => {
    const bars = quiet();
    longPattern(bars, BREAKOUT);
    expect(run(bars).trades).toHaveLength(1);
  });

  it("cancels a Friday-night signal whose next bar is the Monday open", () => {
    // Weekdays only, like real data. Breakout Friday 21:00 server (14:00 New York),
    // retest 22:00, and only the fourth M15 of the 23:00 hour confirms: the signal
    // appears at 00:00 Saturday, the next bar opens Monday 00:00.
    const bars = quiet().filter(
      (item) => DateTime.fromMillis(item.time, { zone: ZONE }).weekday <= 5,
    );
    const m = (delta: number): number => P + delta;
    hour(bars, "2024-05-10T21:00", [
      [m(0), m(0.0004), m(-0.0005), m(0.0003)],
      [m(0.0003), m(0.0019), m(0.0002), m(0.0006)],
      [m(0.0006), m(0.0009), m(0.0005), m(0.0008)],
      [m(0.0008), m(0.0012), m(0.0007), m(0.001)],
    ]);
    hour(bars, "2024-05-10T22:00", [
      [m(0.001), m(0.001), m(0.0006), m(0.0007)],
      [m(0.0007), m(0.0007), m(0.0004), m(0.0006)],
      [m(0.0006), m(0.0008), m(0.0006), m(0.0007)],
      [m(0.0007), m(0.0009), m(0.0006), m(0.0008)],
    ]);
    hour(bars, "2024-05-10T23:00", [
      [m(0.0008), m(0.0009), m(0.0007), m(0.0008)],
      [m(0.0008), m(0.0009), m(0.0007), m(0.0008)],
      [m(0.0008), m(0.0009), m(0.0007), m(0.0008)],
      [m(0.0008), m(0.0011), m(0.0007), m(0.001)],
    ]);
    const result = run(bars);
    expect(result.trades).toEqual([]);
    expect(result.skipped).toMatchObject([
      { reason: "gap-after-signal", signalTime: at("2024-05-11T00:00") },
    ]);
  });
});

describe("BreakoutRetestV1-B trend filter", () => {
  it("takes the long when the breakout closes above SMA(200)", () => {
    const bars = quiet();
    longPattern(bars, BREAKOUT_WEEK_2);
    const result = run(bars, breakoutRetestV1B);
    expect(result.trades).toHaveLength(1);
    expect((result.trades[0] as Trade).reason).toContain("SMA(200) 1.20000");
  });

  it("waits for 200 H1 bars before it can trade at all", () => {
    const bars = quiet();
    longPattern(bars, BREAKOUT);
    expect(run(bars, breakoutRetestV1A).trades).toHaveLength(1);
    expect(run(bars, breakoutRetestV1B).trades).toEqual([]);
  });

  it("skips the long when the breakout closes below SMA(200), where A trades", () => {
    // The first seven days trade 100 pips higher, so the 200-bar average sits
    // far above the breakout close; the level and ATR have long settled.
    const bars = quiet();
    const dropAt = 7 * 96;
    for (let index = 0; index < dropAt; index++) {
      const old = bars[index] as Bar;
      bars[index] = bar(
        old.time,
        px(old.open + 0.01),
        px(old.high + 0.01),
        px(old.low + 0.01),
        px(old.close + 0.01),
        0,
      );
    }
    longPattern(bars, BREAKOUT_WEEK_2);
    expect(run(bars, breakoutRetestV1A).trades).toHaveLength(1);
    expect(run(bars, breakoutRetestV1B).trades).toEqual([]);
  });

  it("declares its parameters", () => {
    expect(breakoutRetestV1A.params.trendFilter).toBe("none");
    expect(breakoutRetestV1B.params.trendFilter).toBe("SMA(200) H1");
    expect(breakoutRetestV1A.params.minStopAtr).toBe("none");
    expect(breakoutRetestV1A.executionTimeframe).toBe("M15");
  });
});

describe("BreakoutRetestV2-minstop", () => {
  it("takes the standard pattern like V1-A: the 7.1-pip stop is above 0.5 x ATR", () => {
    const bars = quiet();
    longPattern(bars, BREAKOUT);
    const v2 = run(bars, breakoutRetestV2MinStop);
    expect(v2.trades).toHaveLength(1);
    expect(v2.trades[0]?.stopDistance).toBe(0.00071);
    expect(v2.skipped).toEqual([]);
  });

  it("skips a trade whose stop is tighter than 0.5 x ATR, where V1-A trades it", () => {
    // The retest hour's lowest low is 1.2006 (the other M15 bars of that hour):
    // stop 1.20049, distance 5.1 pips, under the 5.5-pip minimum (0.5 x 0.0011).
    const bars = quiet();
    longPattern(bars, BREAKOUT, { retestLow: 0.00061 });
    const v1 = run(bars, breakoutRetestV1A);
    expect(v1.trades).toHaveLength(1);
    expect(v1.trades[0]?.stopDistance).toBe(0.00051);
    const v2 = run(bars, breakoutRetestV2MinStop);
    expect(v2.trades).toEqual([]);
    expect(v2.skipped.map((skip) => skip.reason)).toEqual(["stop-too-close"]);
  });

  it("declares the minimum stop", () => {
    expect(breakoutRetestV2MinStop.name).toBe("BreakoutRetestV2-minstop");
    expect(breakoutRetestV2MinStop.params.minStopAtr).toBe(0.5);
    expect(breakoutRetestV2MinStop.params.trendFilter).toBe("none");
  });
});

describe("BreakoutRetestV2-breakeven", () => {
  it("moves the stop to the entry after +1R and exits there on the pullback", () => {
    // Standard pattern (entry 1.2010, stop 1.20029, 7.1 pips). Hour 3 reaches
    // 1.2018 (+11 pips) and closes; hour 4 falls back to the entry.
    const bars = quiet();
    longPattern(bars, BREAKOUT);
    const m = (delta: number): number => P + delta;
    hour(bars, "2024-05-07T15:00", [
      [m(0.0013), m(0.0018), m(0.0012), m(0.0016)],
      [m(0.0016), m(0.0017), m(0.0014), m(0.0015)],
      [m(0.0015), m(0.0016), m(0.0014), m(0.0015)],
      [m(0.0015), m(0.0016), m(0.0014), m(0.0015)],
    ]);
    hour(bars, "2024-05-07T16:00", [
      [m(0.0015), m(0.0015), m(0.0009), m(0.0011)],
      [m(0.0011), m(0.0012), m(0.001), m(0.0011)],
      [m(0.0011), m(0.0012), m(0.001), m(0.0011)],
      [m(0.0011), m(0.0012), m(0.001), m(0.0011)],
    ]);
    const v1 = run(bars, breakoutRetestV1A);
    expect(v1.trades[0]?.exitReason).toBe("take");
    const v2 = run(bars, breakoutRetestV2Breakeven);
    const trade = v2.trades[0] as Trade;
    expect(trade.exitReason).toBe("breakeven");
    expect(trade.exitPrice).toBe(1.201);
    expect(trade.breakevenTime).toBe(at("2024-05-07T15:15"));
    expect(trade.stopAtExit).toBe(1.201);
    expect(trade.netPnlUsd).toBe(0);
  });

  it("declares the rule", () => {
    expect(breakoutRetestV2Breakeven.name).toBe("BreakoutRetestV2-breakeven");
    expect(breakoutRetestV2Breakeven.params.breakevenAtR).toBe(1);
    expect(breakoutRetestV1A.params.breakevenAtR).toBe("none");
  });
});
