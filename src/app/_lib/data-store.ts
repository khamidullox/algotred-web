// Server-side access to the data files for pages and route handlers.
// Nothing here computes anything about the market: it reads files and calls the engine.
import { statSync } from "node:fs";
import type { Config, SymbolName, Timeframe } from "../../config";
import { ALL_SERIES, seriesFileName, seriesFilePath } from "../../data/files";
import { readSeriesInput, type SeriesInput } from "../../data/load";
import type { SeriesId } from "../../data/types";
import { validateData, type ValidationReport } from "../../data/validate";

export interface SeriesFile {
  symbol: SymbolName;
  timeframe: Timeframe;
  file: string;
  present: boolean;
  sizeBytes: number;
  modifiedMs: number;
}

function signature(config: Config, id: SeriesId): string {
  try {
    const stat = statSync(seriesFilePath(config, id));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

export function listSeriesFiles(config: Config): SeriesFile[] {
  return ALL_SERIES.map((id) => {
    const base = {
      symbol: id.symbol,
      timeframe: id.timeframe,
      file: seriesFileName(id),
    };
    try {
      const stat = statSync(seriesFilePath(config, id));
      return {
        ...base,
        present: true,
        sizeBytes: stat.size,
        modifiedMs: stat.mtimeMs,
      };
    } catch {
      return { ...base, present: false, sizeBytes: 0, modifiedMs: 0 };
    }
  });
}

// Parsing a 12-year M15 file takes about a second, so the last few results are
// kept while the file on disk is unchanged.
const MAX_CACHED_SERIES = 2;
const seriesCache = new Map<string, { key: string; input: SeriesInput }>();

export function getSeries(config: Config, id: SeriesId): SeriesInput {
  const name = seriesFileName(id);
  const key = `${config.brokerTimeZone}|${signature(config, id)}`;
  const cached = seriesCache.get(name);
  if (cached?.key === key) {
    return cached.input;
  }
  const input = readSeriesInput(config, id);
  seriesCache.delete(name);
  seriesCache.set(name, { key, input });
  while (seriesCache.size > MAX_CACHED_SERIES) {
    const oldest = seriesCache.keys().next().value;
    if (oldest === undefined) break;
    seriesCache.delete(oldest);
  }
  return input;
}

let reportCache: { key: string; report: ValidationReport } | null = null;

export function getValidationReport(config: Config): ValidationReport {
  const key = [
    config.brokerTimeZone,
    config.dataDir,
    ...ALL_SERIES.map((id) => signature(config, id)),
  ].join("|");
  if (reportCache?.key === key) {
    return reportCache.report;
  }
  const report = validateData(config);
  reportCache = { key, report };
  return report;
}
