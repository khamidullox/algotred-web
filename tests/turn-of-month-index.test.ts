import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import {
  INDEX_SYMBOLS,
  midMonthIndexControl,
  midMonthWindow,
  turnOfMonthIndex,
  turnOfMonthWindow,
} from "../src/strategies/turn-of-month-index";
import { bar, symbolData, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
const serverDay = (date: string): number => DateTime.fromISO(`${date}T00:00`, { zone: ZONE }).toMillis();

function config(): Config {
  const index = {
    digits: 2,
    contractSize: 10,
    usdSide: "quote",
    swapLongPips: 0,
    swapShortPips: 0,
    minSpreadPoints: 0,
    commissionPerLotRoundTrip: 0,
    slippagePoints: 0,
    tripleSwapDay: "friday",
    timeZoneCheck: false,
  };
  return parseConfig({
    brokerTimeZone: ZONE,
    dataDir: "data/raw",
    reportsDir: "reports",
    initialCapitalUsd: 10_000,
    riskPerTradePct: 0.5,
    costs: { minSpreadPoints: 0, commissionPerLotRoundTrip: 0, slippagePips: 0 },
    symbols: {
      US500: index,
      US30: index,
      US2000: index,
      EURUSD: { digits: 5, contractSize: 100_000, usdSide: "quote", swapLongPips: 0, swapShortPips: 0 },
    },
    usdExposureLimit: false,
  });
}

/**
 * Hourly bars on every weekday server day from `from` to `to` (holidays
 * included, as CFDs often trade then), flat at `price(time)` with a 2-point
 * range either side, so ATR(20) of D1 is 4 points.
 */
function series(from: string, to: string, price: (time: number) => number = () => 5000): Bar[] {
  const bars: Bar[] = [];
  for (let date = DateTime.fromISO(from); date <= DateTime.fromISO(to); date = date.plus({ days: 1 })) {
    if (date.weekday > 5) continue;
    const start = serverDay(date.toISODate() as string);
    for (let hour = 0; hour < 24; hour++) {
      const time = start + hour * HOUR;
      const p = price(time);
      bars.push(bar(time, p, p + 2, p - 2, p));
    }
  }
  return bars;
}

function run(strategy = turnOfMonthIndex, bars = series("2023-10-02", "2024-06-26")): BacktestResult {
  return runBacktest({
    data: INDEX_SYMBOLS.map((symbol) => symbolData(symbol, bars)),
    strategy,
    span: { start: (bars[0] as Bar).time, end: (bars.at(-1) as Bar).time + HOUR },
    config: config(),
  });
}

const times = (trades: readonly Trade[], symbol = "US500"): [number, number][] =>
  trades.filter((trade) => trade.symbol === symbol).map((trade) => [trade.entryTime, trade.exitTime]);

describe("turn-of-month windows on the NYSE calendar", () => {
  it("runs from the last trading day to the third of the next month", () => {
    expect(turnOfMonthWindow(2021, 5)).toEqual({ entryDay: "2021-05-28", lastDay: "2021-06-03" });
    expect(turnOfMonthWindow(2023, 12)).toEqual({ entryDay: "2023-12-29", lastDay: "2024-01-04" });
    expect(turnOfMonthWindow(2021, 12)).toEqual({ entryDay: "2021-12-31", lastDay: "2022-01-05" });
  });

  it("puts the control on trading days 10 to 13", () => {
    expect(midMonthWindow(2024, 1)).toEqual({ entryDay: "2024-01-16", lastDay: "2024-01-19" });
  });
});

describe("TurnOfMonthIndex on hand-made index bars", () => {
  const result = run();

  it("buys at the first bar of the last trading day and sells at the first bar after day +3", () => {
    expect(times(result.trades)).toEqual([
      [serverDay("2023-10-31"), serverDay("2023-11-06")],
      [serverDay("2023-11-30"), serverDay("2023-12-06")],
      [serverDay("2023-12-29"), serverDay("2024-01-05")],
      [serverDay("2024-01-31"), serverDay("2024-02-06")],
      [serverDay("2024-02-29"), serverDay("2024-03-06")],
      [serverDay("2024-03-28"), serverDay("2024-04-04")], // March 29 is Good Friday
      [serverDay("2024-04-30"), serverDay("2024-05-06")], // day +3 is a Friday: out on Monday
      [serverDay("2024-05-31"), serverDay("2024-06-06")],
    ]);
    expect(result.trades.every((trade) => trade.direction === "BUY" && trade.exitReason === "strategy")).toBe(true);
    // The June order is placed on the last bar of the data: nothing to enter.
    expect(result.skipped.map((item) => item.reason)).toEqual(["no-next-bar", "no-next-bar", "no-next-bar"]);
  });

  it("trades every index of the strategy the same way", () => {
    expect(times(result.trades, "US30")).toEqual(times(result.trades, "US500"));
    expect(times(result.trades, "US2000")).toEqual(times(result.trades, "US500"));
    expect(result.symbols).toEqual(["US500", "US30", "US2000"]);
  });

  it("sizes from a stop 2 x ATR(20) of D1 away", () => {
    const trade = result.trades.find((item) => item.symbol === "US500") as Trade;
    expect(trade.stopDistance).toBeCloseTo(8, 6);
    // 50 USD at 8 points of 10 USD a lot: 0.62 lot.
    expect(trade.lots).toBe(0.62);
  });

  it("does not buy on a holiday that comes just before the last trading day", () => {
    // 2022-05-30 is Memorial Day (bars exist); May 31 is the last trading day.
    const may = run(turnOfMonthIndex, series("2022-04-01", "2022-06-30"));
    expect(times(may.trades).find(([entry]) => entry >= serverDay("2022-05-01"))).toEqual([
      serverDay("2022-05-31"),
      serverDay("2022-06-06"),
    ]);
  });

  it("does not buy again after a stop inside the window", () => {
    // US500 falls 20 points on 2024-02-01 at 10:00 server, through the 8-point stop.
    const dropped = series("2023-10-02", "2024-06-26", (time) =>
      time >= serverDay("2024-02-01") + 10 * HOUR && time < serverDay("2024-02-02") ? 4980 : 5000,
    );
    const stopped = run(turnOfMonthIndex, dropped);
    const january = stopped.trades.filter(
      (trade) => trade.symbol === "US500" && trade.entryTime === serverDay("2024-01-31"),
    );
    expect(january.map((trade) => [trade.exitReason, trade.exitTime])).toEqual([
      ["stop", serverDay("2024-02-01") + 10 * HOUR],
    ]);
    expect(times(stopped.trades).filter(([entry]) => entry > serverDay("2024-01-31") && entry < serverDay("2024-02-29"))).toEqual([]);
  });
});

describe("MidMonthIndexControl", () => {
  it("holds the 10th to the 13th trading day", () => {
    const result = run(midMonthIndexControl);
    expect(times(result.trades).find(([entry]) => entry >= serverDay("2024-01-01"))).toEqual([
      serverDay("2024-01-16"),
      serverDay("2024-01-22"), // the 13th trading day is Friday January 19
    ]);
    expect(result.trades.every((trade) => trade.exitReason === "strategy")).toBe(true);
  });

  it("declares the same fixed parameters as the main strategy", () => {
    expect(midMonthIndexControl.params).toMatchObject({ atrPeriod: 20, atrMultiple: 2, leadDays: 5 });
    expect(turnOfMonthIndex.params).toMatchObject({ atrPeriod: 20, atrMultiple: 2, leadDays: 5 });
    expect(turnOfMonthIndex.executionTimeframe).toBe("H1");
  });
});
