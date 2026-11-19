// The MT5 economic calendar, exported by tools/mt5/ExportCalendar.mq5: when
// news came out, how important it was, and its actual, forecast and previous
// values. Times are kept in UTC like the bars.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config";
import { decodeMt5File } from "./mt5-csv";

export type NewsImportance = "NONE" | "LOW" | "MODERATE" | "HIGH";
export type NewsTimeMode = "DATETIME" | "DATE" | "NOTIME" | "TENTATIVE" | "OTHER";

export interface NewsEvent {
  /** Release time, UTC ms. Only exact for `timeMode` DATETIME. */
  readonly time: number;
  /** ISO currency the event belongs to, e.g. USD. */
  readonly currency: string;
  /** ISO country code, e.g. US; EU for the euro area. */
  readonly country: string;
  /** MetaQuotes' stable English code, e.g. nonfarm-payrolls. */
  readonly code: string;
  /** Name in the terminal's language. */
  readonly name: string;
  readonly importance: NewsImportance;
  readonly timeMode: NewsTimeMode;
  /** MetaQuotes' unit and multiplier enums (percent, thousands, …). */
  readonly unit: number;
  readonly multiplier: number;
  readonly actual: number | null;
  readonly forecast: number | null;
  readonly previous: number | null;
  readonly revisedPrevious: number | null;
}

export const IMPORTANCE_RANK: Readonly<Record<NewsImportance, number>> = { NONE: 0, LOW: 1, MODERATE: 2, HIGH: 3 };

export class CalendarFormatError extends Error {}

const number = (text: string | undefined): number | null => {
  if (text === undefined || text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

/** "2024.01.05 15:30" as a UTC instant, or NaN. */
function parseStamp(date: string, time: string): number {
  const d = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(date.trim());
  const t = /^(\d{2}):(\d{2})/.exec(time.trim());
  if (d === null || t === null) return Number.NaN;
  return Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
}

/**
 * Parses an export. With a <UTC> column (script 1.01) that time is used.
 * Without it (script 1.00) <DATE> <TIME> are shifted back by the server's
 * offset at the moment of export, `exportOffsetHours`: MT5 writes the whole
 * history with that one offset, so summer releases would come out an hour
 * early if they were read as server time. Events come back sorted by time.
 */
export function parseCalendar(text: string, exportOffsetHours?: number): NewsEvent[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.length > 0);
  const header = (lines[0] ?? "").split("\t").map((name) => name.replace(/[<>]/g, "").trim());
  const column = (name: string): number => header.indexOf(name);
  const required = ["DATE", "TIME", "EVENT_CODE", "NAME", "COUNTRY", "CURRENCY", "IMPORTANCE", "TIMEMODE", "ACTUAL", "FORECAST", "PREVIOUS"];
  const missing = required.filter((name) => column(name) === -1);
  if (missing.length > 0) {
    throw new CalendarFormatError(`В файле календаря нет колонок: ${missing.join(", ")}`);
  }
  const utcColumn = column("UTC");
  if (utcColumn === -1 && exportOffsetHours === undefined) {
    throw new CalendarFormatError(
      "В файле календаря нет колонки <UTC> (выгрузка скриптом 1.00): задайте calendar.exportOffsetHours — сдвиг сервера от UTC в момент выгрузки",
    );
  }
  const shift = (exportOffsetHours ?? 0) * 3_600_000;
  const at = (cells: string[], name: string): string => cells[column(name)] ?? "";

  const events: NewsEvent[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    let time: number;
    if (utcColumn !== -1) {
      const [date = "", clock = ""] = (cells[utcColumn] ?? "").split(" ");
      time = parseStamp(date, clock);
    } else {
      time = parseStamp(at(cells, "DATE"), at(cells, "TIME")) - shift;
    }
    if (Number.isNaN(time)) continue;
    const importance = at(cells, "IMPORTANCE") as NewsImportance;
    const timeMode = at(cells, "TIMEMODE") as NewsTimeMode;
    events.push({
      time,
      currency: at(cells, "CURRENCY"),
      country: at(cells, "COUNTRY"),
      code: at(cells, "EVENT_CODE"),
      name: at(cells, "NAME"),
      importance: importance in IMPORTANCE_RANK ? importance : "NONE",
      timeMode: ["DATETIME", "DATE", "NOTIME", "TENTATIVE"].includes(timeMode) ? timeMode : "OTHER",
      unit: Number(at(cells, "UNIT")) || 0,
      multiplier: Number(at(cells, "MULTIPLIER")) || 0,
      actual: number(at(cells, "ACTUAL")),
      forecast: number(at(cells, "FORECAST")),
      previous: number(at(cells, "PREVIOUS")),
      revisedPrevious: column("REVISED_PREVIOUS") === -1 ? null : number(at(cells, "REVISED_PREVIOUS")),
    });
  }
  return events.sort((a, b) => a.time - b.time);
}

export interface CalendarInput {
  /** Path as configured, or null when the config has no calendar. */
  readonly file: string | null;
  readonly events: readonly NewsEvent[];
  /** Why there are no events although a file is configured. */
  readonly problem?: string;
}

/** Reads the configured calendar. A missing or broken file means no news, with the reason. */
export function readCalendar(config: Config): CalendarInput {
  const own = config.calendar;
  if (own === undefined) return { file: null, events: [] };
  const file = path.resolve(own.file);
  if (!existsSync(file)) return { file: own.file, events: [], problem: `нет файла ${own.file}` };
  try {
    return { file: own.file, events: parseCalendar(decodeMt5File(readFileSync(file)), own.exportOffsetHours) };
  } catch (error) {
    if (error instanceof CalendarFormatError) return { file: own.file, events: [], problem: error.message };
    throw error;
  }
}

/**
 * The currencies whose news move an instrument: both sides of a currency
 * pair, USD for gold and silver, USD for the US indices.
 */
export function symbolCurrencies(symbol: string): string[] {
  if (/^XA[UG]/.test(symbol)) return ["USD"];
  if (/^US(?!D)/.test(symbol)) return ["USD"];
  if (/^[A-Z]{6}$/.test(symbol)) return [symbol.slice(0, 3), symbol.slice(3, 6)];
  return [];
}

/** Index of the first event at or after `time` (UTC ms) in a sorted list. */
export function firstEventAtOrAfter(events: readonly NewsEvent[], time: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((events[middle] as NewsEvent).time < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

export interface NewsFilter {
  readonly currencies?: readonly string[];
  readonly minImportance?: NewsImportance;
  /** Only releases with an exact time (DATETIME). Default true. */
  readonly exactTime?: boolean;
}

/** Events in [from, to) UTC ms that pass the filter, oldest first. */
export function eventsBetween(events: readonly NewsEvent[], from: number, to: number, filter: NewsFilter = {}): NewsEvent[] {
  const minRank = IMPORTANCE_RANK[filter.minImportance ?? "NONE"];
  const exact = filter.exactTime ?? true;
  const out: NewsEvent[] = [];
  for (let index = firstEventAtOrAfter(events, from); index < events.length; index++) {
    const event = events[index] as NewsEvent;
    if (event.time >= to) break;
    if (IMPORTANCE_RANK[event.importance] < minRank) continue;
    if (exact && event.timeMode !== "DATETIME") continue;
    if (filter.currencies !== undefined && !filter.currencies.includes(event.currency)) continue;
    out.push(event);
  }
  return out;
}
