// Server-side access to saved runs in the reports directory.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DATASETS, type Config, type Dataset } from "../../config";
import { describeSpan } from "../../data/split";
import type { Report } from "../../report/build-report";
import { REPORT_JSON, REPORT_MD, type SavedRun } from "../../report/save-run";
import type { ChartOrder, ChartTrade, RunResponse, RunSummary } from "./api-types";
import { parseReason } from "./trade-reason";
import { newsBreakdown, type NewsBreakdown } from "../../report/news";
import { getCalendar } from "./data-store";

/** `dev/2026-11-17_12-30-00_TrendD1`; anything else is refused before touching the disk. */
const RUN_ID = /^(dev|test|holdout)\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_[A-Za-z0-9-]+$/;

export function isRunId(id: string): boolean {
  return RUN_ID.test(id);
}

function readSavedRun(file: string): SavedRun | null {
  try {
    const run = JSON.parse(readFileSync(file, "utf8")) as Partial<SavedRun>;
    return run.version === 1 && Array.isArray(run.trades) ? (run as SavedRun) : null;
  } catch {
    return null;
  }
}

function summarize(id: string, run: SavedRun): RunSummary {
  const days = describeSpan(run.span, run.brokerTimeZone);
  return {
    id,
    strategy: run.strategy,
    dataset: run.dataset,
    finishedAt: run.finishedAt,
    trades: run.trades.length,
    firstDay: days.firstDay,
    lastDay: days.lastDay,
  };
}

/** Every run with a readable run.json, newest first. */
export function listRuns(config: Config): RunSummary[] {
  const runs: RunSummary[] = [];
  for (const dataset of DATASETS as readonly Dataset[]) {
    const directory = path.resolve(config.reportsDir, dataset);
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const id = `${dataset}/${name}`;
      const file = path.join(directory, name, "run.json");
      if (!isRunId(id) || !existsSync(file) || !statSync(file).isFile()) continue;
      const run = readSavedRun(file);
      if (run !== null) runs.push(summarize(id, run));
    }
  }
  return runs.sort((a, b) => b.finishedAt - a.finishedAt);
}

/** The report of a run, or null when the run has none (an older run or an unknown id). */
export function readReport(config: Config, id: string): Report | null {
  if (!isRunId(id)) return null;
  const file = path.resolve(config.reportsDir, id, REPORT_JSON);
  if (!existsSync(file)) return null;
  try {
    const report = JSON.parse(readFileSync(file, "utf8")) as Partial<Report>;
    return report.version === 1 && report.afterCosts !== undefined ? (report as Report) : null;
  } catch {
    return null;
  }
}

/** The Markdown of a report, as written by the CLI. */
export function readReportMarkdown(config: Config, id: string): string | null {
  if (!isRunId(id)) return null;
  const file = path.resolve(config.reportsDir, id, REPORT_MD);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export interface ReportListItem {
  readonly summary: RunSummary;
  readonly report: Report | null;
}

/** Every run with its report when it has one, newest first. */
export function listReports(config: Config): ReportListItem[] {
  return listRuns(config).map((summary) => ({
    summary,
    report: readReport(config, summary.id),
  }));
}

/**
 * The news section for a run whose report predates it (2026-11-19), worked
 * out from its trades and the calendar. Null without a run or a calendar.
 */
export function newsForRun(config: Config, id: string): NewsBreakdown | null {
  if (!isRunId(id)) return null;
  const file = path.resolve(config.reportsDir, id, "run.json");
  if (!existsSync(file)) return null;
  const run = readSavedRun(file);
  const calendar = getCalendar(config);
  if (run === null || calendar.events.length === 0) return null;
  return newsBreakdown(run.trades, calendar.events, run.initialBalance, run.span, run.symbols ?? [...new Set(run.trades.map((trade) => trade.symbol))]);
}

/** The trades of one run in the shape the chart draws. Null when the id is unknown. */
export function readRun(config: Config, id: string): RunResponse | null {
  if (!isRunId(id)) return null;
  const file = path.resolve(config.reportsDir, id, "run.json");
  if (!existsSync(file)) return null;
  const run = readSavedRun(file);
  if (run === null) return null;
  const trades: ChartTrade[] = run.trades.map((trade, index) => ({
    n: index + 1,
    symbol: trade.symbol,
    direction: trade.direction,
    entryTime: trade.entryTime / 1000,
    entryPrice: trade.entryPrice,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    exitTime: trade.exitTime / 1000,
    exitPrice: trade.exitPrice,
    exitReason: trade.exitReason,
    // Runs saved before partial closes existed have no such fields.
    partialTime: trade.partialTime == null || trade.partialPrice == null ? null : trade.partialTime / 1000,
    partialPrice: trade.partialTime == null ? null : (trade.partialPrice ?? null),
    lots: trade.lots,
    netPnlUsd: trade.netPnlUsd,
    rMultiple: trade.rMultiple,
    reason: trade.reason,
    marks: parseReason(trade.reason, run.brokerTimeZone),
  }));
  const orders: ChartOrder[] = (run.skipped ?? []).flatMap((skip) =>
    skip.order === undefined
      ? []
      : [
          {
            symbol: skip.symbol,
            direction: skip.direction,
            kind: skip.order.kind,
            price: skip.order.price,
            placedTime: skip.signalTime / 1000,
            endTime: skip.order.endTime / 1000,
            detail: skip.detail,
            marks: parseReason(skip.order.reason, run.brokerTimeZone),
          },
        ],
  );
  return { summary: summarize(id, run), brokerTimeZone: run.brokerTimeZone, trades, orders };
}
