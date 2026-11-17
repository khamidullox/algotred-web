import path from "node:path";
import { TIMEFRAMES, symbolNames, type Config, type Timeframe } from "../config";
import type { SeriesId } from "./types";

/** Every series the config asks for, in a stable order: symbols as configured, timeframes D1, H1, M15. */
export function allSeries(config: Config): SeriesId[] {
  return symbolNames(config).flatMap((symbol) =>
    TIMEFRAMES.map((timeframe) => ({ symbol, timeframe })),
  );
}

/** File name fixed by the TZ, e.g. EURUSD_H1.csv. */
export function seriesFileName(id: SeriesId): string {
  return `${id.symbol}_${id.timeframe}.csv`;
}

export function seriesFilePath(config: Config, id: SeriesId): string {
  return path.resolve(config.dataDir, seriesFileName(id));
}

/**
 * Recognises both the TZ name (EURUSD_H1.csv) and the name MT5 gives an export
 * (EURUSD_H1_201501050000_202611160000.csv, with "Daily" for D1), for the
 * configured symbols only. Returns null for anything else, including
 * timeframes the project does not use.
 */
export function detectSeriesFromFileName(
  fileName: string,
  symbols: readonly string[],
): SeriesId | null {
  const match = /^([A-Za-z0-9]+)_([A-Za-z0-9]+)(?:_\d{12}_\d{12})?\.csv$/i.exec(
    path.basename(fileName),
  );
  if (match === null) {
    return null;
  }
  const symbol = (match[1] ?? "").toUpperCase();
  const rawTimeframe = (match[2] ?? "").toUpperCase();
  const timeframe = rawTimeframe === "DAILY" ? "D1" : rawTimeframe;
  if (
    !symbols.includes(symbol) ||
    !(TIMEFRAMES as readonly string[]).includes(timeframe)
  ) {
    return null;
  }
  return { symbol, timeframe: timeframe as Timeframe };
}
