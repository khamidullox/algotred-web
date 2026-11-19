// Pure helpers for the chart page: indicators on loaded bars, the levels our
// strategies trade, H4 candles built from H1, and "lanes" that let one line
// series draw many separate horizontal segments. Client-safe: the engine's
// indicator files only import types, so the chart shows the very numbers the
// strategies use.
import type { Bar } from "../../data/types";
import { atrWilder } from "../../indicators/atr";
import { rsiWilder } from "../../indicators/rsi";
import { sma } from "../../indicators/sma";
import type { ChartBar } from "./api-types";

export { rsiWilder, sma };

const asBar = (bar: ChartBar): Bar => ({
  time: bar.time * 1000,
  open: bar.open,
  high: bar.high,
  low: bar.low,
  close: bar.close,
  tickVolume: 0,
  spreadPoints: bar.spreadPoints,
});

/** ATR(period) by Wilder, as in the strategies; NaN while warming up. */
export function atr(bars: readonly ChartBar[], period: number): number[] {
  return atrWilder(bars.map(asBar), period);
}

export interface ChannelPoint {
  readonly high: number;
  readonly low: number;
}

/**
 * The level a breakout strategy watches on every bar: the highest high and the
 * lowest low of the `lookback` bars before it, the bar itself excluded — the
 * same definition as `src/indicators/donchian.ts` and rule 1 of
 * BreakoutRetestV1 and FailedBreakoutV1. Null while the history is too short.
 */
export function channel(bars: readonly ChartBar[], lookback: number): (ChannelPoint | null)[] {
  return bars.map((_, end) => {
    const start = end - lookback;
    if (start < 0) return null;
    let high = -Infinity;
    let low = Infinity;
    for (let index = start; index < end; index++) {
      const bar = bars[index] as ChartBar;
      if (bar.high > high) high = bar.high;
      if (bar.low < low) low = bar.low;
    }
    return { high, low };
  });
}

export interface SwingLevel {
  readonly kind: "high" | "low";
  /** Index of the swing bar. */
  readonly index: number;
  readonly price: number;
  /** Index of the bar from which the level is known: the `wings`-th bar to the right. */
  readonly knownIndex: number;
  /** Last index the level is drawn to: the first close beyond it, its end of life, or the last bar. */
  readonly endIndex: number;
  /** True when a close went beyond the level. */
  readonly broken: boolean;
}

/**
 * Swing points as in StrongLevelD1 and ThreeTouchTrendD1: a high strictly above
 * the highs of `wings` bars on each side (a low mirrors it). A level lives
 * `life` bars after it becomes known, or until a bar closes beyond it.
 */
export function swingLevels(bars: readonly ChartBar[], wings: number, life: number): SwingLevel[] {
  const levels: SwingLevel[] = [];
  for (let index = wings; index + wings < bars.length; index++) {
    for (const kind of ["high", "low"] as const) {
      const value = (bar: ChartBar): number => (kind === "high" ? bar.high : bar.low);
      const centre = value(bars[index] as ChartBar);
      let swing = true;
      for (let other = index - wings; other <= index + wings && swing; other++) {
        if (other === index) continue;
        const v = value(bars[other] as ChartBar);
        if (kind === "high" ? v >= centre : v <= centre) swing = false;
      }
      if (!swing) continue;
      const knownIndex = index + wings;
      const lastIndex = Math.min(bars.length - 1, knownIndex + life);
      let endIndex = lastIndex;
      let broken = false;
      for (let next = index + 1; next <= lastIndex; next++) {
        const close = (bars[next] as ChartBar).close;
        if (kind === "high" ? close > centre : close < centre) {
          endIndex = next;
          broken = true;
          break;
        }
      }
      levels.push({ kind, index, price: centre, knownIndex, endIndex, broken });
    }
  }
  return levels;
}

const FOUR_HOURS = 4 * 3600;

/**
 * H4 candles from H1 by server time (00:00, 04:00, … 20:00), as MT5 draws them
 * and as SeriesBreakH4 builds them: a block with fewer than three hours is not
 * a candle. `serverTime` is the UTC-shifted server time of ChartBar.
 */
export function aggregateH4(hours: readonly ChartBar[]): ChartBar[] {
  const out: ChartBar[] = [];
  let block: { start: number; bars: ChartBar[] } | null = null;
  const flush = (): void => {
    if (block === null || block.bars.length < 3) return;
    const first = block.bars[0] as ChartBar;
    const last = block.bars[block.bars.length - 1] as ChartBar;
    out.push({
      time: first.time - (first.serverTime - block.start),
      serverTime: block.start,
      open: first.open,
      high: Math.max(...block.bars.map((bar) => bar.high)),
      low: Math.min(...block.bars.map((bar) => bar.low)),
      close: last.close,
      spreadPoints: Math.min(...block.bars.map((bar) => bar.spreadPoints)),
    });
  };
  for (const bar of hours) {
    const start = Math.floor(bar.serverTime / FOUR_HOURS) * FOUR_HOURS;
    if (block === null || block.start !== start) {
      flush();
      block = { start, bars: [] };
    }
    block.bars.push(bar);
  }
  flush();
  return out;
}

/** Index of the last bar that opens at or before `time` (UTC seconds), or -1. */
export function barAtOrBefore(bars: readonly ChartBar[], time: number): number {
  let low = 0;
  let high = bars.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((bars[middle] as ChartBar).time <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

export interface Segment {
  /** Bar indices, inclusive. */
  readonly from: number;
  readonly to: number;
  readonly value: number;
}

/**
 * Packs horizontal segments into as few rows as possible so that one line
 * series per row can draw them: segments in a row are at least two bars apart
 * (see `withGaps`), and every other bar is a gap. Returns, per row, one value
 * or null per bar.
 */
export function lanes(segments: readonly Segment[], barCount: number): (number | null)[][] {
  const rows: { lastTo: number; values: (number | null)[] }[] = [];
  const sorted = [...segments]
    .filter((segment) => segment.to >= 0 && segment.from < barCount && segment.from <= segment.to)
    .sort((a, b) => a.from - b.from);
  for (const segment of sorted) {
    const from = Math.max(0, segment.from);
    const to = Math.min(barCount - 1, segment.to);
    let row = rows.find((candidate) => candidate.lastTo < from - 2);
    if (row === undefined) {
      row = { lastTo: -2, values: new Array<number | null>(barCount).fill(null) };
      rows.push(row);
    }
    for (let index = from; index <= to; index++) row.values[index] = segment.value;
    row.lastTo = to;
  }
  return rows.map((row) => row.values);
}

export interface GapPoint {
  readonly value: number;
  /** Drawn transparent. */
  readonly gap: boolean;
}

/**
 * A line series joins its points across empty bars, so gaps between segments
 * are filled with invisible points instead: the first bar of a gap keeps the
 * previous segment's value and the rest take the next one's, so the jump
 * between levels happens between two invisible points. Null when no values.
 */
export function withGaps(values: readonly (number | null)[]): GapPoint[] | null {
  const known = values.findIndex((value) => value !== null);
  if (known === -1) return null;
  const out: GapPoint[] = [];
  let previous: number | null = null;
  for (let index = 0; index < values.length; index++) {
    const value = values[index] ?? null;
    if (value !== null) {
      out.push({ value, gap: false });
      previous = value;
      continue;
    }
    const startsGap = index > 0 && values[index - 1] !== null;
    let next: number | null = null;
    for (let ahead = index + 1; ahead < values.length && next === null; ahead++) next = values[ahead] ?? null;
    const fill = startsGap ? (previous ?? next) : (next ?? previous);
    out.push({ value: fill as number, gap: true });
  }
  return out;
}
