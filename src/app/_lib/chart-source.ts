// Which candles a chart may show (TZ 6, 17.52). The project's own export files
// are shown up to the start of the holdout set and never from it on. After the
// end of the project's data the candles the terminal passed on are shown: the
// holdout itself stays hidden between the two.
import type { Bar } from "../../data/types";

/** Bars by index, whether they sit in memory or are read from disk window by window. */
export interface BarSource {
  readonly count: number;
  timeAt(index: number): number;
  slice(from: number, to: number): Bar[];
}

/** First index whose bar opens at or after `time`; `count` when none. */
export function lowerBound(source: BarSource, time: number): number {
  let low = 0;
  let high = source.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (source.timeAt(middle) < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function arraySource(bars: readonly Bar[]): BarSource {
  return {
    count: bars.length,
    timeAt: (index) => (bars[index] as Bar).time,
    slice: (from, to) => bars.slice(from, to),
  };
}

export interface ChartSpan {
  /** What may be shown, oldest first. */
  readonly source: BarSource;
  /** UTC ms: the hidden holdout set starts here; null when the split is unknown. */
  readonly hiddenFrom: number | null;
  /** UTC ms: where the hidden set ends and the terminal's candles take over; null when none are shown. */
  readonly hiddenTo: number | null;
  /** Open time of the first and the last candle from the terminal, UTC ms; null when none are shown. */
  readonly liveFrom: number | null;
  readonly liveTo: number | null;
}

/**
 * `files`: the project's export of the series. `live`: the terminal's candles,
 * or null. `holdout`: the holdout set [start, end), or null when the split is
 * unknown; then nothing is hidden and the terminal's candles are shown after
 * the last bar of the files.
 */
export function chartSpan(files: BarSource, live: readonly Bar[] | null, holdout: { start: number; end: number } | null): ChartSpan {
  const shown = holdout === null ? files.count : lowerBound(files, holdout.start);
  const after = holdout !== null ? holdout.end : files.count > 0 ? files.timeAt(files.count - 1) + 1 : Number.NEGATIVE_INFINITY;
  const extra = live === null ? [] : live.slice(lowerBound(arraySource(live), after));
  const source: BarSource =
    extra.length === 0
      ? { count: shown, timeAt: (index) => files.timeAt(index), slice: (from, to) => files.slice(from, Math.min(to, shown)) }
      : {
          count: shown + extra.length,
          timeAt: (index) => (index < shown ? files.timeAt(index) : (extra[index - shown] as Bar).time),
          slice: (from, to) => [
            ...(from < shown ? files.slice(from, Math.min(to, shown)) : []),
            ...extra.slice(Math.max(0, from - shown), Math.max(0, to - shown)),
          ],
        };
  return {
    source,
    hiddenFrom: holdout?.start ?? null,
    hiddenTo: holdout !== null && extra.length > 0 ? holdout.end : null,
    liveFrom: extra[0]?.time ?? null,
    liveTo: extra.at(-1)?.time ?? null,
  };
}
