import { DateTime } from "luxon";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./types";

export const NEW_YORK = "America/New_York";

/** Wall-clock time as written in an MT5 export (broker server time). */
export interface LocalTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export type ServerTimeResult =
  | { readonly ok: true; readonly utcMs: number }
  | {
      readonly ok: false;
      /**
       * invalid: not a real date or time;
       * nonexistent: skipped by a spring-forward clock change;
       * ambiguous: happens twice because of an autumn clock change.
       */
      readonly reason: "invalid" | "nonexistent" | "ambiguous";
    };

export type ServerTimeConverter = (time: LocalTime) => ServerTimeResult;

function convertExact(time: LocalTime, zone: string): ServerTimeResult {
  const dt = DateTime.fromObject(time, { zone });
  if (!dt.isValid) {
    return { ok: false, reason: "invalid" };
  }
  // Luxon silently moves a non-existent local time forward. Detect that.
  if (
    dt.year !== time.year ||
    dt.month !== time.month ||
    dt.day !== time.day ||
    dt.hour !== time.hour ||
    dt.minute !== time.minute ||
    dt.second !== time.second
  ) {
    return { ok: false, reason: "nonexistent" };
  }
  if (dt.getPossibleOffsets().length > 1) {
    return { ok: false, reason: "ambiguous" };
  }
  return { ok: true, utcMs: dt.toMillis() };
}

/**
 * Converts broker server time to UTC. All offset arithmetic is done by Luxon;
 * the only shortcut is that a day with no clock change is resolved once and
 * reused for every bar of that day.
 */
export function createServerTimeConverter(zone: string): ServerTimeConverter {
  const days = new Map<number, { uniform: boolean; midnightUtc: number }>();

  return (time) => {
    const key = time.year * 10_000 + time.month * 100 + time.day;
    let day = days.get(key);
    if (day === undefined) {
      const midnight = convertExact(
        { ...time, hour: 0, minute: 0, second: 0 },
        zone,
      );
      if (midnight.ok) {
        const next = DateTime.fromMillis(midnight.utcMs, { zone }).plus({
          days: 1,
        });
        day = {
          uniform: next.toMillis() - midnight.utcMs === DAY_MS,
          midnightUtc: midnight.utcMs,
        };
      } else {
        day = { uniform: false, midnightUtc: Number.NaN };
      }
      days.set(key, day);
    }

    if (!day.uniform) {
      return convertExact(time, zone);
    }
    const { hour, minute, second } = time;
    if (
      !Number.isInteger(hour) ||
      !Number.isInteger(minute) ||
      !Number.isInteger(second) ||
      hour < 0 ||
      hour > 23 ||
      minute < 0 ||
      minute > 59 ||
      second < 0 ||
      second > 59
    ) {
      return { ok: false, reason: "invalid" };
    }
    return {
      ok: true,
      utcMs:
        day.midnightUtc + hour * HOUR_MS + minute * MINUTE_MS + second * 1000,
    };
  };
}

/** Start of the server-time calendar day that contains the instant. */
export function startOfZoneDay(utcMs: number, zone: string): number {
  return DateTime.fromMillis(utcMs, { zone }).startOf("day").toMillis();
}

/** Start of the next server-time calendar day. */
export function nextZoneDay(utcMs: number, zone: string): number {
  return DateTime.fromMillis(utcMs, { zone })
    .startOf("day")
    .plus({ days: 1 })
    .toMillis();
}

export function formatInZone(
  utcMs: number,
  zone: string,
  format = "yyyy-LL-dd HH:mm",
): string {
  return DateTime.fromMillis(utcMs, { zone }).toFormat(format);
}

export interface TimeSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The FX weekend closure of the New York calendar week (Monday to Sunday)
 * that contains the instant: Friday 17:00 to Sunday 17:00, New York time.
 */
export function weekendClosureOfWeek(utcMs: number): TimeSpan {
  const ny = DateTime.fromMillis(utcMs, { zone: NEW_YORK });
  // Luxon weekdays: 1 = Monday ... 7 = Sunday.
  const friday = ny
    .startOf("day")
    .plus({ days: 5 - ny.weekday })
    .set({ hour: 17 });
  return {
    start: friday.toMillis(),
    end: friday.plus({ days: 2 }).toMillis(),
  };
}

/** Weekend closures that overlap the half-open interval [from, to). */
export function weekendClosuresBetween(from: number, to: number): TimeSpan[] {
  const closures: TimeSpan[] = [];
  let closure = weekendClosureOfWeek(from);
  while (closure.start < to) {
    if (closure.end > from) {
      closures.push(closure);
    }
    // Any instant on the following Monday belongs to the next week.
    closure = weekendClosureOfWeek(closure.end + DAY_MS);
  }
  return closures;
}

/** True if the interval [from, to) touches 25 December or 1 January, New York date. */
export function touchesFixedHoliday(from: number, to: number): boolean {
  let day = DateTime.fromMillis(from, { zone: NEW_YORK }).startOf("day");
  const last = DateTime.fromMillis(Math.max(from, to - 1), { zone: NEW_YORK });
  while (day <= last) {
    if (
      (day.month === 12 && day.day === 25) ||
      (day.month === 1 && day.day === 1)
    ) {
      return true;
    }
    day = day.plus({ days: 1 });
  }
  return false;
}
