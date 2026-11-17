import type { Bar } from "../data/types";
import type { ClosedBars } from "../engine/types";

/** Simple moving average; NaN for the first `period - 1` values. */
export function sma(values: readonly number[], period: number): number[] {
  const series = new Sma(period);
  return values.map((value) => series.push(value));
}

/** Incremental simple moving average of the close, aligned with closed bars. */
export class Sma {
  readonly values: number[] = [];
  readonly #window: number[] = [];
  #sum = 0;

  constructor(readonly period: number) {
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`SMA period must be a positive integer, got ${period}`);
    }
  }

  push(value: number): number {
    this.#window.push(value);
    this.#sum += value;
    if (this.#window.length > this.period) {
      this.#sum -= this.#window.shift() as number;
    }
    // Summing the window again avoids the drift of a running sum over
    // hundreds of thousands of bars.
    if (this.values.length % 1024 === 0) {
      this.#sum = this.#window.reduce((total, item) => total + item, 0);
    }
    const result =
      this.#window.length === this.period ? this.#sum / this.period : Number.NaN;
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
