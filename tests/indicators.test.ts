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
    // The last 200 values are 1.10000 .. 1.10006. Summed in whole points their
    // mean is one number, and the series must give that double, not one near it.
    let points = 0;
    for (let index = 99_800; index < 100_000; index++) points += 110_000 + (index % 7);
    expect(last).toBe(points / (200 * 100_000));
  });

  it("equals the close when the close is the mean on paper", () => {
    // A plain float sum gives 0.6000000000000001 / 3 here.
    expect(sma([0.1, 0.2, 0.3], 3)[2]).toBe(0.2);
    // Index prices: the last close is the mean of the five, to the cent.
    expect(sma([2212.12, 2214.65, 2211.7, 2212.09, 2212.64], 5)[4]).toBe(2212.64);
    expect(sma([2220.43, 2223.91, 2221.97, 2222.73, 2222.26], 5)[4]).toBe(2222.26);
    // Five-digit quotes.
    expect(sma([1.408, 1.409, 1.405, 1.397, 1.40475], 5)[4]).toBe(1.40475);
  });

  it("puts every close on the right side of the mean along random walks", () => {
    // Deterministic walks on the price grids of the instruments: 2, 3 and 5 digits.
    for (const [digits, startPoints] of [[2, 225_000], [3, 150_000], [5, 110_000]] as const) {
      // 5 and 200 are the periods the strategies use; 7 does not divide a power of ten.
      for (const period of [5, 7, 200]) {
        let seed = 20_261_120 + digits * 1_000 + period;
        const next = (): number => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
        const series = new Sma(period);
        const window: number[] = [];
        let points = startPoints;
        let sum = 0;
        let ties = 0;
        let wrong = 0;
        let inexact = 0;
        for (let index = 0; index < 60_000; index++) {
          // A step of -3 .. +3 points, pulled back towards the start.
          const pull = Math.sign(startPoints - points) * (next() % 4 === 0 ? 1 : 0);
          points += (next() % 7) - 3 + pull;
          window.push(points);
          sum += points;
          if (window.length > period) sum -= window.shift() as number;
          const close = points / 10 ** digits;
          const mean = series.push(close);
          if (window.length < period) continue;
          const exact = Math.sign(period * points - sum);
          if (exact === 0) ties++;
          if (Math.sign(close - mean) !== exact) wrong++;
          // The mean itself: the whole-point sum divided once.
          if (mean !== sum / (period * 10 ** digits)) inexact++;
        }
        expect([digits, period, wrong, inexact]).toEqual([digits, period, 0, 0]);
        expect(ties).toBeGreaterThan(0);
      }
    }
  });

  it("refuses a price it cannot sum exactly", () => {
    expect(() => new Sma(3).push(Number.NaN)).toThrow(RangeError);
    expect(() => new Sma(3).push(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => new Sma(3).push(1e9)).toThrow(RangeError);
    // Each price fits, the sum of three does not.
    const series = new Sma(3);
    series.push(4e7);
    series.push(4e7);
    expect(() => series.push(4e7)).toThrow(RangeError);
    // A window of two such prices fits, however long the series.
    expect(sma([4e7, 4e7, 4e7, 4e7], 2)).toEqual([Number.NaN, 4e7, 4e7, 4e7]);
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
