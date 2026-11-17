import path from "node:path";
import {
  SYMBOLS,
  TIMEFRAMES,
  type Config,
  type SymbolName,
  type Timeframe,
} from "../config";
import type { SeriesId } from "./types";

/** Every series the TZ requires, in a stable order. */
export const ALL_SERIES: readonly SeriesId[] = SYMBOLS.flatMap((symbol) =>
  TIMEFRAMES.map((timeframe) => ({ symbol, timeframe })),
);

/** File name fixed by the TZ, e.g. EURUSD_H1.csv. */
export function seriesFileName(id: SeriesId): string {
  return `${id.symbol}_${id.timeframe}.csv`;
}

export function seriesFilePath(config: Config, id: SeriesId): string {
  return path.resolve(config.dataDir, seriesFileName(id));
}

/**
 * Recognises both the TZ name (EURUSD_H1.csv) and the name MT5 gives an export
 * (EURUSD_H1_201501050000_202611160000.csv, with "Daily" for D1).
 * Returns null for anything else, including timeframes the project does not use.
 */
export function detectSeriesFromFileName(fileName: string): SeriesId | null {
  const match = /^([A-Za-z]+)_([A-Za-z0-9]+)(?:_\d{12}_\d{12})?\.csv$/i.exec(
    path.basename(fileName),
  );
  if (match === null) {
    return null;
  }
  const symbol = (match[1] ?? "").toUpperCase();
  const rawTimeframe = (match[2] ?? "").toUpperCase();
  const timeframe = rawTimeframe === "DAILY" ? "D1" : rawTimeframe;
  if (
    !(SYMBOLS as readonly string[]).includes(symbol) ||
    !(TIMEFRAMES as readonly string[]).includes(timeframe)
  ) {
    return null;
  }
  return { symbol: symbol as SymbolName, timeframe: timeframe as Timeframe };
}
