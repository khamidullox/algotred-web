// A parameterised "buy the dip" strategy on daily bars, for the search of
// TZ 17.17. Every rule reads closed D1 bars; orders fill at the next open of
// the execution timeframe (H1), as in Rsi2ReversionD1.
import type { Bar } from "../src/data/types";
import type { Strategy, StrategyAction } from "../src/engine/types";
import { AtrWilder } from "../src/indicators/atr";
import { RsiWilder } from "../src/indicators/rsi";
import { Sma } from "../src/indicators/sma";

export type DipExit =
  /** The close is above SMA(period): Connors' exit. */
  | { readonly kind: "sma"; readonly period: number }
  /** The close is above the high of the day before. */
  | { readonly kind: "prevHigh" }
  /** RSI(rsiPeriod) is above the value. */
  | { readonly kind: "rsiAbove"; readonly value: number }
  /** The close is in the upper part of the day's range. */
  | { readonly kind: "ibsAbove"; readonly value: number }
  /** A fixed number of daily closes in the trade. */
  | { readonly kind: "days"; readonly n: number };

export interface DipParams {
  readonly symbols: readonly string[];
  readonly rsiPeriod: number;
  /** Entry: RSI below this; null switches the condition off. */
  readonly rsiBelow: number | null;
  /** Entry: (close - low) / (high - low) below this. */
  readonly ibsBelow: number | null;
  /** Entry: that share at or above this; with `ibsBelow` it makes a band (the control of a neutral close). */
  readonly ibsFrom?: number | null;
  /** False leaves only the mirrored sells. */
  readonly longs?: boolean;
  /** Entry: at least this many lower closes in a row. */
  readonly downDays: number | null;
  /** Entry: the close is above SMA of this period; null means no trend filter. */
  readonly trendSma: number | null;
  /** Also sell the mirrored setup below the trend average. */
  readonly shorts: boolean;
  readonly exit: DipExit;
  /** Leave after this many daily closes whatever the exit rule says. */
  readonly maxDays: number | null;
  readonly atrPeriod: number;
  /** The stop, in ATR; it also sizes the lot. */
  readonly atrMultiple: number;
}

export const ibs = (bar: Bar): number => (bar.high === bar.low ? 0.5 : (bar.close - bar.low) / (bar.high - bar.low));

export function describe(p: DipParams): string {
  const entry = [
    p.rsiBelow === null ? null : `rsi${p.rsiPeriod}<${p.rsiBelow}`,
    p.ibsBelow === null ? null : `ibs<${p.ibsBelow}`,
    p.ibsFrom === undefined || p.ibsFrom === null ? null : `ibs>=${p.ibsFrom}`,
    p.downDays === null ? null : `down>=${p.downDays}`,
  ].filter((part) => part !== null);
  const exit =
    p.exit.kind === "sma" ? `c>sma${p.exit.period}`
    : p.exit.kind === "prevHigh" ? "c>prevHigh"
    : p.exit.kind === "rsiAbove" ? `rsi>${p.exit.value}`
    : p.exit.kind === "ibsAbove" ? `ibs>${p.exit.value}`
    : `days${p.exit.n}`;
  return `${entry.join("&")} | ${p.trendSma === null ? "no trend" : `c>sma${p.trendSma}`} | exit ${exit}${p.maxDays === null ? "" : ` max${p.maxDays}d`} | stop ${p.atrMultiple}atr${p.shorts ? " | +shorts" : ""}${p.longs === false ? " | no longs" : ""}`;
}

export function dipStrategy(p: DipParams): Strategy {
  return {
    name: "ResearchDip",
    params: { rule: describe(p) },
    executionTimeframe: "H1",
    symbols: p.symbols,
    create: () => {
      const atr = new AtrWilder(p.atrPeriod);
      const rsi = new RsiWilder(p.rsiPeriod);
      const trend = p.trendSma === null ? null : new Sma(p.trendSma);
      const exitSma = p.exit.kind === "sma" ? new Sma(p.exit.period) : null;
      /** Daily closes seen with the position open. */
      let held = 0;
      return {
        onBarClose(ctx): StrategyAction | null {
          if (!ctx.justClosed("D1")) return null;
          const bars = ctx.bars("D1");
          const last = bars.last();
          const previous = bars.at(-2);
          if (last === undefined || previous === undefined) return null;
          const atrValue = atr.update(bars);
          const rsiValue = rsi.update(bars);
          const trendValue = trend === null ? Number.NaN : trend.update(bars);
          const exitValue = exitSma === null ? Number.NaN : exitSma.update(bars);

          const position = ctx.position;
          if (position !== null) {
            held++;
            const long = position.direction === "BUY";
            const side = long ? 1 : -1;
            const e = p.exit;
            const out =
              e.kind === "sma" ? !Number.isNaN(exitValue) && side * (last.close - exitValue) > 0
              : e.kind === "prevHigh" ? (long ? last.close > previous.high : last.close < previous.low)
              : e.kind === "rsiAbove" ? (long ? rsiValue > e.value : rsiValue < 100 - e.value)
              : e.kind === "ibsAbove" ? (long ? ibs(last) > e.value : ibs(last) < 1 - e.value)
              : held >= e.n;
            if (out || (p.maxDays !== null && held >= p.maxDays)) return { kind: "exit", reason: "research exit" };
            return null;
          }
          held = 0;

          if (Number.isNaN(atrValue) || Number.isNaN(rsiValue) || (trend !== null && Number.isNaN(trendValue))) return null;
          const lowerCloses = (count: number, sign: 1 | -1): boolean => {
            for (let k = 1; k <= count; k++) {
              const a = bars.at(-k);
              const b = bars.at(-k - 1);
              if (a === undefined || b === undefined || !(sign * (b.close - a.close) > 0)) return false;
            }
            return true;
          };
          const setup = (sign: 1 | -1): boolean => {
            if (trend !== null && !(sign * (last.close - trendValue) > 0)) return false;
            if (p.rsiBelow !== null && !(sign === 1 ? rsiValue < p.rsiBelow : rsiValue > 100 - p.rsiBelow)) return false;
            if (p.ibsBelow !== null && !(sign === 1 ? ibs(last) < p.ibsBelow : ibs(last) > 1 - p.ibsBelow)) return false;
            if (p.ibsFrom !== undefined && p.ibsFrom !== null && !(sign === 1 ? ibs(last) >= p.ibsFrom : ibs(last) <= 1 - p.ibsFrom)) return false;
            if (p.downDays !== null && !lowerCloses(p.downDays, sign)) return false;
            return true;
          };
          const buy = p.longs !== false && setup(1);
          const sell = !buy && p.shorts && setup(-1);
          if (!buy && !sell) return null;
          return {
            kind: "entry",
            direction: buy ? "BUY" : "SELL",
            stopLoss: { distance: p.atrMultiple * atrValue },
            takeProfit: null,
            reason: "research entry",
          };
        },
      };
    },
  };
}
