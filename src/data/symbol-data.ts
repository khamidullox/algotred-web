import { SYMBOLS, TIMEFRAMES, type Timeframe } from "../config";
import type { SymbolData } from "../engine/backtest";
import type { Bar } from "./types";
import { barsInSpan } from "./bars";
import type { SeriesInput } from "./load";
import type { TimeSpan } from "./time";

/**
 * Groups validated series by symbol and cuts every timeframe to the common
 * period, so the engine never sees the partial last day of an export.
 * Call it only after `validateSeries` reported no errors.
 */
export function buildSymbolData(
  inputs: readonly SeriesInput[],
  commonRange: TimeSpan,
): SymbolData[] {
  return SYMBOLS.map((symbol) => {
    const bars = {} as Record<Timeframe, readonly Bar[]>;
    for (const timeframe of TIMEFRAMES) {
      const input = inputs.find(
        (candidate) =>
          candidate.id.symbol === symbol && candidate.id.timeframe === timeframe,
      );
      bars[timeframe] = barsInSpan(input?.parsed?.bars ?? [], commonRange);
    }
    return { symbol, bars };
  });
}
