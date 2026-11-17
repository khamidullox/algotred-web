import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { barsInSpan } from "../src/data/bars";
import {
  assertDatasetAccess,
  datasetBars,
  datasetSpan,
  describeSpan,
  HoldoutGuardError,
  splitCommonRange,
  SplitError,
} from "../src/data/split";
import type { TimeSpan } from "../src/data/time";
import type { Bar } from "../src/data/types";

const ZONE = "Europe/Athens";

const day = (iso: string, zone = ZONE): number =>
  DateTime.fromISO(iso, { zone }).toMillis();

const span = (from: string, to: string, zone = ZONE): TimeSpan => ({
  start: day(from, zone),
  end: day(to, zone),
});

const serverTime = (utcMs: number, zone = ZONE): string =>
  DateTime.fromMillis(utcMs, { zone }).toFormat("yyyy-LL-dd HH:mm");

const CLOSED = { holdoutAcknowledged: false };
const CONFIRMED = { holdoutAcknowledged: true };

describe("splitCommonRange on the period of the real files", () => {
  // 2015-02-02 to 2026-11-16 (exclusive), the common period found by validate.
  const common = span("2015-02-02", "2026-11-16");
  const split = splitCommonRange(common, ZONE);

  it("takes the last 24 calendar months as the holdout", () => {
    expect(serverTime(split.holdout.start)).toBe("2024-11-16 00:00");
    expect(split.holdout.end).toBe(common.end);
  });

  it("gives dev the first 70% of the days before the holdout", () => {
    // 2015-02-02 to 2024-11-16 is 3575 days; 70% is 2502.5, rounded down.
    expect(describeSpan(split.dev, ZONE)).toEqual({
      firstDay: "2015-02-02",
      lastDay: "2021-12-08",
      days: 2502,
    });
    expect(describeSpan(split.test, ZONE)).toEqual({
      firstDay: "2021-12-09",
      lastDay: "2024-11-15",
      days: 1073,
    });
    expect(describeSpan(split.holdout, ZONE)).toEqual({
      firstDay: "2024-11-16",
      lastDay: "2026-11-15",
      days: 730,
    });
  });

  it("leaves no hole and no overlap between the datasets", () => {
    expect(split.dev.start).toBe(common.start);
    expect(split.dev.end).toBe(split.test.start);
    expect(split.test.end).toBe(split.holdout.start);
    expect(split.holdout.end).toBe(common.end);
  });
});

describe("splitCommonRange boundaries", () => {
  it("puts every boundary at server midnight on both sides of a clock change", () => {
    // Start in winter time, dev/test boundary and holdout start in summer time.
    for (const zone of [ZONE, "America/New_York"]) {
      const split = splitCommonRange(span("2016-01-04", "2025-07-01", zone), zone);
      expect(serverTime(split.test.start, zone)).toMatch(/ 00:00$/);
      expect(serverTime(split.holdout.start, zone)).toBe("2023-07-01 00:00");
    }
  });

  it("clips the holdout start to the end of a shorter month", () => {
    const split = splitCommonRange(span("2015-01-01", "2024-02-29"), ZONE);
    expect(serverTime(split.holdout.start)).toBe("2022-02-28 00:00");
  });

  it("counts 70% in whole days without a floating-point loss", () => {
    // 90 days before the holdout: 0.7 * 90 is 62.99999999999999 in floating
    // point, the correct answer is 63.
    const split = splitCommonRange(span("2023-10-03", "2026-01-01"), ZONE);
    expect(describeSpan(split.dev, ZONE).days).toBe(63);
    expect(describeSpan(split.test, ZONE).days).toBe(27);
    expect(serverTime(split.test.start)).toBe("2023-12-05 00:00");
  });

  it("accepts the shortest period that still leaves a day for dev and for test", () => {
    const split = splitCommonRange(span("2023-12-30", "2026-01-01"), ZONE);
    expect(describeSpan(split.dev, ZONE).days).toBe(1);
    expect(describeSpan(split.test, ZONE).days).toBe(1);
  });

  it("refuses a period that is too short to split", () => {
    expect(() => splitCommonRange(span("2024-06-01", "2026-01-01"), ZONE)).toThrow(
      SplitError,
    );
    // Exactly 24 months plus one day: nothing is left for test.
    expect(() => splitCommonRange(span("2023-12-31", "2026-01-01"), ZONE)).toThrow(
      SplitError,
    );
  });

  it("refuses a period that does not start and end at server midnight", () => {
    const common = span("2015-02-02", "2026-11-16");
    expect(() =>
      splitCommonRange({ ...common, start: common.start + 3_600_000 }, ZONE),
    ).toThrow(SplitError);
    // Midnight in another zone is not midnight on the server.
    expect(() => splitCommonRange(span("2015-02-02", "2026-11-16", "UTC"), ZONE)).toThrow(
      SplitError,
    );
  });
});

describe("holdout guard", () => {
  const split = splitCommonRange(span("2023-10-03", "2026-01-01"), ZONE);

  it("blocks the holdout until the run is confirmed", () => {
    expect(() => assertDatasetAccess("holdout", CLOSED)).toThrow(HoldoutGuardError);
    expect(() => datasetSpan(split, "holdout", CLOSED)).toThrow(HoldoutGuardError);
    expect(() => datasetBars([], split, "holdout", CLOSED)).toThrow(HoldoutGuardError);
  });

  it("names the flag that opens the holdout", () => {
    expect(() => assertDatasetAccess("holdout", CLOSED)).toThrow(
      "--i-understand-holdout",
    );
  });

  it("opens the holdout with the confirmation", () => {
    expect(datasetSpan(split, "holdout", CONFIRMED)).toEqual(split.holdout);
  });

  it("never asks for a confirmation on dev and test", () => {
    expect(datasetSpan(split, "dev", CLOSED)).toEqual(split.dev);
    expect(datasetSpan(split, "test", CLOSED)).toEqual(split.test);
  });
});

describe("datasetBars", () => {
  const common = span("2023-10-03", "2026-01-01");
  const split = splitCommonRange(common, ZONE);
  // One bar at every server midnight of the common period.
  const bars: Bar[] = [];
  for (
    let time = DateTime.fromMillis(common.start, { zone: ZONE });
    time.toMillis() < common.end;
    time = time.plus({ days: 1 })
  ) {
    bars.push({
      time: time.toMillis(),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      tickVolume: 1,
      spreadPoints: 1,
    });
  }

  const dev = datasetBars(bars, split, "dev", CLOSED);
  const test = datasetBars(bars, split, "test", CLOSED);
  const holdout = datasetBars(bars, split, "holdout", CONFIRMED);

  it("puts every bar into exactly one dataset", () => {
    expect(dev).toHaveLength(63);
    expect(test).toHaveLength(27);
    // 2024 is a leap year: 366 + 365 days.
    expect(holdout).toHaveLength(731);
    expect([...dev, ...test, ...holdout]).toEqual(bars);
  });

  it("keeps the bar that opens on a boundary out of the earlier dataset", () => {
    expect(dev.at(-1)?.time).toBeLessThan(split.test.start);
    expect(test[0]?.time).toBe(split.test.start);
    expect(test.at(-1)?.time).toBeLessThan(split.holdout.start);
    expect(holdout[0]?.time).toBe(split.holdout.start);
  });

  it("treats a span as half-open", () => {
    const first = bars[0] as Bar;
    const second = bars[1] as Bar;
    expect(barsInSpan(bars, { start: first.time, end: second.time })).toEqual([first]);
    expect(barsInSpan(bars, { start: first.time, end: first.time })).toEqual([]);
  });
});
