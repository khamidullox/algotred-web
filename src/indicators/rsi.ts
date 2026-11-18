import type { Bar } from "../data/types";
import type { ClosedBars } from "../engine/types";

/**
 * RSI by Wilder on closes, computed the way MT5's Relative Strength Index
 * does it: the first value (index `period`) uses the mean gain and mean loss
 * of the first `period` changes, every later value smooths them as
 * `(previous * (period - 1) + change) / period`. With no losses the RSI is
 * 100, with no gains and no losses it is 50. NaN while warming up.
 */
export function rsiWilder(closes: readonly number[], period: number): number[] {
  const rsi = new RsiWilder(period);
  closes.forEach((close, index) => rsi.push(close, closes[index - 1]));
  return [...rsi.values];
}

/** Incremental Wilder RSI aligned with a growing series of closed bars. */
export class RsiWilder {
  readonly values: number[] = [];
  #gainSum = 0;
  #lossSum = 0;
  #count = 0;
  #gain = Number.NaN;
  #loss = Number.NaN;

  constructor(readonly period: number) {
    if (!Number.isInteger(period) || period < 1) {
      throw new RangeError(`RSI period must be a positive integer, got ${period}`);
    }
  }

  /** Adds one close; `previous` is undefined only for the first bar. */
  push(close: number, previous: number | undefined): number {
    if (previous === undefined) {
      this.values.push(Number.NaN);
      return Number.NaN;
    }
    const change = close - previous;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (this.#count < this.period) {
      this.#gainSum += gain;
      this.#lossSum += loss;
      this.#count++;
      if (this.#count === this.period) {
        this.#gain = this.#gainSum / this.period;
        this.#loss = this.#lossSum / this.period;
      }
    } else {
      this.#gain = (this.#gain * (this.period - 1) + gain) / this.period;
      this.#loss = (this.#loss * (this.period - 1) + loss) / this.period;
    }
    const value = this.#count < this.period ? Number.NaN : rsiOf(this.#gain, this.#loss);
    this.values.push(value);
    return value;
  }

  /** Brings the series up to date with the closes of the closed bars and returns the last value. */
  update(bars: ClosedBars): number {
    for (let index = this.values.length; index < bars.length; index++) {
      // at(-1) would be the last closed bar, not "no previous bar".
      const previous = index === 0 ? undefined : (bars.at(index - 1) as Bar).close;
      this.push((bars.at(index) as Bar).close, previous);
    }
    return this.values[bars.length - 1] ?? Number.NaN;
  }

  /** Value on the bar with this index, NaN while warming up. */
  at(index: number): number {
    return this.values[index] ?? Number.NaN;
  }
}

function rsiOf(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}
