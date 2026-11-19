import { describe, expect, it } from "vitest";
import type { ChartBar } from "../src/app/_lib/api-types";
import { aggregateH4, barAtOrBefore, channel, lanes, swingLevels, withGaps } from "../src/app/_lib/chart-math";

const HOUR = 3600;
/** Server time two hours ahead of UTC, as in Athens winter time. */
const SHIFT = 2 * HOUR;

function bar(index: number, high: number, low: number, close = (high + low) / 2, step = HOUR): ChartBar {
  const time = 1_700_000_000 - (1_700_000_000 % (4 * HOUR)) + index * step - SHIFT;
  return { time, serverTime: time + SHIFT, open: (high + low) / 2, high, low, close, spreadPoints: 5 };
}

describe("channel", () => {
  it("takes the 20 bars before each bar, never the bar itself", () => {
    const bars = Array.from({ length: 25 }, (_, i) => bar(i, 10 + i, 5 - i));
    const result = channel(bars, 20);
    expect(result.slice(0, 20)).toEqual(new Array(20).fill(null));
    expect(result[20]).toEqual({ high: 29, low: -14 });
    expect(result[24]).toEqual({ high: 33, low: -18 });
  });
});

describe("swingLevels", () => {
  it("finds a high above two bars on each side and ends it at the first close above", () => {
    const highs = [1, 2, 5, 3, 2, 3, 4, 6, 5];
    const bars = highs.map((high, i) => bar(i, high, high - 1, i === 7 ? 5.5 : high - 0.5));
    const levels = swingLevels(bars, 2, 100).filter((level) => level.kind === "high");
    expect(levels).toEqual([{ kind: "high", index: 2, price: 5, knownIndex: 4, endIndex: 7, broken: true }]);
  });

  it("does not count equal highs as a swing", () => {
    const bars = [1, 2, 5, 5, 2, 1, 0].map((high, i) => bar(i, high, high - 1));
    expect(swingLevels(bars, 2, 100).filter((level) => level.kind === "high")).toEqual([]);
  });

  it("stops a level after its life", () => {
    const bars = [1, 2, 9, 3, 2, 1, 1, 1, 1, 1].map((high, i) => bar(i, high, high - 1));
    const [level] = swingLevels(bars, 2, 3).filter((item) => item.kind === "high");
    expect(level).toMatchObject({ index: 2, knownIndex: 4, endIndex: 7, broken: false });
  });
});

describe("aggregateH4", () => {
  it("builds candles on server-time blocks of four hours and drops blocks under three hours", () => {
    const hours = [
      bar(0, 2, 1, 1.5),
      bar(1, 3, 1, 2.5),
      bar(2, 4, 2, 3.5),
      bar(3, 3, 0.5, 1),
      bar(4, 5, 4, 4.5),
      bar(5, 6, 4, 5),
    ];
    const candles = aggregateH4(hours);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toMatchObject({ open: 1.5, high: 4, low: 0.5, close: 1, serverTime: hours[0]?.serverTime, time: hours[0]?.time });
  });

  it("starts a block at a multiple of four hours even when its first hour is missing", () => {
    const hours = [bar(1, 2, 1), bar(2, 2, 1), bar(3, 2, 1)];
    const [candle] = aggregateH4(hours);
    expect(candle?.serverTime).toBe((hours[0]?.serverTime ?? 0) - HOUR);
    expect(candle?.time).toBe((hours[0]?.time ?? 0) - HOUR);
  });
});

describe("barAtOrBefore", () => {
  it("finds the bar that contains a moment", () => {
    const bars = [bar(0, 1, 0), bar(1, 1, 0), bar(2, 1, 0)];
    expect(barAtOrBefore(bars, (bars[1]?.time ?? 0) + 1800)).toBe(1);
    expect(barAtOrBefore(bars, (bars[0]?.time ?? 0) - 1)).toBe(-1);
  });
});

describe("lanes", () => {
  it("puts overlapping segments on different rows and keeps two bars between segments of one row", () => {
    const rows = lanes(
      [
        { from: 0, to: 1, value: 1 },
        { from: 1, to: 2, value: 2 },
        { from: 3, to: 3, value: 3 },
        { from: 4, to: 5, value: 4 },
      ],
      6,
    );
    expect(rows).toEqual([
      [1, 1, null, null, 4, 4],
      [null, 2, 2, null, null, null],
      [null, null, null, 3, null, null],
    ]);
  });

  it("clips segments to the loaded bars", () => {
    expect(lanes([{ from: -3, to: 1, value: 7 }], 3)).toEqual([[7, 7, null]]);
  });
});

describe("withGaps", () => {
  it("fills gaps with invisible points and jumps between two of them", () => {
    expect(withGaps([null, 1, 1, null, null, null, 2, null])).toEqual([
      { value: 1, gap: true },
      { value: 1, gap: false },
      { value: 1, gap: false },
      { value: 1, gap: true },
      { value: 2, gap: true },
      { value: 2, gap: true },
      { value: 2, gap: false },
      { value: 2, gap: true },
    ]);
  });

  it("returns null for a row without values", () => {
    expect(withGaps([null, null])).toBeNull();
  });
});
