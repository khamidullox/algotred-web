import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import type { Config, Dataset } from "../config";
import type { BacktestResult } from "../engine/types";
import type { Report } from "./build-report";
import { tradesToCsv } from "./trades-csv";

export const RUN_FILE_VERSION = 1;

/** What a run directory stores in run.json: the engine result plus how it was produced. */
export interface SavedRun extends BacktestResult {
  readonly version: number;
  /** When the run finished, UTC ms. */
  readonly finishedAt: number;
  readonly dataset: Dataset;
  readonly costs: Config["costs"];
  readonly initialCapitalUsd: number;
  readonly riskPerTradePct: number;
  /** Cost settings an instrument of the run overrides (TZ 17.6); absent in older runs. */
  readonly symbolCosts?: Readonly<Record<string, SymbolCostNote>>;
}

/** The per-instrument overrides of the cost defaults, as the config gives them. */
export interface SymbolCostNote {
  readonly minSpreadPoints?: number;
  readonly commissionPerLotRoundTrip?: number;
  readonly slippagePoints?: number;
  readonly tripleSwapDay?: "wednesday" | "friday";
  readonly swapReferencePrice?: number;
}

function symbolCostNotes(
  config: Config,
  symbols: readonly string[],
): Record<string, SymbolCostNote> {
  const notes: Record<string, SymbolCostNote> = {};
  for (const symbol of symbols) {
    const own = config.symbols[symbol];
    if (own === undefined) continue;
    const note: SymbolCostNote = {
      ...(own.minSpreadPoints === undefined ? {} : { minSpreadPoints: own.minSpreadPoints }),
      ...(own.commissionPerLotRoundTrip === undefined
        ? {}
        : { commissionPerLotRoundTrip: own.commissionPerLotRoundTrip }),
      ...(own.slippagePoints === undefined ? {} : { slippagePoints: own.slippagePoints }),
      ...(own.tripleSwapDay === undefined ? {} : { tripleSwapDay: own.tripleSwapDay }),
      ...(own.swapReferencePrice === undefined ? {} : { swapReferencePrice: own.swapReferencePrice }),
    };
    if (Object.keys(note).length > 0) notes[symbol] = note;
  }
  return notes;
}

export interface RunLocation {
  /** Directory of the run, relative to the reports directory: `dev/2026-11-17_12-30-00_TrendD1`. */
  readonly id: string;
  readonly directory: string;
  readonly runFile: string;
  readonly tradesFile: string;
}

export function runId(run: Pick<SavedRun, "dataset" | "finishedAt" | "strategy">): string {
  const stamp = DateTime.fromMillis(run.finishedAt, { zone: "utc" }).toFormat(
    "yyyy-LL-dd_HH-mm-ss",
  );
  return `${run.dataset}/${stamp}_${run.strategy}`;
}

export function toSavedRun(
  result: BacktestResult,
  dataset: Dataset,
  config: Config,
  finishedAt: number,
): SavedRun {
  return {
    version: RUN_FILE_VERSION,
    finishedAt,
    dataset,
    costs: config.costs,
    initialCapitalUsd: config.initialCapitalUsd,
    riskPerTradePct: config.riskPerTradePct,
    symbolCosts: symbolCostNotes(config, result.symbols),
    ...result,
  };
}

/** Writes run.json and trades.csv into `<reportsDir>/<dataset>/<time>_<strategy>/`. */
export function saveRun(run: SavedRun, config: Config): RunLocation {
  const id = runId(run);
  const directory = path.resolve(config.reportsDir, id);
  mkdirSync(directory, { recursive: true });
  const runFile = path.join(directory, "run.json");
  const tradesFile = path.join(directory, "trades.csv");
  writeFileSync(runFile, JSON.stringify(run, null, 2));
  writeFileSync(tradesFile, tradesToCsv(run.trades, run.brokerTimeZone, config));
  return { id, directory, runFile, tradesFile };
}

export const REPORT_JSON = "report.json";
export const REPORT_MD = "report.md";

/** Writes report.json and report.md next to run.json. */
export function saveReport(
  report: Report,
  markdown: string,
  directory: string,
): { readonly jsonFile: string; readonly markdownFile: string } {
  const jsonFile = path.join(directory, REPORT_JSON);
  const markdownFile = path.join(directory, REPORT_MD);
  writeFileSync(jsonFile, JSON.stringify(report, null, 2));
  writeFileSync(markdownFile, markdown);
  return { jsonFile, markdownFile };
}
