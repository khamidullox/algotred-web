import type { Bar } from "../data/types";
import type { ClosedBars } from "../engine/types";

export interface Channel {
  readonly high: number;
  readonly low: number;
}

/**
 * Highest high and lowest low of the `lookback` bars that precede the bar at
 * `end` (default: the last closed bar), so the current bar is never part of
 * its own channel. Null while the history is too short.
 */
export function donchian(
  bars: ClosedBars,
  lookback: number,
  end = bars.length - 1,
): Channel | null {
  const start = end - lookback;
  if (start < 0 || lookback < 1) {
    return null;
  }
  let high = -Infinity;
  let low = Infinity;
  for (let index = start; index < end; index++) {
    const bar = bars.at(index) as Bar;
    if (bar.high > high) high = bar.high;
    if (bar.low < low) low = bar.low;
  }
  return { high, low };
}
