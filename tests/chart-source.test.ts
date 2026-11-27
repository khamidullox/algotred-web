import { describe, expect, it } from "vitest";
import { arraySource, chartSpan } from "../src/app/_lib/chart-source";
import type { Bar } from "../src/data/types";

const DAY = 86_400_000;
const bar = (day: number, close = 100 + day): Bar => ({ time: day * DAY, open: close, high: close + 1, low: close - 1, close, tickVolume: 1, spreadPoints: 0 });
const days = (from: number, to: number, shift = 0): Bar[] => Array.from({ length: to - from }, (_, index) => bar(from + index, 100 + from + index + shift));
const times = (bars: readonly Bar[]): number[] => bars.map((item) => item.time / DAY);

/** The project's files: days 0..99. Holdout: days 70..100. The terminal: days 90..109. */
const FILES = days(0, 100);
const HOLDOUT = { start: 70 * DAY, end: 100 * DAY };
const LIVE = days(90, 110, 0.5);

describe("chartSpan", () => {
  it("shows the files up to the holdout and the terminal's candles from its end, never the holdout itself", () => {
    const span = chartSpan(arraySource(FILES), LIVE, HOLDOUT);
    expect(span.source.count).toBe(70 + 10);
    const all = span.source.slice(0, span.source.count);
    expect(times(all)).toEqual([...Array.from({ length: 70 }, (_, index) => index), ...Array.from({ length: 10 }, (_, index) => 100 + index)]);
    // Days 90..99 are in both the holdout and the terminal's file: none of them is served.
    expect(all.some((item) => item.time >= HOLDOUT.start && item.time < HOLDOUT.end)).toBe(false);
    // The bars after the gap are the terminal's own.
    expect(all[70]?.close).toBe(200.5);
    expect(span.hiddenFrom).toBe(70 * DAY);
    expect(span.hiddenTo).toBe(100 * DAY);
    expect(span.liveFrom).toBe(100 * DAY);
    expect(span.liveTo).toBe(109 * DAY);
  });

  it("slices across the join and on each side of it", () => {
    const source = chartSpan(arraySource(FILES), LIVE, HOLDOUT).source;
    expect(times(source.slice(68, 72))).toEqual([68, 69, 100, 101]);
    expect(times(source.slice(0, 2))).toEqual([0, 1]);
    expect(times(source.slice(75, 80))).toEqual([105, 106, 107, 108, 109]);
    expect(times(source.slice(78, 500))).toEqual([108, 109]);
    expect(source.timeAt(69)).toBe(69 * DAY);
    expect(source.timeAt(70)).toBe(100 * DAY);
  });

  it("is the old behaviour without the terminal's candles: the chart ends where the holdout starts", () => {
    for (const live of [null, [], days(80, 100)]) {
      const span = chartSpan(arraySource(FILES), live, HOLDOUT);
      expect(span.source.count).toBe(70);
      expect(times(span.source.slice(65, 200))).toEqual([65, 66, 67, 68, 69]);
      expect(span.hiddenFrom).toBe(70 * DAY);
      expect(span.hiddenTo).toBeNull();
      expect(span.liveFrom).toBeNull();
    }
  });

  it("without a known split hides nothing and adds the terminal's candles after the files' last bar", () => {
    const span = chartSpan(arraySource(FILES), LIVE, null);
    expect(span.source.count).toBe(100 + 10);
    expect(times(span.source.slice(98, 102))).toEqual([98, 99, 100, 101]);
    expect(span.hiddenFrom).toBeNull();
    expect(span.hiddenTo).toBeNull();
    // With no files at all the terminal's candles are the whole chart.
    expect(chartSpan(arraySource([]), LIVE, null).source.count).toBe(20);
  });
});
