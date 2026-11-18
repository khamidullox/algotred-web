import { describe, expect, it } from "vitest";
import { ClosedBarsView } from "../src/engine/closed-bars";
import { RsiWilder, rsiWilder } from "../src/indicators/rsi";
import { bar } from "./helpers/bars";

describe("RSI by Wilder", () => {
  // Changes: +1, -0.5, +1.5, -1, 0, +2. By hand with period 2:
  // index 2: gain (1 + 0) / 2 = 0.5, loss (0 + 0.5) / 2 = 0.25, RS 2, RSI 66.667
  // index 3: gain (0.5 + 1.5) / 2 = 1, loss (0.25 + 0) / 2 = 0.125, RS 8, RSI 88.889
  // index 4: gain (1 + 0) / 2 = 0.5, loss (0.125 + 1) / 2 = 0.5625, RSI 47.059
  // index 5: gain 0.25, loss 0.28125, RSI 47.059
  // index 6: gain (0.25 + 2) / 2 = 1.125, loss 0.140625, RS 8, RSI 88.889
  const closes = [10, 11, 10.5, 12, 11, 11, 13];

  it("matches a hand calculation", () => {
    const values = rsiWilder(closes, 2);
    expect(values.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(values[2]).toBeCloseTo(200 / 3, 9);
    expect(values[3]).toBeCloseTo(800 / 9, 9);
    expect(values[4]).toBeCloseTo(100 - 100 / (1 + 0.5 / 0.5625), 9);
    expect(values[5]).toBeCloseTo(100 - 100 / (1 + 0.25 / 0.28125), 9);
    expect(values[6]).toBeCloseTo(800 / 9, 9);
  });

  it("is 100 with gains only and 50 with no change at all", () => {
    expect(rsiWilder([1, 2, 3, 4], 2).slice(2)).toEqual([100, 100]);
    expect(rsiWilder([5, 5, 5, 5], 2).slice(2)).toEqual([50, 50]);
    expect(rsiWilder([4, 3, 2, 1], 2).slice(2)).toEqual([0, 0]);
  });

  it("works incrementally on closed bars", () => {
    const source = closes.map((close, index) => bar(index * 60_000, close, close, close, close));
    const view = new ClosedBarsView(source, 3);
    const series = new RsiWilder(2);
    expect(series.update(view)).toBeCloseTo(200 / 3, 9);
    view.advanceTo(closes.length);
    expect(series.update(view)).toBeCloseTo(800 / 9, 9);
    expect(series.values).toEqual(rsiWilder(closes, 2));
  });

  it("rejects a period that is not a positive integer", () => {
    expect(() => new RsiWilder(0)).toThrow(RangeError);
    expect(() => new RsiWilder(1.5)).toThrow(RangeError);
  });
});
