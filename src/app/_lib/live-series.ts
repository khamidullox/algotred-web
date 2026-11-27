// The candles the MT5 indicator tools/mt5/Rsi2IndexSignal.mq5 passes to the
// site's charts (TZ 17.52): one file per symbol and timeframe in the format of
// MT5's own export, in the terminal's common Files folder. Server-side only.
// Charts read them; backtests and validation never do: they keep to the
// project's own export files in the data folder.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Timeframe } from "../../config";
import { decodeMt5File, Mt5CsvFormatError, parseMt5Csv } from "../../data/mt5-csv";
import { createServerTimeConverter } from "../../data/time";
import type { Bar } from "../../data/types";

/** The folder inside the terminal's common Files folder. */
export const LIVE_FOLDER = "algotred_live";

/** Where the indicator writes on this computer; null outside Windows. */
export function defaultLiveDir(): string | null {
  const appData = process.env.APPDATA;
  if (appData === undefined || appData === "") return null;
  return path.join(appData, "MetaQuotes", "Terminal", "Common", "Files", LIVE_FOLDER);
}

export interface LiveSeries {
  readonly file: string;
  /** Closed bars, oldest first, each later than the one before. */
  readonly bars: readonly Bar[];
  /** When the indicator last wrote the file, by this computer's clock. */
  readonly modifiedMs: number;
}

const cache = new Map<string, { key: string; series: LiveSeries }>();

/**
 * The candles of one series, or null when there are none. The file is parsed
 * again only when it has changed. A file that cannot be read at this moment
 * (the terminal is writing it) gives the last good reading.
 */
export function getLiveSeries(dir: string | null, symbol: string, timeframe: Timeframe, zone: string): LiveSeries | null {
  if (dir === null) return null;
  // Symbol names of the config are letters and digits only: they cannot leave the folder.
  if (!/^[A-Za-z0-9]{1,16}$/.test(symbol)) return null;
  const file = path.join(dir, `${symbol}_${timeframe}.csv`);
  let modifiedMs: number;
  let size: number;
  try {
    const stat = statSync(file);
    modifiedMs = stat.mtimeMs;
    size = stat.size;
  } catch {
    return null;
  }
  const key = `${zone}|${modifiedMs}:${size}`;
  const cached = cache.get(file);
  if (cached?.key === key) return cached.series;
  let parsed: Bar[];
  try {
    parsed = parseMt5Csv(decodeMt5File(readFileSync(file)), { timeframe, toUtc: createServerTimeConverter(zone) }).bars;
  } catch (error) {
    if (error instanceof Mt5CsvFormatError || (error as NodeJS.ErrnoException).code !== undefined) {
      return cached?.series ?? null;
    }
    throw error;
  }
  // A row out of order or repeated is dropped: the chart needs strictly increasing times.
  const bars: Bar[] = [];
  for (const bar of parsed) {
    const last = bars.at(-1);
    if (last === undefined || bar.time > last.time) bars.push(bar);
  }
  const series: LiveSeries = { file, bars, modifiedMs };
  cache.set(file, { key, series });
  return series;
}
