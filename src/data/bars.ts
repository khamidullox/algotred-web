import type { TimeSpan } from "./time";
import type { Bar } from "./types";

/** Index of the first bar that opens at or after `time`. Bars must be sorted. */
export function lowerBound(bars: readonly Bar[], time: number): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((bars[middle] as Bar).time < time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** Bars that open inside the half-open span [start, end). Bars must be sorted. */
export function barsInSpan(bars: readonly Bar[], span: TimeSpan): Bar[] {
  return bars.slice(lowerBound(bars, span.start), lowerBound(bars, span.end));
}
