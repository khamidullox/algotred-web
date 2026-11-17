import { pipValueUsdPerLot, type SymbolSpec } from "./symbols";

/** Lots are rounded down to this step; below it the trade is skipped (TZ 7.4). */
export const LOT_STEP = 0.01;

/**
 * Lots that risk `riskUsd` when the stop is hit exactly, rounded down to 0.01.
 * Returns 0 when even 0.01 lot risks too much. The pip value of USDJPY is taken
 * at `price`, the entry fill.
 */
export function lotsForRisk(
  spec: SymbolSpec,
  riskUsd: number,
  stopDistance: number,
  price: number,
): number {
  if (!(stopDistance > 0) || !(riskUsd > 0)) {
    return 0;
  }
  const stopPips = stopDistance / spec.pip;
  const raw = riskUsd / (stopPips * pipValueUsdPerLot(spec, price));
  // The epsilon keeps 0.29999999999 from becoming 0.29. Dividing by 100 at the
  // end gives the exact double for the two-decimal lot.
  const steps = Math.floor(raw / LOT_STEP + 1e-9);
  return steps / 100;
}

/** USD lost when a position of `lots` is stopped out exactly at the stop, before costs. */
export function riskAtStopUsd(
  spec: SymbolSpec,
  lots: number,
  stopDistance: number,
  price: number,
): number {
  return (stopDistance / spec.pip) * pipValueUsdPerLot(spec, price) * lots;
}
