import { describe, expect, it } from "vitest";
import type { BacktestResult, Trade } from "../src/engine/types";
import { buildReport } from "../src/report/build-report";
import { formatReport } from "../src/report/format-report";
import {
  bootstrapMeanR,
  breakdown,
  computeMetrics,
  excursions,
  GROSS,
  hourUtc,
  inCustomerWindow,
  isFridayAfternoonLondon,
  isMondayMorningLondon,
  mulberry32,
  weekdayIn,
  yearUtc,
} from "../src/report/metrics";
import type { SavedRun } from "../src/report/save-run";
import { decide } from "../src/report/verdict";
import { at, testConfig } from "./helpers/bars";

let counter = 0;

/** A closed trade with a 50 USD risk; `net` is the result after costs, gross = net + 1 unless given. */
function trade(net: number, overrides: Partial<Trade> = {}): Trade {
  counter++;
  const entryTime = overrides.entryTime ?? at("2024-05-06T10:00") + counter * 3_600_000;
  return {
    symbol: "EURUSD",
    direction: "BUY",
    reason: "test",
    signalTime: entryTime,
    entryTime,
    entryPrice: 1.1,
    stopLoss: 1.098,
    takeProfit: null,
    stopDistance: 0.002,
    lots: 0.25,
    riskUsd: 50,
    exitTime: entryTime + 3_600_000,
    exitPrice: 1.1,
    exitReason: "strategy",
    stopAtExit: 1.098,
    breakevenTime: null,
    nights: 0,
    maePrice: 0.001,
    mfePrice: 0.001,
    maeR: 0.5,
    mfeR: 0.5,
    grossPnlUsd: net + 1,
    spreadCostUsd: 1,
    slippageCostUsd: 0,
    commissionUsd: 0,
    swapUsd: 0,
    netPnlUsd: net,
    rMultiple: net / 50,
    balanceAfter: 0,
    ...overrides,
  };
}

describe("computeMetrics", () => {
  const trades = [trade(100), trade(-50), trade(-50), trade(25)];
  const metrics = computeMetrics(trades, 10_000);

  it("counts wins, losses and the win rate", () => {
    expect(metrics.trades).toBe(4);
    expect(metrics.wins).toBe(2);
    expect(metrics.losses).toBe(2);
    expect(metrics.winRate).toBe(0.5);
  });

  it("computes mean R and the expectancy, which agree", () => {
    // R: +2, -1, -1, +0.5 -> mean 0.125; 0.5 * 1.25 - 0.5 * 1 = 0.125.
    expect(metrics.meanR).toBeCloseTo(0.125, 12);
    expect(metrics.expectancyR).toBeCloseTo(0.125, 12);
    expect(metrics.meanUsd).toBeCloseTo(6.25, 12);
    expect(metrics.totalUsd).toBe(25);
  });

  it("computes the profit factor", () => {
    expect(metrics.profitFactor).toBeCloseTo(1.25, 12);
    expect(computeMetrics([trade(10), trade(20)], 10_000).profitFactor).toBe(Infinity);
    expect(computeMetrics([trade(-10)], 10_000).profitFactor).toBe(0);
  });

  it("computes the drawdown from the peak and the longest losing streak", () => {
    // 10 000 -> 10 100 (peak) -> 10 050 -> 10 000 -> 10 025: 100 USD below the peak.
    expect(metrics.maxDrawdownUsd).toBeCloseTo(100, 9);
    expect(metrics.maxDrawdownPct).toBeCloseTo(100 / 10_100, 12);
    expect(metrics.longestLosingStreak).toBe(2);
    expect(metrics.finalBalance).toBe(10_025);
  });

  it("walks the trades in exit order whatever the input order", () => {
    const shuffled = [trades[3], trades[1], trades[0], trades[2]] as Trade[];
    expect(computeMetrics(shuffled, 10_000)).toEqual(metrics);
  });

  it("can be computed before costs", () => {
    const gross = computeMetrics(trades, 10_000, GROSS);
    expect(gross.totalUsd).toBe(29);
  });

  it("is empty without trades", () => {
    const empty = computeMetrics([], 10_000);
    expect(empty.trades).toBe(0);
    expect(empty.winRate).toBeNull();
    expect(empty.profitFactor).toBeNull();
    expect(empty.finalBalance).toBe(10_000);
  });
});

describe("breakdowns and time windows", () => {
  it("groups by symbol in the given order", () => {
    const rows = breakdown(
      [trade(1, { symbol: "USDJPY" }), trade(2), trade(-3, { symbol: "USDJPY" })],
      10_000,
      (item) => item.symbol,
      ["EURUSD", "GBPUSD", "USDJPY"],
    );
    expect(rows.map((row) => [row.key, row.metrics.trades, row.metrics.totalUsd])).toEqual([
      ["EURUSD", 1, 2],
      ["USDJPY", 2, -2],
    ]);
  });

  it("takes year and hour from the entry time in UTC and the weekday in server time", () => {
    const item = trade(0, { entryTime: Date.UTC(2023, 11, 31, 23, 30) });
    expect(yearUtc(item)).toBe("2023");
    expect(hourUtc(item)).toBe("23");
    expect(weekdayIn("UTC")(item)).toBe("Вс");
    // 23:30 UTC on Sunday is already Monday 01:30 in Athens.
    expect(weekdayIn("Europe/Athens")(item)).toBe("Пн");
  });

  it("finds the customer window in Tashkent time (UTC+5), both ends included", () => {
    const entry = (hour: number, minute: number): Trade =>
      trade(0, { entryTime: Date.UTC(2024, 4, 6, hour, minute) });
    expect(inCustomerWindow(entry(14, 0))).toBe(true); // 19:00 Tashkent
    expect(inCustomerWindow(entry(15, 45))).toBe(true); // 20:45
    expect(inCustomerWindow(entry(16, 0))).toBe(true); // 21:00
    expect(inCustomerWindow(entry(16, 15))).toBe(false); // 21:15
    expect(inCustomerWindow(entry(13, 45))).toBe(false); // 18:45
  });

  it("finds Monday mornings and Friday afternoons in London time", () => {
    // 2024-05-06 is a Monday in British Summer Time (UTC+1).
    const monday = (hour: number, minute = 0): Trade =>
      trade(0, { entryTime: Date.UTC(2024, 4, 6, hour, minute) });
    expect(isMondayMorningLondon(monday(8))).toBe(true); // 09:00 London
    expect(isMondayMorningLondon(monday(10, 45))).toBe(true); // 11:45
    expect(isMondayMorningLondon(monday(11))).toBe(false); // 12:00
    const friday = (hour: number, minute = 0): Trade =>
      trade(0, { entryTime: Date.UTC(2024, 4, 10, hour, minute) });
    expect(isFridayAfternoonLondon(friday(11))).toBe(false); // 12:00
    expect(isFridayAfternoonLondon(friday(11, 15))).toBe(true); // 12:15
    expect(isFridayAfternoonLondon(friday(20))).toBe(true); // 21:00
    // In January London is on UTC: 2024-01-08 is a Monday.
    expect(isMondayMorningLondon(trade(0, { entryTime: Date.UTC(2024, 0, 8, 11, 59) }))).toBe(true);
    expect(isMondayMorningLondon(trade(0, { entryTime: Date.UTC(2024, 0, 8, 12, 0) }))).toBe(false);
  });
});

describe("excursions", () => {
  it("summarises MAE and MFE in R for all trades, wins and losses", () => {
    const trades = [
      trade(100, { maeR: 0.2, mfeR: 2 }),
      trade(-50, { maeR: 1, mfeR: 1.2 }),
      trade(-50, { maeR: 1, mfeR: 0.3 }),
      trade(25, { maeR: 0.6, mfeR: 0.9 }),
    ];
    const stats = excursions(trades);
    expect(stats?.all).toEqual({
      trades: 4,
      medianMaeR: 0.8,
      medianMfeR: 1.05,
      mfeAtLeastHalfR: 0.75,
      mfeAtLeast1R: 0.5,
      maeAtLeastHalfR: 0.75,
    });
    expect(stats?.wins.trades).toBe(2);
    expect(stats?.losses.mfeAtLeast1R).toBe(0.5);
    expect(stats?.losses.medianMfeR).toBe(0.75);
  });

  it("is null for a run saved before the fields existed, and empty-safe", () => {
    const { maeR: _dropped, ...old } = trade(1);
    void _dropped;
    expect(excursions([old as Trade])).toBeNull();
    expect(excursions([])?.all.medianMaeR).toBeNull();
  });
});

describe("bootstrap", () => {
  it("is deterministic for a seed and brackets the mean", () => {
    const random = mulberry32(42);
    const values = Array.from({ length: 300 }, () => (random() - 0.4) * 3);
    const first = bootstrapMeanR(values, 2_000, 7);
    const second = bootstrapMeanR(values, 2_000, 7);
    expect(first).toEqual(second);
    expect(first?.lower).toBeLessThan(first?.meanR as number);
    expect(first?.upper).toBeGreaterThan(first?.meanR as number);
    expect(bootstrapMeanR(values, 2_000, 8)).not.toEqual(first);
  });

  it("collapses to the value for a constant sample and is null without data", () => {
    const constant = bootstrapMeanR([0.5, 0.5, 0.5], 100, 1);
    expect(constant?.lower).toBe(0.5);
    expect(constant?.upper).toBe(0.5);
    expect(bootstrapMeanR([], 100, 1)).toBeNull();
  });
});

describe("verdict by TZ section 10", () => {
  const symbols = (...totals: number[]) =>
    totals.map((total, index) => ({
      key: ["EURUSD", "GBPUSD", "USDJPY"][index] as string,
      metrics: computeMetrics([trade(total)], 10_000),
    }));
  const block = (overrides: Partial<ReturnType<typeof computeMetrics>>) => ({
    ...computeMetrics([trade(10)], 10_000),
    ...overrides,
  });
  const ci = { repeats: 10, seed: 1, meanR: 0.2, lower: 0.05, upper: 0.35 };

  it("continues when every criterion is in the continue column", () => {
    const verdict = decide(
      block({ trades: 250, profitFactor: 1.3, maxDrawdownPct: 0.1, expectancyR: 0.2 }),
      symbols(100, 50, -10),
      ci,
      "BreakoutRetestV1-A",
      "test",
    );
    expect(verdict.code).toBe("CONTINUE");
    expect(verdict.applies).toBe(true);
    expect(verdict.criteria.map((criterion) => criterion.status)).toEqual([
      "continue", "continue", "continue", "continue", "continue", "continue",
    ]);
  });

  it("rejects on one criterion in the reject column", () => {
    const few = decide(
      block({ trades: 80, profitFactor: 1.3, maxDrawdownPct: 0.1, expectancyR: 0.2 }),
      symbols(100, 50, -10),
      ci,
      "BreakoutRetestV1-B",
      "test",
    );
    expect(few.code).toBe("REJECT");
    const allPairsNegative = decide(
      block({ trades: 250, profitFactor: 1.3, maxDrawdownPct: 0.1, expectancyR: 0.2 }),
      symbols(-1, -2, -3),
      ci,
      "BreakoutRetestV1-A",
      "test",
    );
    expect(allPairsNegative.code).toBe("REJECT");
  });

  it("is inconclusive between the columns", () => {
    const verdict = decide(
      block({ trades: 150, profitFactor: 1.1, maxDrawdownPct: 0.17, expectancyR: 0.05 }),
      symbols(100, -50, -10),
      { ...ci, lower: -0.01 },
      "BreakoutRetestV1-A",
      "test",
    );
    expect(verdict.code).toBe("INCONCLUSIVE");
    expect(verdict.criteria.map((criterion) => criterion.status)).toEqual([
      "between", "between", "between", "continue", "between", "between",
    ]);
  });

  it("marks the verdict as informational for TrendD1 and for other datasets", () => {
    const main = block({ trades: 250, profitFactor: 1.3, maxDrawdownPct: 0.1, expectancyR: 0.2 });
    expect(decide(main, symbols(1, 1, 1), ci, "TrendD1", "test").applies).toBe(false);
    expect(decide(main, symbols(1, 1, 1), ci, "BreakoutRetestV1-A", "dev").applies).toBe(false);
    expect(decide(main, symbols(1, 1, 1), ci, "BreakoutRetestV1-A", "dev").note).toContain("dev");
  });
});

describe("buildReport and formatReport", () => {
  const config = testConfig();
  const trades = [
    trade(100, { symbol: "EURUSD" }),
    trade(-50, { symbol: "GBPUSD" }),
    trade(30, { symbol: "USDJPY", exitReason: "end-of-data" }),
  ];
  const base: BacktestResult = {
    strategy: "TrendD1",
    params: { entryLookback: 55 },
    executionTimeframe: "H1",
    span: { start: at("2024-05-06T00:00"), end: at("2024-05-11T00:00") },
    brokerTimeZone: "Europe/Athens",
    initialBalance: 10_000,
    finalBalance: 10_080,
    costMultiplier: 1,
    usdExposureLimit: false,
    swapAccounted: false,
    trades,
    skipped: [
      { symbol: "EURUSD", direction: "BUY", signalTime: 0, reason: "lot-too-small", detail: "" },
    ],
  };
  const run: SavedRun = {
    version: 1,
    finishedAt: Date.UTC(2026, 10, 17, 12, 0, 0),
    dataset: "dev",
    costs: config.costs,
    initialCapitalUsd: 10_000,
    riskPerTradePct: 0.5,
    ...base,
  };
  const stress: BacktestResult = { ...base, costMultiplier: 2, trades: [trade(90), trade(-60)] };
  const flipped: BacktestResult = {
    ...base,
    usdExposureLimit: true,
    trades: [trade(100)],
    skipped: [
      { symbol: "GBPUSD", direction: "BUY", signalTime: 0, reason: "usd-exposure", detail: "" },
    ],
  };
  const report = buildReport({ run, stress, exposureFlipped: flipped });

  it("carries the headline metrics, the stress test and both exposure settings", () => {
    expect(report.afterCosts.trades).toBe(3);
    expect(report.afterCosts.totalUsd).toBe(80);
    expect(report.beforeCosts.totalUsd).toBe(83);
    expect(report.stress.afterCosts.totalUsd).toBe(30);
    expect(report.exposure.withoutLimit.totalUsd).toBe(80);
    expect(report.exposure.withLimit.totalUsd).toBe(100);
    expect(report.exposure.skippedByLimit).toBe(1);
    expect(report.bySymbol.map((row) => row.key)).toEqual(["EURUSD", "GBPUSD", "USDJPY"]);
    expect(report.skipped).toEqual([{ reason: "lot-too-small", count: 1 }]);
  });

  it("warns about swap, zero costs and positions closed by the end of data", () => {
    expect(report.warnings).toHaveLength(3);
    expect(report.warnings[0]).toContain("Своп");
  });

  it("prints every section", () => {
    const text = formatReport(report);
    for (const heading of [
      "## Вердикт: ",
      "## Итог",
      "## Лимит по доллару",
      "## По парам",
      "## По годам входа (UTC)",
      "## По часу входа (UTC)",
      "## По дню недели входа (время сервера Europe/Athens)",
      "## Окно заказчика и фильтры по времени",
      "## Параметры",
    ]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("Стресс-тест (издержки × 2)");
    expect(text).toContain("entryLookback: 55");
  });

  it("survives a run without trades", () => {
    const empty = buildReport({
      run: { ...run, trades: [], skipped: [] },
      stress: { ...stress, trades: [] },
      exposureFlipped: { ...flipped, trades: [], skipped: [] },
    });
    expect(empty.bootstrap).toBeNull();
    expect(empty.verdict.code).toBe("REJECT");
    expect(formatReport(empty)).toContain("Сделок нет.");
  });
});
