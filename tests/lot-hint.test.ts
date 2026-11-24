import { describe, expect, it } from "vitest";
import { lotDigitsOf, lotHint, type LotRules } from "../src/signals/lot-hint";

/** An index CFD as FundedNext gives it: 10 USD a point for a lot, lots of 0.01. */
const INDEX: LotRules = { moneyPerPointPerLot: 10, lotStep: 0.01, lotMin: 0.01, lotMax: 0 };

describe("lotHint", () => {
  it("rounds the lot down to the step, so the stop never loses more than the risk", () => {
    // 60 USD at risk, the stop 120.7 points away: one lot loses 1207 USD, 60 / 1207 = 0.0497 lots.
    const hint = lotHint(INDEX, 60, 120.7);
    expect(hint?.lots).toBe(0.04);
    expect(hint?.riskMoney).toBeCloseTo(48.28, 10);
    expect(hint?.minLotRiskMoney).toBeCloseTo(12.07, 10);
    expect(hint?.lotDigits).toBe(2);
  });

  it("does not lose a whole step to floating-point noise", () => {
    // 0.3 lots exactly: 30 / (10 * 10) is 0.3, and 0.3 / 0.01 is 29.999999999999996.
    expect(lotHint(INDEX, 30, 10)?.lots).toBe(0.3);
    expect(lotHint({ ...INDEX, lotStep: 0.1, lotMin: 0.1 }, 30, 10)?.lots).toBe(0.3);
  });

  it("gives no lots when even the minimum lot risks more than allowed", () => {
    // The Dow at 10 USD a point: a stop of 900 points costs 90 USD with 0.01 lot.
    const hint = lotHint(INDEX, 60, 900);
    expect(hint?.lots).toBe(0);
    expect(hint?.riskMoney).toBe(0);
    expect(hint?.minLotRiskMoney).toBeCloseTo(90, 10);
    // At exactly the allowed risk the minimum lot passes.
    expect(lotHint(INDEX, 90, 900)?.lots).toBe(0.01);
  });

  it("follows the broker's step, minimum and maximum", () => {
    const coarse: LotRules = { moneyPerPointPerLot: 1, lotStep: 0.1, lotMin: 0.5, lotMax: 2 };
    // 100 / 50 = 2 lots raw; 79 / 50 = 1.58 -> 1.5; 24 / 50 = 0.48 -> 0.4, below the minimum 0.5.
    expect(lotHint(coarse, 79, 50)?.lots).toBe(1.5);
    expect(lotHint(coarse, 79, 50)?.lotDigits).toBe(1);
    expect(lotHint(coarse, 24, 50)?.lots).toBe(0);
    expect(lotHint(coarse, 24, 50)?.minLotRiskMoney).toBe(25);
    // 500 / 50 = 10 lots raw, capped at the maximum.
    expect(lotHint(coarse, 500, 50)?.lots).toBe(2);
    expect(lotHint(coarse, 500, 50)?.riskMoney).toBe(100);
  });

  it("answers null when a lot cannot be counted at all", () => {
    expect(lotHint({ ...INDEX, moneyPerPointPerLot: 0 }, 60, 100)).toBeNull();
    expect(lotHint({ ...INDEX, lotStep: 0 }, 60, 100)).toBeNull();
    expect(lotHint({ ...INDEX, lotMin: 0 }, 60, 100)).toBeNull();
    expect(lotHint(INDEX, 0, 100)).toBeNull();
    expect(lotHint(INDEX, 60, 0)).toBeNull();
    expect(lotHint(INDEX, Number.NaN, 100)).toBeNull();
    expect(lotHint(INDEX, 60, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("lotDigitsOf", () => {
  it("is the number of decimals of the lot step", () => {
    expect(lotDigitsOf(1)).toBe(0);
    expect(lotDigitsOf(0.1)).toBe(1);
    expect(lotDigitsOf(0.01)).toBe(2);
    expect(lotDigitsOf(0.001)).toBe(3);
  });
});
