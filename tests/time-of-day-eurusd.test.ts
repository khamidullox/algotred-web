import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { timeOfDayEURUSD } from "../src/strategies/time-of-day-eurusd";
import { at, bar, symbolData, testConfig, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
const serverDay = (date: string, plusDays = 0): number =>
  DateTime.fromISO(`${date}T00:00`, { zone: ZONE }).plus({ days: plusDays }).toMillis();

/**
 * Hourly EURUSD bars for `days` server days from `from`, each hour flat at
 * `price(time)` with a 5-point range either side, so a quiet day has a D1
 * range of 10 points and ATR(20) of 0.0010. The hourly bars are passed as the
 * lowest timeframe, so the H1 bars are exactly these.
 */
function series(from: string, days: number, price: (time: number) => number = () => P): Bar[] {
  const bars: Bar[] = [];
  for (let time = serverDay(from); time < serverDay(from, days); time += HOUR) {
    const p = price(time);
    bars.push(bar(time, p, px(p + 0.0005), px(p - 0.0005), p));
  }
  return bars;
}

function run(bars: Bar[]): BacktestResult {
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: timeOfDayEURUSD,
    span: { start: (bars[0] as Bar).time, end: (bars.at(-1) as Bar).time + HOUR },
    config: testConfig(),
  });
}

/** Trades entered on one server day. */
const onDay = (result: BacktestResult, date: string): Trade[] =>
  result.trades.filter((trade) => trade.entryTime >= serverDay(date) && trade.entryTime < serverDay(date, 1));

const DAY = "2024-02-13"; // a Tuesday in winter: London +0, server +2, New York -5
const WINTER_FROM = "2024-01-08";
const WINTER_DAYS = 40;

/**
 * On the test day: 1.2000 until the 09:00 server hour (07:00 London), 1.1990
 * from 10:00, 1.2005 from 16:00 on (the hours after the 08:00 New York open
 * at 15:00 server).
 */
function winterPrice(time: number): number {
  if (time < at(`${DAY}T10:00`)) return P;
  if (time < at(`${DAY}T16:00`)) return 1.199;
  return 1.2005;
}

describe("TimeOfDayEURUSD on a winter day", () => {
  const result = run(series(WINTER_FROM, WINTER_DAYS, winterPrice));
  const [short, long] = onDay(result, DAY) as [Trade, Trade];

  it("sells at the London open and reverses into a buy at the New York open", () => {
    expect(onDay(result, DAY).map((trade) => trade.direction)).toEqual(["SELL", "BUY"]);
    expect(short.entryTime).toBe(at(`${DAY}T09:00`));
    expect(short.exitTime).toBe(at(`${DAY}T15:00`));
    expect(short.exitReason).toBe("strategy");
    expect(long.entryTime).toBe(at(`${DAY}T15:00`));
    expect(long.exitTime).toBe(at(`${DAY}T23:00`));
    expect(long.exitReason).toBe("strategy");
  });

  it("earns the moves of the two sessions and holds no position overnight", () => {
    expect([short.entryPrice, short.exitPrice]).toEqual([1.2, 1.199]);
    expect([long.entryPrice, long.exitPrice]).toEqual([1.199, 1.2005]);
    expect(short.nights).toBe(0);
    expect(long.nights).toBe(0);
  });

  it("sizes from a stop 2 x ATR(20) of D1 away", () => {
    expect(short.stopDistance).toBeCloseTo(0.002, 8);
    expect(short.lots).toBe(0.25);
    expect(short.reason).toBe("европейские часы: продажа с 07:00 Лондон; ATR(20) D1 0.00100");
    expect(long.reason).toMatch(/^американские часы: покупка с 08:00 Нью-Йорк; ATR\(20\) D1 0\.001\d\d$/);
  });

  it("trades only on weekdays, two trades a day", () => {
    const weekdays = new Set(
      result.trades.map((trade) => DateTime.fromMillis(trade.entryTime, { zone: ZONE }).weekday),
    );
    expect([...weekdays].every((day) => day <= 5)).toBe(true);
    expect(result.trades.length % 2).toBe(0);
    expect(result.skipped).toEqual([]);
  });
});

describe("TimeOfDayEURUSD follows London and New York time", () => {
  const cases = [
    // [day, first day of the series, sell, reverse, close] in server time
    ["2024-03-12", "2024-02-05", "09:00", "14:00", "22:00"], // New York on summer time, Europe not yet
    ["2024-04-16", "2024-03-11", "09:00", "15:00", "23:00"], // both on summer time
    ["2024-10-29", "2024-09-23", "09:00", "14:00", "22:00"], // Europe back on winter time, New York not yet
  ] as const;
  for (const [day, from, sell, reverse, close] of cases) {
    it(`on ${day}: sell ${sell}, reverse ${reverse}, close ${close} server time`, () => {
      const trades = onDay(run(series(from, 40)), day);
      expect(trades.map((trade) => [trade.direction, trade.entryTime, trade.exitTime])).toEqual([
        ["SELL", at(`${day}T${sell}`), at(`${day}T${reverse}`)],
        ["BUY", at(`${day}T${reverse}`), at(`${day}T${close}`)],
      ]);
    });
  }
});

describe("TimeOfDayEURUSD with missing hours and stops", () => {
  const without = (...hours: string[]): Bar[] =>
    series(WINTER_FROM, WINTER_DAYS, winterPrice).filter(
      (item) => !hours.some((hour) => item.time === at(`${DAY}T${hour}`)),
    );

  it("skips the sell when the 07:00 London hour is missing, and still buys", () => {
    const result = run(without("09:00"));
    expect(onDay(result, DAY).map((trade) => [trade.direction, trade.entryTime])).toEqual([
      ["BUY", at(`${DAY}T15:00`)],
    ]);
    expect(result.skipped.map((item) => [item.direction, item.reason])).toEqual([["SELL", "gap-after-signal"]]);
  });

  it("closes the sell at the next open and skips the buy when the 08:00 New York hour is missing", () => {
    const result = run(without("15:00"));
    expect(onDay(result, DAY).map((trade) => [trade.direction, trade.exitTime, trade.exitReason])).toEqual([
      ["SELL", at(`${DAY}T16:00`), "strategy"],
    ]);
    expect(result.skipped.map((item) => [item.direction, item.reason])).toEqual([["BUY", "gap-after-signal"]]);
  });

  it("closes the sell after 08:00 New York when no bar closes at 08:00", () => {
    // The 07:00 New York hour is missing, so the reversal is never signalled.
    const result = run(without("14:00"));
    expect(onDay(result, DAY).map((trade) => [trade.direction, trade.exitTime, trade.exitReason])).toEqual([
      ["SELL", at(`${DAY}T16:00`), "strategy"],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("closes the buy at the first open after a missing 16:00 New York hour", () => {
    const result = run(without("23:00"));
    const long = onDay(result, DAY)[1] as Trade;
    expect(long.direction).toBe("BUY");
    expect(long.exitTime).toBe(serverDay(DAY, 1));
    expect(long.nights).toBe(1);
  });

  it("still buys at the New York open after the morning sell was stopped", () => {
    // 11:00 server spikes to 1.2030, above the stop at 1.2020.
    const spiked = series(WINTER_FROM, WINTER_DAYS, winterPrice).map((item) =>
      item.time === at(`${DAY}T11:00`) ? bar(item.time, 1.199, 1.203, 1.1985, 1.199) : item,
    );
    const trades = onDay(run(spiked), DAY);
    expect(trades.map((trade) => [trade.direction, trade.exitReason])).toEqual([
      ["SELL", "stop"],
      ["BUY", "strategy"],
    ]);
    expect((trades[0] as Trade).exitTime).toBe(at(`${DAY}T11:00`));
    expect((trades[1] as Trade).entryTime).toBe(at(`${DAY}T15:00`));
  });
});

describe("TimeOfDayEURUSD settings", () => {
  it("trades EURUSD only and declares its fixed parameters", () => {
    expect(timeOfDayEURUSD.symbols).toEqual(["EURUSD"]);
    expect(timeOfDayEURUSD.executionTimeframe).toBe("H1");
    expect(timeOfDayEURUSD.params).toMatchObject({
      europeOpen: "07:00 Europe/London",
      usOpen: "08:00 America/New_York",
      usClose: "16:00 America/New_York",
      atrPeriod: 20,
      atrMultiple: 2,
    });
  });
});
