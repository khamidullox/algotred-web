import type { Bar } from "../data/types";
import { slippageOf, spreadOf, type CostSettings } from "./costs";
import { roundPrice, type SymbolSpec } from "./symbols";
import type { Direction, Signal } from "./types";

/**
 * One execution. `raw` is the price with spread and slippage at zero: the bar
 * open for a market order, the level for a stop or take. `price` is the fill.
 */
export interface Fill {
  readonly raw: number;
  readonly price: number;
  /** Spread paid in this execution, price units. */
  readonly spread: number;
  /** Slippage paid in this execution, price units. */
  readonly slippage: number;
}

/**
 * Entry at the open of `bar` (TZ 7.2): a buy pays the Ask, `open + spread`;
 * a sell gets the Bid, `open`. Slippage is against the trader.
 */
export function fillEntry(
  spec: SymbolSpec,
  direction: Direction,
  bar: Bar,
  costs: CostSettings,
): Fill {
  const slippage = slippageOf(spec, costs);
  if (direction === "BUY") {
    const spread = spreadOf(spec, bar, costs);
    return {
      raw: bar.open,
      price: roundPrice(spec, bar.open + spread + slippage),
      spread,
      slippage,
    };
  }
  return {
    raw: bar.open,
    price: roundPrice(spec, bar.open - slippage),
    spread: 0,
    slippage,
  };
}

/**
 * Closing at a market price (a strategy exit at the open, or the end of the
 * data at the close): a buy is sold at the Bid, a sell is bought back at the Ask.
 */
export function fillMarketExit(
  spec: SymbolSpec,
  direction: Direction,
  bar: Bar,
  bidPrice: number,
  costs: CostSettings,
): Fill {
  const slippage = slippageOf(spec, costs);
  if (direction === "BUY") {
    return {
      raw: bidPrice,
      price: roundPrice(spec, bidPrice - slippage),
      spread: 0,
      slippage,
    };
  }
  const spread = spreadOf(spec, bar, costs);
  return {
    raw: bidPrice,
    price: roundPrice(spec, bidPrice + spread + slippage),
    spread,
    slippage,
  };
}

/**
 * A resting limit order inside `bar` (TZ 17.10), or null when the price was
 * not reached. A buy limit is an Ask price: it fills when `low + spread`
 * reaches it, at the open Ask when the bar opens below it. A sell limit is a
 * Bid price: it fills when `high` reaches it, at the open when the bar opens
 * above it. Limit fills have no slippage.
 */
export function fillLimit(
  spec: SymbolSpec,
  direction: Direction,
  bar: Bar,
  price: number,
  costs: CostSettings,
): Fill | null {
  if (direction === "BUY") {
    const spread = spreadOf(spec, bar, costs);
    const ask = (bid: number): number => roundPrice(spec, bid + spread);
    if (ask(bar.open) <= price) {
      return { raw: bar.open, price: ask(bar.open), spread, slippage: 0 };
    }
    if (ask(bar.low) <= price) {
      return { raw: roundPrice(spec, price - spread), price, spread, slippage: 0 };
    }
    return null;
  }
  if (bar.open >= price) return { raw: bar.open, price: bar.open, spread: 0, slippage: 0 };
  if (bar.high >= price) return { raw: price, price, spread: 0, slippage: 0 };
  return null;
}

/** True when the Bid of `bar` reaches the cancel level of a resting order: above it for a buy, below for a sell. */
export function limitCancelReached(direction: Direction, bar: Bar, cancelAt: number): boolean {
  return direction === "BUY" ? bar.high >= cancelAt : bar.low <= cancelAt;
}

export interface StopHit {
  readonly reason: "stop" | "take";
  readonly fill: Fill;
}

/**
 * Checks the stop and the take inside one bar (TZ 7.2).
 *
 * Buy: the stop is hit when `low <= SL`, the take when `high >= TP`, both on
 * the Bid. Sell: the position is closed by buying at the Ask, so the stop is
 * hit when `high + spread >= SL` and the take when `low + spread <= TP`.
 * When both are hit in one bar the stop counts. A bar that opens beyond a
 * level fills at the open, not at the level.
 */
export function checkStops(
  spec: SymbolSpec,
  direction: Direction,
  bar: Bar,
  stopLoss: number,
  takeProfit: number | null,
  costs: CostSettings,
): StopHit | null {
  const slippage = slippageOf(spec, costs);

  if (direction === "BUY") {
    const hit = (raw: number, reason: "stop" | "take"): StopHit => ({
      reason,
      fill: {
        raw,
        price: roundPrice(spec, raw - slippage),
        spread: 0,
        slippage,
      },
    });
    if (bar.open <= stopLoss) return hit(bar.open, "stop");
    if (takeProfit !== null && bar.open >= takeProfit) {
      return hit(bar.open, "take");
    }
    if (bar.low <= stopLoss) return hit(stopLoss, "stop");
    if (takeProfit !== null && bar.high >= takeProfit) {
      return hit(takeProfit, "take");
    }
    return null;
  }

  const spread = spreadOf(spec, bar, costs);
  const ask = (bid: number): number => roundPrice(spec, bid + spread);
  // A gap fills at the open Ask: the spread is paid in the price. A level
  // fills at the level itself, which is already an Ask price.
  const hit = (
    raw: number,
    spreadPaid: number,
    reason: "stop" | "take",
  ): StopHit => ({
    reason,
    fill: {
      raw,
      price: roundPrice(spec, raw + spreadPaid + slippage),
      spread: spreadPaid,
      slippage,
    },
  });
  if (ask(bar.open) >= stopLoss) return hit(bar.open, spread, "stop");
  if (takeProfit !== null && ask(bar.open) <= takeProfit) {
    return hit(bar.open, spread, "take");
  }
  if (ask(bar.high) >= stopLoss) return hit(stopLoss, 0, "stop");
  if (takeProfit !== null && ask(bar.low) <= takeProfit) {
    return hit(takeProfit, 0, "take");
  }
  return null;
}

export type ResolvedLevels =
  | {
      readonly ok: true;
      readonly stopLoss: number;
      readonly takeProfit: number | null;
      readonly stopDistance: number;
    }
  | { readonly ok: false; readonly detail: string };

/** Turns the stop and take of a signal into prices, given the actual entry fill. */
export function resolveLevels(
  spec: SymbolSpec,
  direction: Direction,
  entryPrice: number,
  signal: Signal,
): ResolvedLevels {
  const sign = direction === "BUY" ? 1 : -1;
  const stopLoss = roundPrice(
    spec,
    "price" in signal.stopLoss
      ? signal.stopLoss.price
      : entryPrice - sign * signal.stopLoss.distance,
  );
  const stopDistance = roundPrice(spec, sign * (entryPrice - stopLoss));
  if (!(stopDistance > 0)) {
    return {
      ok: false,
      detail: `стоп ${stopLoss} не с той стороны от входа ${entryPrice}`,
    };
  }

  let takeProfit: number | null = null;
  if (signal.takeProfit !== null) {
    takeProfit = roundPrice(
      spec,
      "price" in signal.takeProfit
        ? signal.takeProfit.price
        : entryPrice + sign * signal.takeProfit.rMultiple * stopDistance,
    );
    if (!(sign * (takeProfit - entryPrice) > 0)) {
      return {
        ok: false,
        detail: `тейк ${takeProfit} не с той стороны от входа ${entryPrice}`,
      };
    }
  }

  return { ok: true, stopLoss, takeProfit, stopDistance };
}
