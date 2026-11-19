import type { AnyTimeframe, SymbolName, Timeframe } from "../config";

/** One closed candle. Prices are Bid, as exported by MT5. */
export interface Bar {
  /** Bar open time, UTC, milliseconds since the Unix epoch. */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly tickVolume: number;
  /**
   * Spread in points from the MT5 <SPREAD> column. On the real exports this is
   * the minimum spread seen inside the bar, not a typical one.
   */
  readonly spreadPoints: number;
}

export interface SeriesId {
  readonly symbol: SymbolName;
  readonly timeframe: Timeframe;
}

export const TIMEFRAME_MINUTES: Readonly<Record<AnyTimeframe, number>> = {
  M1: 1,
  M5: 5,
  M15: 15,
  H1: 60,
  D1: 1440,
};

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
