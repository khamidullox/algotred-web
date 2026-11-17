import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import type { Config, Dataset } from "../config";
import type { BacktestResult } from "../engine/types";
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
    ...result,
  };
}

/**
 * Writes run.json and trades.csv into `<reportsDir>/<dataset>/<time>_<strategy>/`.
 * The report of step 6 will be written next to them.
 */
export function saveRun(run: SavedRun, reportsDir: string): RunLocation {
  const id = runId(run);
  const directory = path.resolve(reportsDir, id);
  mkdirSync(directory, { recursive: true });
  const runFile = path.join(directory, "run.json");
  const tradesFile = path.join(directory, "trades.csv");
  writeFileSync(runFile, JSON.stringify(run, null, 2));
  writeFileSync(tradesFile, tradesToCsv(run.trades, run.brokerTimeZone));
  return { id, directory, runFile, tradesFile };
}
