import type { SymbolName } from "../config";

export interface SymbolSpec {
  readonly symbol: SymbolName;
  /** Decimal places of a quote: 5 for the USD-quoted pairs, 3 for USDJPY. */
  readonly digits: number;
  /** Smallest price step; the unit of the MT5 <SPREAD> column. */
  readonly point: number;
  /** Ten points. */
  readonly pip: number;
  /** Units of the base currency in one standard lot. */
  readonly contractSize: number;
  /** Which side of the pair the dollar is on. */
  readonly usdSide: "base" | "quote";
}

export const CONTRACT_SIZE = 100_000;

export const SYMBOL_SPECS: Readonly<Record<SymbolName, SymbolSpec>> = {
  EURUSD: {
    symbol: "EURUSD",
    digits: 5,
    point: 0.00001,
    pip: 0.0001,
    contractSize: CONTRACT_SIZE,
    usdSide: "quote",
  },
  GBPUSD: {
    symbol: "GBPUSD",
    digits: 5,
    point: 0.00001,
    pip: 0.0001,
    contractSize: CONTRACT_SIZE,
    usdSide: "quote",
  },
  USDJPY: {
    symbol: "USDJPY",
    digits: 3,
    point: 0.001,
    pip: 0.01,
    contractSize: CONTRACT_SIZE,
    usdSide: "base",
  },
};

/** Rounds to the quote precision of the symbol: removes floating-point noise after price arithmetic. */
export function roundPrice(spec: SymbolSpec, price: number): number {
  const factor = 10 ** spec.digits;
  return Math.round(price * factor) / factor;
}

/**
 * USD value of a one-pip move for one lot. Fixed (10 USD) for the USD-quoted
 * pairs; for USDJPY the JPY amount is converted at `price` (TZ 7.4).
 */
export function pipValueUsdPerLot(spec: SymbolSpec, price: number): number {
  const quoteValue = spec.pip * spec.contractSize;
  return spec.usdSide === "quote" ? quoteValue : quoteValue / price;
}

/** USD value of a price difference on `lots`, converted at `rate` when the quote currency is not USD. */
export function priceDiffToUsd(
  spec: SymbolSpec,
  diff: number,
  lots: number,
  rate: number,
): number {
  const quote = diff * lots * spec.contractSize;
  return spec.usdSide === "quote" ? quote : quote / rate;
}

/** The side of the dollar a position takes: a long EURUSD is short USD, a long USDJPY is long USD. */
export function usdDirection(
  spec: SymbolSpec,
  direction: "BUY" | "SELL",
): "long" | "short" {
  const longUsd = (direction === "BUY") === (spec.usdSide === "base");
  return longUsd ? "long" : "short";
}
