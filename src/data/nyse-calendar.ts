import { DateTime } from "luxon";

/**
 * Trading days of the New York Stock Exchange (TZ 17.6), computed from the
 * exchange's holiday rules, so the calendar is known in advance and needs no
 * data. Dates are plain yyyy-MM-dd strings (the exchange's local date).
 *
 * Full-day closures: New Year's Day, Martin Luther King Jr. Day (3rd Monday of
 * January), Washington's Birthday (3rd Monday of February), Good Friday,
 * Memorial Day (last Monday of May), Juneteenth (June 19, from 2022),
 * Independence Day, Labor Day (1st Monday of September), Thanksgiving (4th
 * Thursday of November) and Christmas. A holiday on Saturday is observed on
 * the Friday before, one on Sunday on the Monday after, except New Year's Day
 * on a Saturday, which is not observed (the exchange stays open on December
 * 31). Plus the special closures of 2018-12-05 and 2025-01-09.
 */

const SPECIAL_CLOSURES: readonly string[] = ["2018-12-05", "2025-01-09"];

const iso = (date: DateTime): string => date.toFormat("yyyy-LL-dd");
const day = (year: number, month: number, dayOfMonth: number): DateTime =>
  DateTime.utc(year, month, dayOfMonth);

/** The n-th given weekday (1 Monday .. 7 Sunday) of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): DateTime {
  const first = day(year, month, 1);
  const offset = (weekday - first.weekday + 7) % 7;
  return first.plus({ days: offset + 7 * (n - 1) });
}

function lastWeekday(year: number, month: number, weekday: number): DateTime {
  const last = day(year, month, 1).endOf("month").startOf("day");
  const offset = (last.weekday - weekday + 7) % 7;
  return last.minus({ days: offset });
}

/** Easter Sunday, Gregorian calendar (anonymous Gregorian algorithm). */
export function easterSunday(year: number): DateTime {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const dayOfMonth = ((h + l - 7 * m + 114) % 31) + 1;
  return day(year, month, dayOfMonth);
}

/** A fixed-date holiday moved off the weekend. */
function observed(date: DateTime): DateTime {
  if (date.weekday === 6) return date.minus({ days: 1 });
  if (date.weekday === 7) return date.plus({ days: 1 });
  return date;
}

const cache = new Map<number, ReadonlySet<string>>();

/** Full-day closures of the exchange in a calendar year. */
export function nyseHolidays(year: number): ReadonlySet<string> {
  const cached = cache.get(year);
  if (cached !== undefined) return cached;
  const dates: DateTime[] = [];
  const newYear = day(year, 1, 1);
  if (newYear.weekday !== 6) dates.push(observed(newYear));
  dates.push(nthWeekday(year, 1, 1, 3));
  dates.push(nthWeekday(year, 2, 1, 3));
  dates.push(easterSunday(year).minus({ days: 2 }));
  dates.push(lastWeekday(year, 5, 1));
  if (year >= 2022) dates.push(observed(day(year, 6, 19)));
  dates.push(observed(day(year, 7, 4)));
  dates.push(nthWeekday(year, 9, 1, 1));
  dates.push(nthWeekday(year, 11, 4, 4));
  dates.push(observed(day(year, 12, 25)));
  const set = new Set([
    ...dates.map(iso),
    ...SPECIAL_CLOSURES.filter((date) => date.startsWith(`${year}-`)),
  ]);
  cache.set(year, set);
  return set;
}

/** True for a weekday on which the exchange is open. */
export function isNyseTradingDay(date: string): boolean {
  const parsed = DateTime.fromISO(date, { zone: "utc" });
  if (!parsed.isValid) throw new RangeError(`not a date: ${date}`);
  return parsed.weekday <= 5 && !nyseHolidays(parsed.year).has(date);
}

/** Trading days of a month, in order. */
export function nyseTradingDaysOfMonth(year: number, month: number): string[] {
  const result: string[] = [];
  const end = day(year, month, 1).endOf("month").day;
  for (let dayOfMonth = 1; dayOfMonth <= end; dayOfMonth++) {
    const date = iso(day(year, month, dayOfMonth));
    if (isNyseTradingDay(date)) result.push(date);
  }
  return result;
}

/** The first trading day strictly after a date. */
export function nextNyseTradingDay(date: string): string {
  let current = DateTime.fromISO(date, { zone: "utc" });
  if (!current.isValid) throw new RangeError(`not a date: ${date}`);
  for (;;) {
    current = current.plus({ days: 1 });
    const candidate = iso(current);
    if (isNyseTradingDay(candidate)) return candidate;
  }
}
