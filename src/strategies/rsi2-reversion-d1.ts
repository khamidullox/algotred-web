import type { Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { RsiWilder } from "../indicators/rsi";
import { Sma } from "../indicators/sma";
import { FX_AND_GOLD } from "./baskets";

/** Fixed by TZ 17.4 (approved 2026-11-18). Not configurable on purpose. */
export const RSI2_REVERSION = {
  rsiPeriod: 2,
  buyBelowRsi: 5,
  sellAboveRsi: 95,
  trendSmaPeriod: 200,
  exitSmaPeriod: 5,
  atrPeriod: 20,
  atrMultiple: 2,
} as const;

/**
 * Rsi2ReversionD1 (TZ 17.4): Connors and Alvarez's 2-period RSI system on
 * daily bars. Buy when a D1 bar closes above SMA(200) with RSI(2) below 5,
 * sell when it closes below SMA(200) with RSI(2) above 95; enter at the next
 * D1 open with a stop 2 x ATR(20) away (the engine needs a stop to size the
 * lot); leave at the next open after the first D1 close beyond SMA(5) the
 * other way. No take, no time filter.
 *
 * Runs on H1 like TrendD1 and acts only when a D1 bar has closed. While a
 * position is open only the exit rule is checked; once it is closed (by the
 * stop inside the day, say) the same day's close may give a new signal.
 */
export const rsi2ReversionD1: Strategy = {
  name: "Rsi2ReversionD1",
  params: {
    ...RSI2_REVERSION,
    rsiMethod: "Wilder (as MT5 Relative Strength Index)",
    atrMethod: "Wilder",
    signalTimeframe: "D1",
    executionTimeframe: "H1",
  },
  executionTimeframe: "H1",
  symbols: FX_AND_GOLD,
  create: () => {
    const atr = new AtrWilder(RSI2_REVERSION.atrPeriod);
    const rsi = new RsiWilder(RSI2_REVERSION.rsiPeriod);
    const trend = new Sma(RSI2_REVERSION.trendSmaPeriod);
    const exit = new Sma(RSI2_REVERSION.exitSmaPeriod);
    return {
      onBarClose(ctx) {
        if (!ctx.justClosed("D1")) return null;
        const d1 = ctx.bars("D1");
        const last = d1.last();
        if (last === undefined) return null;
        const atrValue = atr.update(d1);
        const rsiValue = rsi.update(d1);
        const trendValue = trend.update(d1);
        const exitValue = exit.update(d1);
        const price = (value: number): string => value.toFixed(ctx.spec.digits);

        // Rule 4: the exit, checked from the close of the entry day on.
        const position = ctx.position;
        if (position !== null) {
          if (Number.isNaN(exitValue)) return null;
          if (position.direction === "BUY" ? last.close > exitValue : last.close < exitValue) {
            const side = position.direction === "BUY" ? ">" : "<";
            return {
              kind: "exit",
              reason: `D1 close ${price(last.close)} ${side} SMA(${RSI2_REVERSION.exitSmaPeriod}) ${price(exitValue)}`,
            };
          }
          return null;
        }

        // Rules 1-3 and 5 with no position open (rule 6).
        if (Number.isNaN(atrValue) || Number.isNaN(rsiValue) || Number.isNaN(trendValue)) {
          return null;
        }
        const buy = last.close > trendValue && rsiValue < RSI2_REVERSION.buyBelowRsi;
        const sell = last.close < trendValue && rsiValue > RSI2_REVERSION.sellAboveRsi;
        if (!buy && !sell) return null;
        return {
          kind: "entry",
          direction: buy ? "BUY" : "SELL",
          stopLoss: { distance: RSI2_REVERSION.atrMultiple * atrValue },
          takeProfit: null,
          reason:
            `D1 close ${price(last.close)} ${buy ? ">" : "<"} SMA(${RSI2_REVERSION.trendSmaPeriod}) ${price(trendValue)}; ` +
            `RSI(${RSI2_REVERSION.rsiPeriod}) ${rsiValue.toFixed(2)}; ATR(${RSI2_REVERSION.atrPeriod}) ${price(atrValue)}`,
        };
      },
    };
  },
};
