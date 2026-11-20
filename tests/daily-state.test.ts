import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { Bar } from "../src/data/types";
import { runBacktest } from "../src/engine/backtest";
import { symbolSpec } from "../src/engine/symbols";
import type { Strategy } from "../src/engine/types";
import { closedDailyBars, replayDaily } from "../src/signals/daily-state";
import { rsi2ReversionIndexD1 } from "../src/strategies/rsi2-reversion-d1";
import { bar, symbolData, testConfig, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
const dayStart = (day: number): number => DateTime.fromISO("2024-01-01T00:00", { zone: ZONE }).plus({ days: day }).toMillis();
const SPEC = symbolSpec(testConfig(), "EURUSD");
const STRATEGY: Strategy = { ...rsi2ReversionIndexD1, symbols: ["EURUSD"] };

/**
 * 210 days moving 10 points a day (up, or down for `sign` -1), then `tail`
 * (offsets from P), then 16 more days going on 10 points a day. Every day is
 * 24 identical H1 bars, so the D1 bar is that day: the scenario of the
 * Rsi2ReversionIndexD1 tests.
 */
function hourly(tail: readonly number[], sign: 1 | -1 = 1): Bar[] {
  const offsets: number[] = [];
  for (let day = 0; day < 210; day++) offsets.push(0.001 * day);
  offsets.push(...tail);
  const last = offsets.at(-1) as number;
  for (let day = 1; day <= 16; day++) offsets.push(last + 0.001 * day);
  const closes = offsets.map((offset) => px(P + sign * offset));
  const bars: Bar[] = [];
  closes.forEach((close, day) => {
    const open = day === 0 ? close : (closes[day - 1] as number);
    for (let time = dayStart(day); time < dayStart(day + 1); time += HOUR) {
      bars.push(bar(time, open, px(Math.max(open, close) + 0.0005), px(Math.min(open, close) - 0.0005), close));
    }
  });
  return bars;
}

/** Two falling days after the climb: RSI(2) under 5 on day 211, back above SMA(5) on day 213. */
const DIP = [0.205, 0.197, 0.198, 0.204];
/** The same dip, then a collapse on day 212 that takes the stop. */
const CRASH = [0.205, 0.197, 0.15, 0.15];

function both(tail: readonly number[], sign: 1 | -1 = 1) {
  const bars = hourly(tail, sign);
  const data = symbolData("EURUSD", bars);
  const engine = runBacktest({
    data: [data],
    strategy: STRATEGY,
    span: { start: dayStart(0), end: (bars.at(-1) as Bar).time + HOUR },
    config: testConfig(),
  });
  return { d1: data.bars.D1, engine, replay: replayDaily(STRATEGY, "EURUSD", SPEC, ZONE, data.bars.D1) };
}

describe("replayDaily against the engine", () => {
  it("makes the trades the engine makes from the same days", () => {
    for (const sign of [1, -1] as const) {
      const { engine, replay } = both(DIP, sign);
      expect(engine.trades).toHaveLength(1);
      expect(replay.trades.map((t) => [t.direction, t.entryTime, t.entryPrice, t.stopLoss, t.exitTime, t.exitPrice, t.exitReason])).toEqual(
        engine.trades.map((t) => [t.direction, t.entryTime, t.entryPrice, t.stopLoss, t.exitTime, t.exitPrice, t.exitReason]),
      );
      expect(replay.trades[0]?.r).toBeCloseTo(engine.trades[0]?.rMultiple as number, 10);
      expect(replay.trades[0]?.reason).toBe(engine.trades[0]?.reason);
      expect(replay.state).toEqual({ kind: "flat" });
    }
  }, 30_000);

  it("is stopped where the engine is stopped", () => {
    const { engine, replay } = both(CRASH);
    // The collapse takes the stop; what the strategy does in the fall after it must match as well.
    expect(engine.trades[0]?.exitReason).toBe("stop");
    expect(replay.trades.map((t) => [t.entryTime, t.stopLoss, t.exitTime, t.exitPrice, t.exitReason])).toEqual(
      engine.trades.map((t) => [t.entryTime, t.stopLoss, t.exitTime, t.exitPrice, t.exitReason]),
    );
    expect(replay.trades[0]?.r).toBeCloseTo(-1, 10);
  }, 30_000);
});

describe("replayDaily: where the strategy stands after the last day", () => {
  const { d1, engine } = both(DIP);
  const trade = engine.trades[0];
  const upTo = (lastDay: number) => replayDaily(STRATEGY, "EURUSD", SPEC, ZONE, d1.slice(0, lastDay + 1));

  it("has nothing to say before the dip", () => {
    const replay = upTo(209);
    expect(replay.state).toEqual({ kind: "flat" });
    expect(replay.trades).toEqual([]);
    expect(replay.asOf?.time).toBe(dayStart(209));
  });

  it("gives the entry for the next open on the signal day", () => {
    const state = upTo(211).state;
    expect(state.kind).toBe("enter");
    if (state.kind !== "enter") return;
    expect(state.direction).toBe("BUY");
    // The stop distance the engine then used, 2 x ATR(20); the engine rounds it to the price step.
    expect(Math.abs(state.stopDistance - (trade?.stopDistance as number))).toBeLessThan(SPEC.point);
    expect(state.reason).toBe(trade?.reason);
  });

  it("holds the position while the exit rule is silent", () => {
    const state = upTo(212).state;
    expect(state.kind).toBe("open");
    if (state.kind !== "open") return;
    expect(state.position).toMatchObject({ direction: "BUY", entryTime: dayStart(212), entryPrice: trade?.entryPrice, stopLoss: trade?.stopLoss, days: 1 });
  });

  it("says to leave at the next open after the close above SMA(5)", () => {
    const state = upTo(213).state;
    expect(state.kind).toBe("exit");
    if (state.kind !== "exit") return;
    expect(state.position.days).toBe(2);
    expect(state.reason).toContain("SMA(5)");
    // The day after, the trade is closed and nothing is pending.
    expect(upTo(214).state).toEqual({ kind: "flat" });
    expect(upTo(214).trades).toHaveLength(1);
  });

  it("gives a sell in a falling market, mirrored", () => {
    const down = both(DIP, -1);
    const state = replayDaily(STRATEGY, "EURUSD", SPEC, ZONE, down.d1.slice(0, 212)).state;
    expect(state).toMatchObject({ kind: "enter", direction: "SELL" });
  });
});

describe("replayDaily: limits", () => {
  it("refuses an order it does not model instead of guessing", () => {
    const withTake: Strategy = {
      name: "WithTake",
      params: {},
      executionTimeframe: "H1",
      create: () => ({
        onBarClose: (ctx) =>
          ctx.position === null ? { kind: "entry", direction: "BUY", stopLoss: { distance: 0.01 }, takeProfit: { rMultiple: 2 }, reason: "test" } : null,
      }),
    };
    const { d1 } = both(DIP);
    expect(() => replayDaily(withTake, "EURUSD", SPEC, ZONE, d1.slice(0, 5))).toThrow(/does not model/);
  });

  it("returns an empty answer without bars", () => {
    expect(replayDaily(STRATEGY, "EURUSD", SPEC, ZONE, [])).toEqual({ asOf: null, state: { kind: "flat" }, trades: [] });
  });
});

describe("closedDailyBars", () => {
  it("drops the day that is still trading", () => {
    const days = [0, 1, 2].map((day) => bar(dayStart(day), P, P, P, P));
    // One hour before the end of day 2.
    expect(closedDailyBars(days, ZONE, dayStart(3) - HOUR).map((item) => item.time)).toEqual([dayStart(0), dayStart(1)]);
    // At its last moment the day is closed.
    expect(closedDailyBars(days, ZONE, dayStart(3))).toHaveLength(3);
  });
});

describe("replayDaily on hand-made days", () => {
  /** Enters on every close with no position, with a stop 5 away; never exits by itself. */
  const always = (direction: "BUY" | "SELL", stop: { distance: number } | { price: number } = { distance: 5 }): Strategy => ({
    name: "Always",
    params: {},
    executionTimeframe: "H1",
    create: () => ({
      onBarClose: () => ({ kind: "entry", direction, stopLoss: stop, takeProfit: null, reason: "always" }),
    }),
  });
  const spec = { symbol: "TEST", digits: 2, point: 0.01, pip: 0.1, contractSize: 1, usdSide: "quote" } as const;
  const days = (rows: readonly (readonly [number, number, number, number])[]): Bar[] =>
    rows.map(([open, high, low, close], day) => bar(dayStart(day), open, high, low, close));
  const QUIET = [100, 101, 99, 100] as const;

  it("fills the stop at the open when the day opens beyond it", () => {
    // Entry at the open of day 1 at 100, stop 95; day 2 opens at 90.
    const long = replayDaily(always("BUY"), "TEST", spec, ZONE, days([QUIET, QUIET, [90, 91, 89, 90], QUIET]));
    expect(long.trades[0]).toMatchObject({ entryPrice: 100, stopLoss: 95, exitTime: dayStart(2), exitPrice: 90, exitReason: "stop", r: -2 });
    const short = replayDaily(always("SELL"), "TEST", spec, ZONE, days([QUIET, QUIET, [110, 111, 109, 110], QUIET]));
    expect(short.trades[0]).toMatchObject({ entryPrice: 100, stopLoss: 105, exitPrice: 110, exitReason: "stop", r: -2 });
  });

  it("fills the stop at its level when the day reaches it from inside", () => {
    const long = replayDaily(always("BUY"), "TEST", spec, ZONE, days([QUIET, QUIET, [100, 101, 94, 96], QUIET]));
    expect(long.trades[0]).toMatchObject({ exitPrice: 95, exitReason: "stop", r: -1 });
    const short = replayDaily(always("SELL"), "TEST", spec, ZONE, days([QUIET, QUIET, [100, 106, 99, 104], QUIET]));
    expect(short.trades[0]).toMatchObject({ exitPrice: 105, exitReason: "stop", r: -1 });
  });

  it("keeps the open position when the strategy asks to enter again", () => {
    const replay = replayDaily(always("BUY"), "TEST", spec, ZONE, days([QUIET, QUIET, QUIET]));
    expect(replay.trades).toEqual([]);
    expect(replay.state).toMatchObject({ kind: "open", position: { entryTime: dayStart(1), entryPrice: 100, days: 2 } });
  });

  it("skips an entry whose stop is on the wrong side of the open", () => {
    // A fixed stop price above the open for a buy.
    const replay = replayDaily(always("BUY", { price: 120 }), "TEST", spec, ZONE, days([QUIET, QUIET, QUIET]));
    expect(replay.trades).toEqual([]);
    // Nothing was opened, so the last close still asks for an entry.
    expect(replay.state.kind).toBe("enter");
  });
});
