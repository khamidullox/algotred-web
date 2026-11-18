import { DateTime } from "luxon";
import { symbolConfig, type Config, type SymbolName } from "../config";
import type { Bar } from "../data/types";
import type { SymbolSpec } from "./symbols";
import type { Direction } from "./types";

/** Cost settings of one symbol for one run (TZ 7.3). */
export interface CostSettings {
  readonly minSpreadPoints: number;
  readonly commissionPerLotRoundTrip: number;
  readonly slippagePips: number;
  /** The instrument's own slippage in points (TZ 17.6), or null to use `slippagePips`. */
  readonly slippagePoints: number | null;
  /** Luxon weekday whose rollover charges three nights: 3 Wednesday, 5 Friday. */
  readonly tripleSwapWeekday: number;
  /** Price at which the swap pips were quoted; null keeps them fixed (TZ 17.6). */
  readonly swapReferencePrice: number | null;
  /** Pips per night, positive is a credit, as MT5 shows swap. */
  readonly swapLongPips: number;
  readonly swapShortPips: number;
  /** 1 for a normal run, 2 for the stress test: spread, commission and slippage are multiplied, swap is not. */
  readonly multiplier: number;
}

export function costSettings(
  config: Config,
  symbol: SymbolName,
  multiplier = 1,
): CostSettings {
  const { costs } = config;
  const own = symbolConfig(config, symbol);
  return {
    minSpreadPoints: own.minSpreadPoints ?? costs.minSpreadPoints,
    commissionPerLotRoundTrip:
      own.commissionPerLotRoundTrip ?? costs.commissionPerLotRoundTrip,
    slippagePips: costs.slippagePips,
    slippagePoints: own.slippagePoints ?? null,
    tripleSwapWeekday: own.tripleSwapDay === "friday" ? 5 : 3,
    swapReferencePrice: own.swapReferencePrice ?? null,
    swapLongPips: own.swapLongPips,
    swapShortPips: own.swapShortPips,
    multiplier,
  };
}

/** Spread of a bar in price units, after the floor and the stress multiplier. */
export function spreadOf(
  spec: SymbolSpec,
  bar: Bar,
  costs: CostSettings,
): number {
  return (
    Math.max(bar.spreadPoints, costs.minSpreadPoints) *
    spec.point *
    costs.multiplier
  );
}

/** Slippage of one execution in price units; the engine applies it against the trader. */
export function slippageOf(spec: SymbolSpec, costs: CostSettings): number {
  const perFill =
    costs.slippagePoints === null
      ? costs.slippagePips * spec.pip
      : costs.slippagePoints * spec.point;
  return perFill * costs.multiplier;
}

export function commissionUsd(lots: number, costs: CostSettings): number {
  return costs.commissionPerLotRoundTrip * lots * costs.multiplier;
}

export interface SwapNights {
  /** Rollovers that charge swap. */
  readonly nights: number;
  /** The same with the triple-swap day (Wednesday unless the instrument says otherwise) counted three times. */
  readonly weightedNights: number;
}

/**
 * Rollovers a position held from `from` to `to` (UTC ms) goes through. A
 * rollover is server midnight. As in MT5 for forex, the nights ending on
 * Saturday and Sunday charge nothing and the night ending on Wednesday charges
 * three; `tripleWeekday` 5 moves the triple night to Friday, as FundedNext does
 * for index CFDs (TZ 17.6). A position opened exactly at midnight does not pay
 * for that night; one closed exactly at midnight does.
 */
export function swapNights(
  from: number,
  to: number,
  zone: string,
  tripleWeekday = 3,
): SwapNights {
  let nights = 0;
  let weightedNights = 0;
  let midnight = DateTime.fromMillis(from, { zone })
    .startOf("day")
    .plus({ days: 1 });
  while (midnight.toMillis() <= to) {
    // Luxon weekdays: 1 = Monday ... 7 = Sunday. The night belongs to the day that ends.
    const ending = midnight.minus({ days: 1 }).weekday;
    if (ending <= 5) {
      nights++;
      weightedNights += ending === tripleWeekday ? 3 : 1;
    }
    midnight = midnight.plus({ days: 1 });
  }
  return { nights, weightedNights };
}

/** Swap for the whole holding period, in pips; positive is a credit. */
export function swapPips(
  direction: Direction,
  weightedNights: number,
  costs: CostSettings,
): number {
  const perNight =
    direction === "BUY" ? costs.swapLongPips : costs.swapShortPips;
  return perNight * weightedNights;
}

/** True when at least one swap setting is not zero (TZ 7.3: otherwise the report warns). */
export function swapConfigured(config: Config): boolean {
  return Object.values(config.symbols).some(
    (own) => own.swapLongPips !== 0 || own.swapShortPips !== 0,
  );
}
