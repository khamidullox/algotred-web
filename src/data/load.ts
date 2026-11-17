import { existsSync, readFileSync } from "node:fs";
import type { Config } from "../config";
import { allSeries, seriesFileName, seriesFilePath } from "./files";
import {
  decodeMt5File,
  Mt5CsvFormatError,
  parseMt5Csv,
  type ParsedCsv,
} from "./mt5-csv";
import { createServerTimeConverter, type ServerTimeConverter } from "./time";
import type { SeriesId } from "./types";

/** One data file as read from disk, before any checks. */
export interface SeriesInput {
  readonly id: SeriesId;
  /** File name inside the data directory. */
  readonly file: string;
  /** null when the file is missing or is not an MT5 export. */
  readonly parsed: ParsedCsv | null;
  /** Set when the file exists but is not an MT5 export. */
  readonly formatError?: string;
}

export function readSeriesInput(
  config: Config,
  id: SeriesId,
  toUtc: ServerTimeConverter = createServerTimeConverter(config.brokerTimeZone),
): SeriesInput {
  const file = seriesFileName(id);
  const filePath = seriesFilePath(config, id);
  if (!existsSync(filePath)) {
    return { id, file, parsed: null };
  }
  try {
    const text = decodeMt5File(readFileSync(filePath));
    return {
      id,
      file,
      parsed: parseMt5Csv(text, { timeframe: id.timeframe, toUtc }),
    };
  } catch (error) {
    if (error instanceof Mt5CsvFormatError) {
      return { id, file, parsed: null, formatError: error.message };
    }
    throw error;
  }
}

export function readAllSeries(config: Config): SeriesInput[] {
  const toUtc = createServerTimeConverter(config.brokerTimeZone);
  return allSeries(config).map((id) => readSeriesInput(config, id, toUtc));
}
