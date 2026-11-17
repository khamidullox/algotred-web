import { describe, expect, it } from "vitest";
import { ClosedBarsView } from "../src/engine/closed-bars";
import { atrWilder, AtrWilder, trueRange } from "../src/indicators/atr";
import { donchian } from "../src/indicators/donchian";
import { sma, Sma } from "../src/indicators/sma";
import { bar } from "./helpers/bars";

const HOUR = 3_600_000;

/** Bars from (high, low, close) triples; the open is the previous close. */
function bars(rows: ReadonlyArray<readonly [high: number, low: number, close: number]>) {
  return rows.map(([high, low, close], index) =>
    bar(index * HOUR, rows[index - 1]?.[2] ?? close, high, low, close),
  );
}

describe("test 8: SMA", () => {
  it("matches values computed by hand", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([Number.NaN, Number.NaN, 2, 3, 4]);
    expect(sma([2, 4, 6, 8], 1)).toEqual([2, 4, 6, 8]);
    expect(sma([1, 2], 3)).toEqual([Number.NaN, Number.NaN]);
  });

  it("stays exact over a long series", () => {
    const series = new Sma(200);
    let last = Number.NaN;
    for (let index = 0; index < 100_000; index++) {
      last = series.push(1.1 + (index % 7) * 0.00001);
    }
    // The last 200 values: index 99 800 .. 99 999, residues mod 7 cycle evenly
    // except for the remainder, so compute the expectation directly.
    let sum = 0;
    for (let index = 99_800; index < 100_000; index++) sum += 1.1 + (index % 7) * 0.00001;
    expect(last).toBeCloseTo(sum / 200, 12);
  });

  it("works incrementally on closed bars", () => {
    const source = bars([[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4]]);
    const view = new ClosedBarsView(source, 2);
    const series = new Sma(2);
    expect(series.update(view)).toBe(1.5);
    view.advanceTo(4);
    expect(series.update(view)).toBe(3.5);
    expect(series.values).toEqual([Number.NaN, 1.5, 2.5, 3.5]);
  });
});

describe("test 8: ATR by Wilder", () => {
  const source = bars([
    [10, 8, 9],
    [11, 9, 10],
    [12, 10, 11],
    [15, 11, 14],
    [14, 12, 13],
    [20, 13, 19],
  ]);

  it("computes the true range against the previous close", () => {
    expect(trueRange(source[3]!, 11)).toBe(4);
    // A gap: the previous close is outside the bar.
    expect(trueRange(bar(0, 20, 21, 19, 20), 10)).toBe(11);
  });

  it("matches values computed by hand", () => {
    // True ranges: -, 2, 2, 4, 2, 7.
    // ATR(3): first = (2 + 2 + 4) / 3 = 8/3, then (8/3 * 2 + 2) / 3 = 22/9,
    // then (22/9 * 2 + 7) / 3 = 107/27.
    const values = atrWilder(source, 3);
    expect(values.slice(0, 3)).toEqual([Number.NaN, Number.NaN, Number.NaN]);
    expect(values[3]).toBeCloseTo(8 / 3, 12);
    expect(values[4]).toBeCloseTo(22 / 9, 12);
    expect(values[5]).toBeCloseTo(107 / 27, 12);
  });

  it("gives the same values incrementally", () => {
    const view = new ClosedBarsView(source, 4);
    const atr = new AtrWilder(3);
    expect(atr.update(view)).toBeCloseTo(8 / 3, 12);
    view.advanceTo(6);
    expect(atr.update(view)).toBeCloseTo(107 / 27, 12);
    expect(atr.at(4)).toBeCloseTo(22 / 9, 12);
    expect(atr.at(99)).toBeNaN();
  });

  it("rejects a bad period", () => {
    expect(() => new AtrWilder(0)).toThrow(RangeError);
    expect(() => new AtrWilder(2.5)).toThrow(RangeError);
  });
});

describe("Donchian channel", () => {
  const source = bars([
    [1, 0, 0.5],
    [5, 1, 3],
    [3, 2, 2.5],
    [4, 1, 2],
    [2, 1, 1.5],
  ]);
  const view = new ClosedBarsView(source, 5);

  it("takes the bars before the last one", () => {
    expect(donchian(view, 3)).toEqual({ high: 5, low: 1 });
    expect(donchian(view, 1)).toEqual({ high: 4, low: 1 });
    expect(donchian(view, 4)).toEqual({ high: 5, low: 0 });
  });

  it("returns null while the history is short", () => {
    expect(donchian(view, 5)).toBeNull();
    expect(donchian(view, 0)).toBeNull();
    expect(donchian(new ClosedBarsView(source, 1), 1)).toBeNull();
  });

  it("can be anchored on an earlier bar", () => {
    expect(donchian(view, 2, 3)).toEqual({ high: 5, low: 1 });
  });
});
