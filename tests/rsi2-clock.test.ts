import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, MarketContext, Strategy, StrategyAction, StrategyInstance } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import {
  placedAtClock,
  RSI2_INDEX_AT_9_TASHKENT,
  rsi2ReversionIndexD1,
  rsi2ReversionIndexD1At9Tashkent,
} from "../src/strategies/rsi2-reversion-d1";
import { bar, symbolData, testConfig, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
const TREND_DAYS = 210;
/** Two falling days after the climb: RSI(2) 4.76 (the dip of the 17.4 tests). */
const DIP = [0.205, 0.197, 0.198, 0.204];

interface Scene {
  readonly result: BacktestResult;
  /** Server midnight of a day of the scene, UTC ms. */
  readonly dayStart: (day: number) => number;
}

/**
 * The scene of the Rsi2ReversionIndexD1 tests, with hours that differ: 210
 * days up 10 points a day, the dip, 16 more days up. Each day falls or rises
 * evenly from its open (the previous close) to its close over the hours that
 * trade, so an order filled later in the day gets another price. `hours` are
 * the server hours with a bar, the whole day by default.
 */
function scene(strategy: Strategy, firstDay: string, options: { sign?: 1 | -1; lastHourOf?: (day: number) => number } = {}): Scene {
  const sign = options.sign ?? 1;
  const first = DateTime.fromISO(firstDay, { zone: ZONE });
  const dayStart = (day: number): number => first.plus({ days: day }).toMillis();
  const offsets: number[] = [];
  for (let day = 0; day < TREND_DAYS; day++) offsets.push(0.001 * day);
  offsets.push(...DIP);
  const last = offsets.at(-1) as number;
  for (let day = 1; day <= 16; day++) offsets.push(last + 0.001 * day);
  const closes = offsets.map((offset) => px(P + sign * offset));
  const bars: Bar[] = [];
  closes.forEach((close, day) => {
    const open = day === 0 ? close : (closes[day - 1] as number);
    const hours = options.lastHourOf?.(day) ?? 23;
    for (let hour = 0; hour <= hours; hour++) {
      const from = px(open + ((close - open) * hour) / (hours + 1));
      const to = px(open + ((close - open) * (hour + 1)) / (hours + 1));
      bars.push(bar(dayStart(day) + hour * HOUR, from, px(Math.max(from, to) + 0.0002), px(Math.min(from, to) - 0.0002), to));
    }
  });
  const result = runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: { ...strategy, symbols: ["EURUSD"] },
    span: { start: dayStart(0), end: dayStart(closes.length) },
    config: testConfig(),
  });
  return { result, dayStart };
}

/** The same rules with no entry date: the scenes are in 2023-2024, the frozen strategy's own date is far earlier anyway. */
const AT_OPEN = rsi2ReversionIndexD1;
const AT_NINE = rsi2ReversionIndexD1At9Tashkent;
// The dip's second falling day is day 211; the order is for day 212 and the exit for day 215.
const SIGNAL_DAY = TREND_DAYS + 1;

describe("Rsi2ReversionIndexD1At9Tashkent", () => {
  it("is the confirmed rule with one thing added: the hour the orders are placed", () => {
    expect(AT_NINE.name).toBe("Rsi2ReversionIndexD1At9Tashkent");
    expect(AT_NINE.symbols).toEqual(AT_OPEN.symbols);
    expect(AT_NINE.executionTimeframe).toBe("H1");
    expect(AT_NINE.params).toEqual({ ...AT_OPEN.params, tradeFrom: "2016-09-01T00:00 server time", ordersPlacedAt: "09:00 Asia/Tashkent" });
    expect(RSI2_INDEX_AT_9_TASHKENT.orderClock).toEqual({ hour: 9, zone: "Asia/Tashkent" });
  });

  it("enters and leaves at 09:00 Tashkent time, which is 07:00 on the server in summer", () => {
    // From 2024-01-01 the dip falls on the end of July: the server is three hours ahead of UTC, Tashkent five.
    const open = scene(AT_OPEN, "2024-01-01T00:00");
    const nine = scene(AT_NINE, "2024-01-01T00:00");
    expect(open.result.trades).toHaveLength(1);
    expect(nine.result.trades).toHaveLength(1);
    const [atOpen] = open.result.trades;
    const [late] = nine.result.trades;
    expect(atOpen?.entryTime).toBe(open.dayStart(SIGNAL_DAY + 1));
    expect(late?.entryTime).toBe(nine.dayStart(SIGNAL_DAY + 1) + 7 * HOUR);
    expect(DateTime.fromMillis(late?.entryTime ?? 0, { zone: "Asia/Tashkent" }).toFormat("HH:mm")).toBe("09:00");
    // The exit is decided by the same daily close and placed at the same hour of the next day.
    expect(late?.exitReason).toBe("strategy");
    expect((late?.exitTime ?? 0) - (atOpen?.exitTime ?? 0)).toBe(7 * HOUR);
    expect(late?.direction).toBe(atOpen?.direction);
  });

  it("is 06:00 on the server in winter", () => {
    // From 2023-06-01 the dip falls on the end of December: the server is two hours ahead of UTC.
    const nine = scene(AT_NINE, "2023-06-01T00:00");
    const [late] = nine.result.trades;
    expect(nine.result.trades).toHaveLength(1);
    expect(late?.entryTime).toBe(nine.dayStart(SIGNAL_DAY + 1) + 6 * HOUR);
    expect(DateTime.fromMillis(late?.entryTime ?? 0, { zone: "Asia/Tashkent" }).toFormat("HH:mm")).toBe("09:00");
    expect(DateTime.fromMillis(late?.exitTime ?? 0, { zone: "Asia/Tashkent" }).toFormat("HH:mm")).toBe("09:00");
  });

  it("keeps the stop the signal's distance from the late fill, not from the open", () => {
    const open = scene(AT_OPEN, "2024-01-01T00:00");
    const nine = scene(AT_NINE, "2024-01-01T00:00");
    const [atOpen] = open.result.trades;
    const [late] = nine.result.trades;
    // The entry day rises through its hours, so seven hours in the price is higher.
    expect(late?.entryPrice).toBeGreaterThan(atOpen?.entryPrice ?? Infinity);
    expect(late?.stopDistance).toBeCloseTo(atOpen?.stopDistance ?? 0, 9);
    expect((late?.entryPrice ?? 0) - (late?.stopLoss ?? 0)).toBeCloseTo(late?.stopDistance ?? -1, 9);
    expect(late?.stopLoss).toBeGreaterThan(atOpen?.stopLoss ?? Infinity);
  });

  it("mirrors for a sale", () => {
    const nine = scene(AT_NINE, "2024-01-01T00:00", { sign: -1 });
    expect(nine.result.trades.map((trade) => [trade.direction, trade.exitReason])).toEqual([["SELL", "strategy"]]);
    expect(nine.result.trades[0]?.entryTime).toBe(nine.dayStart(SIGNAL_DAY + 1) + 7 * HOUR);
  });

  it("drops an order whose day ends before the hour, and lets the next daily close decide", () => {
    // The day after the signal trades only until 05:00 on the server: nobody is there at 07:00.
    const short = scene(AT_NINE, "2024-01-01T00:00", { lastHourOf: (day) => (day === SIGNAL_DAY + 1 ? 4 : 23) });
    const whole = scene(AT_NINE, "2024-01-01T00:00");
    // The short day closes up, RSI(2) is no longer under 5: no new signal, no trade at all.
    expect(whole.result.trades).toHaveLength(1);
    expect(short.result.trades).toHaveLength(0);
    // The rule at the open is not touched by a short day.
    expect(scene(AT_OPEN, "2024-01-01T00:00", { lastHourOf: (day) => (day === SIGNAL_DAY + 1 ? 4 : 23) }).result.trades).toHaveLength(1);
  });

  it("takes no entry before its starting date", () => {
    // A scene that ends before 2016-09-01: the same dip gives the rule at the open a trade and this one none.
    expect(scene(AT_OPEN, "2015-06-01T00:00").result.trades).toHaveLength(1);
    expect(scene(AT_NINE, "2015-06-01T00:00").result.trades).toHaveLength(0);
  });
});

describe("placedAtClock", () => {
  const entry: StrategyAction = { kind: "entry", direction: "BUY", stopLoss: { distance: 1 }, takeProfit: null, reason: "test" };
  const exit: StrategyAction = { kind: "exit", reason: "test" };
  const at = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis();

  /** Drives the wrapper bar by bar: `said` is what the rule returns at a daily close. */
  function drive(clock: { hour: number; zone: string }) {
    let said: StrategyAction | null = null;
    let dailyClose = false;
    let now = 0;
    let lastOpen = 0;
    const rule: StrategyInstance = { onBarClose: () => (dailyClose ? said : null) };
    const ctx = {
      zone: ZONE,
      get now() {
        return now;
      },
      bars: () => ({ last: () => ({ time: lastOpen }) }),
      justClosed: (timeframe: string) => timeframe === "H1" || (timeframe === "D1" && dailyClose),
    } as unknown as MarketContext;
    const own = placedAtClock(rule, clock);
    return {
      /** The hourly bar that opened at `open` closes; it ends its day when `action` is given (null included). */
      close(open: string, action?: StrategyAction | null): StrategyAction | null {
        lastOpen = at(open);
        now = lastOpen + HOUR;
        dailyClose = action !== undefined;
        said = action ?? null;
        return own.onBarClose(ctx);
      },
    };
  }

  it("lets the order out at the first hourly close at or after the hour, once", () => {
    const own = drive({ hour: 5, zone: ZONE });
    expect(own.close("2024-03-05T23:00", entry)).toBeNull();
    expect(own.close("2024-03-06T01:00")).toBeNull();
    expect(own.close("2024-03-06T03:00")).toBeNull();
    // The bar 04:00-05:00 closes at 05:00: the engine fills at the next open, 05:00.
    expect(own.close("2024-03-06T04:00")).toBe(entry);
    expect(own.close("2024-03-06T05:00")).toBeNull();
  });

  it("counts the hour on the day of the first bar after the signal: a Friday order waits for Monday", () => {
    const own = drive({ hour: 5, zone: ZONE });
    expect(own.close("2024-03-08T23:00", exit)).toBeNull();
    // Monday's first bar opens at 01:00.
    expect(own.close("2024-03-11T01:00")).toBeNull();
    expect(own.close("2024-03-11T03:00")).toBeNull();
    expect(own.close("2024-03-11T04:00")).toBe(exit);
  });

  it("reads the hour on the clock of its own place", () => {
    // 09:00 in Tashkent is 06:00 in Athens in March.
    const own = drive({ hour: 9, zone: "Asia/Tashkent" });
    expect(own.close("2024-03-05T23:00", entry)).toBeNull();
    expect(own.close("2024-03-06T04:00")).toBeNull();
    expect(own.close("2024-03-06T05:00")).toBe(entry);
  });

  it("forgets an order it never placed when the next daily close comes", () => {
    const own = drive({ hour: 22, zone: ZONE });
    expect(own.close("2024-03-05T23:00", entry)).toBeNull();
    expect(own.close("2024-03-06T01:00")).toBeNull();
    // The day ends at 20:00 without the order going out; the rule says nothing new.
    expect(own.close("2024-03-06T19:00", null)).toBeNull();
    expect(own.close("2024-03-07T21:00")).toBeNull();
    expect(own.close("2024-03-07T22:00")).toBeNull();
  });

  it("passes nothing on at the daily close itself and holds a cancel back for good", () => {
    const own = drive({ hour: 2, zone: ZONE });
    expect(own.close("2024-03-05T23:00", { kind: "cancel", reason: "test" })).toBeNull();
    expect(own.close("2024-03-06T01:00")).toBeNull();
    expect(own.close("2024-03-06T02:00")).toBeNull();
  });
});
