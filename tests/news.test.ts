import { describe, expect, it } from "vitest";
import type { NewsEvent } from "../src/data/calendar";
import { runBacktest } from "../src/engine/backtest";
import type { MarketContext, Strategy } from "../src/engine/types";
import { newsBreakdown, newsGroup } from "../src/report/news";
import { at, flatBars, symbolData, testConfig } from "./helpers/bars";

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
    actual: 206,
    forecast: 190,
    previous: 218,
    revisedPrevious: 210,
    ...overrides,
  };
}

describe("ctx.news", () => {
  it("shows the schedule ahead and the figures only from the release time", () => {
    const seen: string[] = [];
    const strategy: Strategy = {
      name: "NewsReader",
      params: {},
      executionTimeframe: "M15",
      create: () => ({
        onBarClose(ctx: MarketContext) {
          const [release] = ctx.news(ctx.now - 3_600_000, ctx.now + 3_600_000, { currencies: ["USD"] });
          seen.push(release === undefined ? "none" : `${release.code} actual=${release.actual} revised=${release.revisedPrevious} forecast=${release.forecast}`);
          return null;
        },
      }),
    };
    const bars = flatBars("M15", "2024-01-05T15:00", 4, 1.1);
    runBacktest({
      data: [symbolData("EURUSD", bars)],
      strategy,
      span: { start: at("2024-01-05T15:00"), end: at("2024-01-05T16:00") },
      config: testConfig(),
      news: [event("2024-01-05T15:30"), event("2024-01-05T15:30", { currency: "EUR", code: "other" })],
    });
    // Closes at 15:15 and 15:30 (release), 15:45, 16:00.
    expect(seen).toEqual([
      "nonfarm-payrolls actual=null revised=null forecast=190",
      "nonfarm-payrolls actual=206 revised=210 forecast=190",
      "nonfarm-payrolls actual=206 revised=210 forecast=190",
      "nonfarm-payrolls actual=206 revised=210 forecast=190",
    ]);
  });

  it("is empty without a calendar", () => {
    let count = -1;
    const strategy: Strategy = {
      name: "NoNews",
      params: {},
      executionTimeframe: "M15",
      create: () => ({
        onBarClose(ctx: MarketContext) {
          count = ctx.news(0, Number.MAX_SAFE_INTEGER).length;
          return null;
        },
      }),
    };
    runBacktest({
      data: [symbolData("EURUSD", flatBars("M15", "2024-01-05T15:00", 1, 1.1))],
      strategy,
      span: { start: at("2024-01-05T15:00"), end: at("2024-01-05T15:15") },
      config: testConfig(),
    });
    expect(count).toBe(0);
  });
});

describe("trades against the news", () => {
  const events = [event("2024-01-05T15:30"), event("2024-01-05T18:00", { importance: "MODERATE" }), event("2024-01-08T11:00", { currency: "EUR" })];
  const trade = (symbol: string, entry: string, exit: string) => ({ symbol, entryTime: at(entry), exitTime: at(exit) });

  it("puts an entry within 30 minutes of an important release of the instrument's currencies near it", () => {
    expect(newsGroup(trade("EURUSD", "2024-01-05T15:00", "2024-01-05T15:10"), events)).toBe("near");
    expect(newsGroup(trade("EURUSD", "2024-01-05T16:00", "2024-01-05T17:00"), events)).toBe("near");
    expect(newsGroup(trade("XAUUSD", "2024-01-05T15:45", "2024-01-05T17:00"), events)).toBe("near");
    expect(newsGroup(trade("USDJPY", "2024-01-05T16:01", "2024-01-05T17:00"), events)).toBe("clear");
  });

  it("separates trades that only held through a release, and ignores other currencies and lower importance", () => {
    expect(newsGroup(trade("EURUSD", "2024-01-05T12:00", "2024-01-05T16:00"), events)).toBe("during");
    expect(newsGroup(trade("EURUSD", "2024-01-05T17:00", "2024-01-05T19:00"), events)).toBe("clear");
    expect(newsGroup(trade("USDJPY", "2024-01-08T10:45", "2024-01-08T12:00"), events)).toBe("clear");
    expect(newsGroup(trade("EURUSD", "2024-01-08T10:45", "2024-01-08T12:00"), events)).toBe("near");
  });

  it("counts the groups and the important releases of the run", () => {
    const base = { direction: "BUY", netPnlUsd: 10, grossPnlUsd: 12, riskUsd: 50, rMultiple: 0.2 };
    const trades = [trade("EURUSD", "2024-01-05T15:00", "2024-01-05T15:10"), trade("EURUSD", "2024-01-05T17:00", "2024-01-05T19:00")].map((item) => ({ ...base, ...item }));
    const result = newsBreakdown(trades as never, events, 10_000, { start: at("2024-01-01T00:00"), end: at("2024-02-01T00:00") }, ["EURUSD"]);
    expect([result.near.trades, result.during.trades, result.clear.trades, result.events]).toEqual([1, 0, 1, 2]);
  });
});
