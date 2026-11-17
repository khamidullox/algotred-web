import { symbolConfig, type Config } from "../config";

export interface SymbolSpec {
  readonly symbol: string;
  /** Decimal places of a quote: 5 for the USD-quoted pairs, 3 for USDJPY, 2 for gold. */
  readonly digits: number;
  /** Smallest price step; the unit of the MT5 <SPREAD> column. */
  readonly point: number;
  /** Ten points. */
  readonly pip: number;
  /** Units of the base asset in one standard lot. */
  readonly contractSize: number;
  /** Which side of the instrument the dollar is on. */
  readonly usdSide: "base" | "quote";
}

/** The spec of an instrument from the config (TZ 17): point and pip follow from the digits. */
export function symbolSpec(config: Config, symbol: string): SymbolSpec {
  const own = symbolConfig(config, symbol);
  return {
    symbol,
    digits: own.digits,
    point: 10 ** -own.digits,
    pip: 10 ** -(own.digits - 1),
    contractSize: own.contractSize,
    usdSide: own.usdSide,
  };
}

/** Rounds to the quote precision of the symbol: removes floating-point noise after price arithmetic. */
export function roundPrice(spec: SymbolSpec, price: number): number {
  const factor = 10 ** spec.digits;
  return Math.round(price * factor) / factor;
}

/**
 * USD value of a one-pip move for one lot. Fixed for USD-quoted instruments;
 * for USD-based pairs the quote-currency amount is converted at `price` (TZ 7.4).
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
