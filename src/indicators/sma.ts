import type { Bar } from "../data/types";
import type { ClosedBars } from "../engine/types";

/**
 * Prices are summed as whole units of 1e-8, the finest point the config
 * allows (`digits` up to 8). The sum of such integers is exact, so the mean
 * is the double nearest to the true mean: a close that equals the mean on
 * paper equals it here as well, and `close > mean` is never decided by
 * rounding noise.
 */
const UNITS_PER_PRICE = 1e8;

/** Simple moving average; NaN for the first `period - 1` values. */
export function sma(values: readonly number[], period: number): number[] {
  const series = new Sma(period);
  return values.map((value) => series.push(value));
}

/**
 * Incremental simple moving average of the close, aligned with closed bars.
 * Takes prices: finite numbers with at most 8 decimal places.
 */
export class Sma {
  readonly values: number[] = [];
  readonly #window: number[] = [];
  /** Sum of the window in units of 1e-8, always a whole number. */
  #sum = 0;

  constructor(readonly period: number) {
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`SMA period must be a positive integer, got ${period}`);
    }
  }

  push(value: number): number {
    const units = Math.round(value * UNITS_PER_PRICE);
    if (this.#window.length === this.period) {
      this.#sum -= this.#window.shift() as number;
    }
    this.#window.push(units);
    this.#sum += units;
    // Whole numbers add exactly only up to 2^53.
    if (!Number.isSafeInteger(units) || !Number.isSafeInteger(this.#sum)) {
      throw new RangeError(
        `SMA(${this.period}) cannot sum the price ${value} exactly: it is not finite or too large`,
      );
    }
    // One division by a whole number: the result is rounded once.
    const result =
      this.#window.length === this.period
        ? this.#sum / (this.period * UNITS_PER_PRICE)
        : Number.NaN;
    this.values.push(result);
    return result;
  }

  /** Brings the series up to date with the closes of the closed bars and returns the last value. */
  update(bars: ClosedBars): number {
    for (let index = this.values.length; index < bars.length; index++) {
      this.push((bars.at(index) as Bar).close);
    }
    return this.values[bars.length - 1] ?? Number.NaN;
  }

  at(index: number): number {
    return this.values[index] ?? Number.NaN;
  }
}
