import { describe, expect, it } from "vitest";
import type { ChartBar } from "../src/app/_lib/api-types";
import { aggregateH4, barAtOrBefore, channel, exitBarIndex, lanes, swingLevels, withGaps } from "../src/app/_lib/chart-math";

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

  it("draws a sloped segment from entry to exit, also when it starts before the loaded bars", () => {
    expect(lanes([{ from: 1, to: 3, value: 2, valueTo: 8 }], 5)).toEqual([[null, 2, 5, 8, null]]);
    expect(lanes([{ from: -1, to: 1, value: 0, valueTo: 4 }], 3)).toEqual([[2, 4, null]]);
  });
});

describe("exitBarIndex", () => {
  const MINUTE = 60;
  // Minute bars from the open of the M15 bar in which the engine closed the trade.
  const minutes = (lows: number[], highs: number[]): ChartBar[] =>
    lows.map((low, i) => ({ ...bar(0, highs[i] as number, low), time: 1_000_000 + i * MINUTE, serverTime: 1_007_200 + i * MINUTE, spreadPoints: 10 }));
  const trade = { direction: "BUY" as const, exitTime: 1_000_000, entryPrice: 1.1, stopLoss: 1.095, takeProfit: 1.11 };

  it("moves a buy's stop to the first minute whose low reaches it", () => {
    const bars = minutes([1.098, 1.097, 1.0949, 1.09], [1.1, 1.1, 1.1, 1.1]);
    expect(exitBarIndex(bars, 0, { ...trade, exitReason: "stop" }, 5)).toBe(2);
  });

  it("checks a sell's exit on the ask: Bid plus the spread", () => {
    const bars = minutes([1.1, 1.1, 1.1], [1.0947, 1.0949, 1.096]);
    // Sell stop at 1.095: the ask is 1.0949 + 10 points = 1.0950 on the second minute.
    expect(exitBarIndex(bars, 0, { ...trade, direction: "SELL", stopLoss: 1.095, exitReason: "stop" }, 5)).toBe(1);
  });

  it("leaves rule exits and exits it cannot find where the engine put them", () => {
    const bars = minutes([1.098, 1.097], [1.1, 1.1]);
    expect(exitBarIndex(bars, 0, { ...trade, exitReason: "strategy" }, 5)).toBe(0);
    expect(exitBarIndex(bars, 0, { ...trade, exitReason: "take" }, 5)).toBe(0);
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
