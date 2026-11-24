/**
 * The lot for a chosen risk, from the broker's contract facts. Pure arithmetic
 * with no engine types: the "Signals" page runs it in the browser when the
 * deposit or the risk is typed in, and the server runs it for the terminal
 * feed. tools/mt5/Rsi2IndexSignal.mq5 (`LotText`) does the same in MQL5.
 */

/** What one lot loses and how lots may be chosen. */
export interface LotRules {
  /** Money lost by one lot when the price moves 1.0 against it, in the account currency. */
  readonly moneyPerPointPerLot: number;
  readonly lotStep: number;
  readonly lotMin: number;
  /** 0 when there is no upper limit. */
  readonly lotMax: number;
}

export interface LotHint {
  /** Lots for the risk, rounded down to the lot step; 0 when even the minimum lot risks more. */
  readonly lots: number;
  /** Money lost at the stop with `lots`. */
  readonly riskMoney: number;
  /** Money lost at the stop with the minimum lot. */
  readonly minLotRiskMoney: number;
  /** Decimals a lot is written with. */
  readonly lotDigits: number;
}

/** Decimals of the lot step: 0.01 gives 2, 0.1 gives 1, 1 gives 0. */
export function lotDigitsOf(lotStep: number): number {
  if (lotStep >= 1) return 0;
  if (lotStep >= 0.1) return 1;
  if (lotStep >= 0.01) return 2;
  return 3;
}

/**
 * Lots that lose at most `riskMoney` when the stop `stopDistance` away is hit
 * exactly. Rounded down to the lot step, as the engine does (TZ 7.4); below
 * the minimum lot the answer is 0 lots: the rule skips such a trade. Null
 * when the inputs cannot give a lot at all.
 */
export function lotHint(rules: LotRules, riskMoney: number, stopDistance: number): LotHint | null {
  const { moneyPerPointPerLot, lotStep, lotMin, lotMax } = rules;
  if (!(moneyPerPointPerLot > 0) || !(lotStep > 0) || !(lotMin > 0)) return null;
  if (!(riskMoney > 0) || !(stopDistance > 0) || !Number.isFinite(riskMoney) || !Number.isFinite(stopDistance)) return null;
  const lossPerLot = stopDistance * moneyPerPointPerLot;
  const lotDigits = lotDigitsOf(lotStep);
  // The epsilon keeps 0.29999999999 from becoming 0.29.
  const steps = Math.floor(riskMoney / lossPerLot / lotStep + 1e-9);
  let lots = Number((steps * lotStep).toFixed(lotDigits));
  if (lotMax > 0 && lots > lotMax) lots = lotMax;
  if (lots < lotMin - 1e-12) lots = 0;
  return { lots, riskMoney: lots * lossPerLot, minLotRiskMoney: lotMin * lossPerLot, lotDigits };
}
