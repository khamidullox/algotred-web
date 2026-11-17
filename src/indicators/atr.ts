import type { Bar } from "../data/types";
import type { ClosedBars } from "../engine/types";

/** True range of a bar given the previous close (Wilder). */
export function trueRange(bar: Bar, previousClose: number): number {
  return Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - previousClose),
    Math.abs(bar.low - previousClose),
  );
}

/**
 * ATR by Wilder: the first value is the mean of the first `period` true
 * ranges, every later value is `(previous * (period - 1) + tr) / period`.
 * Returns one value per bar; NaN until the first value is available (index
 * `period`, because the first bar has no previous close).
 *
 * MT5's built-in ATR indicator is a simple moving average of the true range,
 * so its window shows slightly different numbers.
 */
export function atrWilder(bars: readonly Bar[], period: number): number[] {
  const atr = new AtrWilder(period);
  bars.forEach((bar, index) => atr.push(bar, bars[index - 1]));
  return [...atr.values];
}

/** Incremental Wilder ATR aligned with a growing series of closed bars. */
export class AtrWilder {
  readonly values: number[] = [];
  #sum = 0;
  #count = 0;
  #last = Number.NaN;

  constructor(readonly period: number) {
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`ATR period must be a positive integer, got ${period}`);
    }
  }

  /** Adds one bar; `previous` is undefined only for the first bar. */
  push(bar: Bar, previous: Bar | undefined): number {
    if (previous === undefined) {
      this.values.push(Number.NaN);
      return Number.NaN;
    }
    const tr = trueRange(bar, previous.close);
    if (this.#count < this.period) {
      this.#sum += tr;
      this.#count++;
      this.#last =
        this.#count === this.period ? this.#sum / this.period : Number.NaN;
    } else {
      this.#last = (this.#last * (this.period - 1) + tr) / this.period;
    }
    this.values.push(this.#last);
    return this.#last;
  }

  /** Brings the series up to date with the closed bars and returns the value on the last one. */
  update(bars: ClosedBars): number {
    for (let index = this.values.length; index < bars.length; index++) {
      // at(-1) would be the last closed bar, not "no previous bar".
      this.push(bars.at(index) as Bar, index === 0 ? undefined : bars.at(index - 1));
    }
    return this.values[bars.length - 1] ?? Number.NaN;
  }

  /** Value on the bar with this index, NaN while warming up. */
  at(index: number): number {
    return this.values[index] ?? Number.NaN;
  }
}
