import type { Bar } from "../data/types";
import type { Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { donchian } from "../indicators/donchian";

/** Fixed by TZ 8.1. Not configurable on purpose. */
export const TREND_D1 = {
  entryLookback: 55,
  exitLookback: 20,
  atrPeriod: 20,
  atrMultiple: 2,
} as const;

/**
 * TrendD1 (TZ 8.1): a daily breakout that mostly checks the engine.
 *
 * Buy when a D1 bar closes above the high of the previous 55 D1 bars, sell
 * when it closes below the low of the previous 55; enter at the next open with
 * a stop 2 x ATR(20) away; leave when a D1 bar closes beyond the 20-bar
 * channel on the other side. No take, no time filter.
 *
 * The strategy runs on H1 bars (TZ 7.2 allows H1 for a D1 strategy) and acts
 * only when a D1 bar has closed, so the entry is the first H1 open of the next
 * day: the D1 open. While a position is open only the exit rule is checked:
 * a 55-bar breakout against the position closes it and does not reverse it.
 */
export const trendD1: Strategy = {
  name: "TrendD1",
  params: {
    ...TREND_D1,
    atrMethod: "Wilder",
    signalTimeframe: "D1",
    executionTimeframe: "H1",
  },
  executionTimeframe: "H1",
  create: () => {
    const atr = new AtrWilder(TREND_D1.atrPeriod);
    return {
      onBarClose(ctx) {
        if (!ctx.justClosed("D1")) return null;
        const d1 = ctx.bars("D1");
        const last = d1.last();
        if (last === undefined) return null;
        const atrValue = atr.update(d1);
        const digits = ctx.spec.digits;
        const price = (value: number): string => value.toFixed(digits);

        const position = ctx.position;
        if (position !== null) {
          const channel = donchian(d1, TREND_D1.exitLookback);
          if (channel === null) return null;
          if (position.direction === "BUY" && last.close < channel.low) {
            return {
              kind: "exit",
              reason: `D1 close ${price(last.close)} < low(${TREND_D1.exitLookback}) ${price(channel.low)}`,
            };
          }
          if (position.direction === "SELL" && last.close > channel.high) {
            return {
              kind: "exit",
              reason: `D1 close ${price(last.close)} > high(${TREND_D1.exitLookback}) ${price(channel.high)}`,
            };
          }
          return null;
        }

        const channel = donchian(d1, TREND_D1.entryLookback);
        if (channel === null || Number.isNaN(atrValue)) return null;
        const stopDistance = TREND_D1.atrMultiple * atrValue;
        const atrText = `ATR(${TREND_D1.atrPeriod}) ${price(atrValue)}`;
        if (last.close > channel.high) {
          return {
            kind: "entry",
            direction: "BUY",
            stopLoss: { distance: stopDistance },
            takeProfit: null,
            reason: `D1 close ${price(last.close)} > high(${TREND_D1.entryLookback}) ${price(channel.high)}; ${atrText}`,
          };
        }
        if (last.close < channel.low) {
          return {
            kind: "entry",
            direction: "SELL",
            stopLoss: { distance: stopDistance },
            takeProfit: null,
            reason: `D1 close ${price(last.close)} < low(${TREND_D1.entryLookback}) ${price(channel.low)}; ${atrText}`,
          };
        }
        return null;
      },
    };
  },
};

/** The bar a D1 signal was computed on: the last closed daily bar. Exported for tests. */
export function lastDaily(bars: { last(): Bar | undefined }): Bar | undefined {
  return bars.last();
}
