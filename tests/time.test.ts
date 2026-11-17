import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  createServerTimeConverter,
  NEW_YORK,
  touchesFixedHoliday,
  weekendClosureOfWeek,
  weekendClosuresBetween,
  type LocalTime,
} from "../src/data/time";

const at = (
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
): LocalTime => ({ year, month, day, hour, minute, second: 0 });

const utc = (iso: string): number => DateTime.fromISO(iso, { zone: "UTC" }).toMillis();

function newYork(utcMs: number): string {
  return DateTime.fromMillis(utcMs, { zone: NEW_YORK }).toFormat("ccc HH:mm");
}

// TZ section 11, test 6: server time to UTC before and after the clock changes
// in Europe and in the US, which happen on different dates.
describe("server time to UTC (Europe/Athens)", () => {
  const toUtc = createServerTimeConverter("Europe/Athens");
  const convert = (time: LocalTime): number => {
    const result = toUtc(time);
    if (!result.ok) throw new Error(`unexpected ${result.reason}`);
    return result.utcMs;
  };

  it("uses UTC+2 in winter and UTC+3 in summer", () => {
    expect(convert(at(2024, 3, 8, 10))).toBe(utc("2024-03-08T08:00:00"));
    expect(convert(at(2024, 4, 5, 10))).toBe(utc("2024-04-05T07:00:00"));
  });

  it("follows the EU switch, not the US one, in spring", () => {
    // US changed on 10 March 2024, the EU on 31 March 2024.
    const before = convert(at(2024, 3, 8, 15, 30));
    const between = convert(at(2024, 3, 15, 15, 30));
    const after = convert(at(2024, 4, 5, 15, 30));
    expect(between).toBe(utc("2024-03-15T13:30:00"));
    // The same server hour is one New York hour later while only the US is on summer time.
    expect(newYork(before)).toBe("Fri 08:30");
    expect(newYork(between)).toBe("Fri 09:30");
    expect(newYork(after)).toBe("Fri 08:30");
  });

  it("follows the EU switch, not the US one, in autumn", () => {
    // The EU changed on 27 October 2024, the US on 3 November 2024.
    const before = convert(at(2024, 10, 25, 15, 30));
    const between = convert(at(2024, 10, 30, 15, 30));
    const after = convert(at(2024, 11, 8, 15, 30));
    expect(before).toBe(utc("2024-10-25T12:30:00"));
    expect(between).toBe(utc("2024-10-30T13:30:00"));
    expect(after).toBe(utc("2024-11-08T13:30:00"));
    expect(newYork(before)).toBe("Fri 08:30");
    expect(newYork(between)).toBe("Wed 09:30");
    expect(newYork(after)).toBe("Fri 08:30");
  });

  it("converts every bar of a clock-change day correctly", () => {
    // 31 March 2024: 03:00 jumps to 04:00, the day has 23 hours.
    expect(convert(at(2024, 3, 31, 2, 45))).toBe(utc("2024-03-31T00:45:00"));
    expect(convert(at(2024, 3, 31, 4, 0))).toBe(utc("2024-03-31T01:00:00"));
    expect(convert(at(2024, 3, 31, 23, 45))).toBe(utc("2024-03-31T20:45:00"));
    // 27 October 2024: 04:00 falls back to 03:00, the day has 25 hours.
    expect(convert(at(2024, 10, 27, 2, 45))).toBe(utc("2024-10-26T23:45:00"));
    expect(convert(at(2024, 10, 27, 4, 0))).toBe(utc("2024-10-27T02:00:00"));
  });

  it("refuses a time skipped by the spring clock change", () => {
    expect(toUtc(at(2024, 3, 31, 3, 30))).toEqual({
      ok: false,
      reason: "nonexistent",
    });
  });

  it("refuses a time that happens twice in autumn", () => {
    expect(toUtc(at(2024, 10, 27, 3, 30))).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("refuses dates and times that do not exist", () => {
    expect(toUtc(at(2024, 2, 30))).toEqual({ ok: false, reason: "invalid" });
    expect(toUtc(at(2024, 5, 6, 24))).toEqual({ ok: false, reason: "invalid" });
    expect(toUtc(at(2024, 5, 6, 10, 60))).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("gives the same answer from the day cache and from a fresh converter", () => {
    const fresh = createServerTimeConverter("Europe/Athens");
    convert(at(2024, 5, 6, 0));
    expect(convert(at(2024, 5, 6, 17, 15))).toBe(
      (fresh(at(2024, 5, 6, 17, 15)) as { utcMs: number }).utcMs,
    );
  });
});

describe("server time to UTC (other zones)", () => {
  it("handles a zone that follows the US schedule", () => {
    const toUtc = createServerTimeConverter(NEW_YORK);
    expect(toUtc(at(2024, 3, 8, 17))).toEqual({
      ok: true,
      utcMs: utc("2024-03-08T22:00:00"),
    });
    expect(toUtc(at(2024, 3, 15, 17))).toEqual({
      ok: true,
      utcMs: utc("2024-03-15T21:00:00"),
    });
  });
});

describe("weekend closure", () => {
  it("runs from Friday 17:00 to Sunday 17:00 New York in winter and summer", () => {
    const winter = weekendClosureOfWeek(utc("2024-01-17T12:00:00"));
    expect(winter.start).toBe(utc("2024-01-19T22:00:00"));
    expect(winter.end).toBe(utc("2024-01-21T22:00:00"));
    const summer = weekendClosureOfWeek(utc("2024-06-12T12:00:00"));
    expect(summer.start).toBe(utc("2024-06-14T21:00:00"));
    expect(summer.end).toBe(utc("2024-06-16T21:00:00"));
  });

  it("keeps 17:00 local across the US clock change on the Sunday", () => {
    // US clocks moved forward on Sunday 10 March 2024.
    const closure = weekendClosureOfWeek(utc("2024-03-08T12:00:00"));
    expect(closure.start).toBe(utc("2024-03-08T22:00:00"));
    expect(closure.end).toBe(utc("2024-03-10T21:00:00"));
  });

  it("assigns Saturday and Sunday to the closure that started on Friday", () => {
    const saturday = weekendClosureOfWeek(utc("2024-06-15T12:00:00"));
    const sunday = weekendClosureOfWeek(utc("2024-06-16T12:00:00"));
    expect(saturday.start).toBe(utc("2024-06-14T21:00:00"));
    expect(sunday.start).toBe(utc("2024-06-14T21:00:00"));
  });

  it("lists every closure inside a long interval and none inside a short one", () => {
    expect(
      weekendClosuresBetween(utc("2024-06-12T00:00:00"), utc("2024-06-13T00:00:00")),
    ).toEqual([]);
    expect(
      weekendClosuresBetween(utc("2024-06-14T21:00:00"), utc("2024-07-01T00:00:00")),
    ).toHaveLength(3);
  });
});

describe("fixed holidays", () => {
  it("detects 25 December and 1 January by New York date", () => {
    expect(
      touchesFixedHoliday(utc("2023-12-24T23:00:00"), utc("2023-12-26T08:00:00")),
    ).toBe(true);
    expect(
      touchesFixedHoliday(utc("2024-01-01T10:00:00"), utc("2024-01-01T12:00:00")),
    ).toBe(true);
    expect(
      touchesFixedHoliday(utc("2024-07-02T10:00:00"), utc("2024-07-03T00:00:00")),
    ).toBe(false);
  });
});
