import type { Timeframe } from "../config";
import type { ServerTimeConverter } from "./time";
import { TIMEFRAME_MINUTES, type Bar } from "./types";

const HEADER_WITH_TIME =
  "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>";
// MT5 drops the <TIME> column when it exports the daily timeframe.
const HEADER_WITHOUT_TIME =
  "<DATE>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>";

const DATE_RE = /^(\d{4})\.(\d{2})\.(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})$/;
const MAX_STORED_ROW_ERRORS = 20;

// Row and format messages end up in the validate report, which is in Russian.
const SERVER_TIME_PROBLEM = {
  invalid: "такой даты или времени не существует",
  nonexistent:
    "такого времени нет в часовом поясе брокера (перевод часов вперёд)",
  ambiguous:
    "это время бывает дважды в часовом поясе брокера (перевод часов назад)",
} as const;

export class Mt5CsvFormatError extends Error {
  override name = "Mt5CsvFormatError";
}

export interface RowError {
  /** 1-based line number in the file. */
  readonly line: number;
  readonly message: string;
}

export interface ParsedCsv {
  readonly bars: Bar[];
  /** Data rows in the file, not counting the header and empty lines. */
  readonly rowCount: number;
  readonly rowErrorCount: number;
  /** The first few row errors, for the report. */
  readonly rowErrors: RowError[];
}

/** Decodes an MT5 export: UTF-8/ANSI by default, UTF-16LE when the BOM says so. */
export function decodeMt5File(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * Parses an MT5 "Export Bars" file. Rows that cannot be read are reported and
 * skipped, never guessed. Bars are returned in file order: checking the order
 * is the job of `validate`.
 */
export function parseMt5Csv(
  text: string,
  options: { timeframe: Timeframe; toUtc: ServerTimeConverter },
): ParsedCsv {
  const { timeframe, toUtc } = options;
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? "").replace(/^﻿/, "");

  let hasTimeColumn: boolean;
  if (header === HEADER_WITH_TIME) {
    hasTimeColumn = true;
  } else if (header === HEADER_WITHOUT_TIME) {
    hasTimeColumn = false;
  } else {
    throw new Mt5CsvFormatError(
      `Заголовок не похож на экспорт баров MT5: "${header.slice(0, 120)}"`,
    );
  }
  if (!hasTimeColumn && timeframe !== "D1") {
    throw new Mt5CsvFormatError(
      `В файле ${timeframe} нет колонки <TIME>: похоже, это дневной экспорт`,
    );
  }

  const columns = hasTimeColumn ? 9 : 8;
  const priceStart = hasTimeColumn ? 2 : 1;
  const stepMinutes = TIMEFRAME_MINUTES[timeframe];

  const bars: Bar[] = [];
  const rowErrors: RowError[] = [];
  let rowCount = 0;
  let rowErrorCount = 0;
  const fail = (line: number, message: string): void => {
    rowErrorCount++;
    if (rowErrors.length < MAX_STORED_ROW_ERRORS) {
      rowErrors.push({ line, message });
    }
  };

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.length === 0) {
      continue;
    }
    rowCount++;
    const lineNumber = index + 1;
    const cells = line.split("\t");
    if (cells.length !== columns) {
      fail(lineNumber, `ожидалось ${columns} колонок, найдено ${cells.length}`);
      continue;
    }

    const date = DATE_RE.exec(cells[0] ?? "");
    const time = hasTimeColumn ? TIME_RE.exec(cells[1] ?? "") : null;
    if (date === null || (hasTimeColumn && time === null)) {
      fail(lineNumber, "дата или время не в формате MT5");
      continue;
    }
    const hour = time === null ? 0 : Number(time[1]);
    const minute = time === null ? 0 : Number(time[2]);
    const second = time === null ? 0 : Number(time[3]);

    if (second !== 0 || (hour * 60 + minute) % stepMinutes !== 0) {
      fail(lineNumber, `время не попадает в сетку ${timeframe}`);
      continue;
    }

    const converted = toUtc({
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour,
      minute,
      second,
    });
    if (!converted.ok) {
      fail(lineNumber, SERVER_TIME_PROBLEM[converted.reason]);
      continue;
    }

    const open = Number(cells[priceStart]);
    const high = Number(cells[priceStart + 1]);
    const low = Number(cells[priceStart + 2]);
    const close = Number(cells[priceStart + 3]);
    const tickVolume = Number(cells[priceStart + 4]);
    const spreadPoints = Number(cells[priceStart + 6]);
    if (
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(tickVolume) ||
      !Number.isFinite(spreadPoints)
    ) {
      fail(lineNumber, "в числовой колонке не число");
      continue;
    }

    bars.push({
      time: converted.utcMs,
      open,
      high,
      low,
      close,
      tickVolume,
      spreadPoints,
    });
  }

  return { bars, rowCount, rowErrorCount, rowErrors };
}
