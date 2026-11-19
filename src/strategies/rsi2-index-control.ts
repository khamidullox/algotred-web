import type { Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { RsiWilder } from "../indicators/rsi";
import { Sma } from "../indicators/sma";
import { US_INDICES } from "./baskets";
import { RSI2_REVERSION } from "./rsi2-reversion-d1";

/** Fixed by TZ 17.12 (approved 2026-11-19). Not configurable on purpose. */
export const RSI2_INDEX_CONTROL = {
  /** RSI(2) inside [low, high] is neither oversold nor overbought. */
  neutralRsiLow: 45,
  neutralRsiHigh: 55,
  /** Exit at the next open after this many D1 closes, the entry day counted. */
  holdDays: 4,
} as const;

/**
 * Rsi2IndexControl (TZ 17.12): the control for Rsi2ReversionIndexD1. Same
 * instruments, SMA(200) trend side, stop and costs, but it enters on a
 * neutral RSI(2) (45 to 55) and holds four D1 closes. It shows what a few
 * days in the trend's direction earned in 2015–2021 without any dip, so the
 * RSI(2) effect can be told apart from the rally. Informational: never a
 * candidate for test.
 */
export const rsi2IndexControl: Strategy = {
  name: "Rsi2IndexControl",
  params: {
    rsiPeriod: RSI2_REVERSION.rsiPeriod,
    trendSmaPeriod: RSI2_REVERSION.trendSmaPeriod,
    atrPeriod: RSI2_REVERSION.atrPeriod,
    atrMultiple: RSI2_REVERSION.atrMultiple,
    ...RSI2_INDEX_CONTROL,
    signalTimeframe: "D1",
    executionTimeframe: "H1",
  },
  executionTimeframe: "H1",
  symbols: US_INDICES,
  create: () => {
    const atr = new AtrWilder(RSI2_REVERSION.atrPeriod);
    const rsi = new RsiWilder(RSI2_REVERSION.rsiPeriod);
    const trend = new Sma(RSI2_REVERSION.trendSmaPeriod);
    let closesHeld = 0;
    return {
      onBarClose(ctx) {
        if (!ctx.justClosed("D1")) return null;
        const d1 = ctx.bars("D1");
        const last = d1.last();
        if (last === undefined) return null;
        const atrValue = atr.update(d1);
        const rsiValue = rsi.update(d1);
        const trendValue = trend.update(d1);
        const price = (value: number): string => value.toFixed(ctx.spec.digits);

        if (ctx.position !== null) {
          closesHeld++;
          return closesHeld >= RSI2_INDEX_CONTROL.holdDays
            ? { kind: "exit", reason: `${closesHeld}-я закрытая D1 с входа` }
            : null;
        }
        closesHeld = 0;

        if (Number.isNaN(atrValue) || Number.isNaN(rsiValue) || Number.isNaN(trendValue)) return null;
        if (rsiValue < RSI2_INDEX_CONTROL.neutralRsiLow || rsiValue > RSI2_INDEX_CONTROL.neutralRsiHigh) return null;
        if (last.close === trendValue) return null;
        const buy = last.close > trendValue;
        return {
          kind: "entry",
          direction: buy ? "BUY" : "SELL",
          stopLoss: { distance: RSI2_REVERSION.atrMultiple * atrValue },
          takeProfit: null,
          reason:
            `D1 close ${price(last.close)} ${buy ? ">" : "<"} SMA(${RSI2_REVERSION.trendSmaPeriod}) ${price(trendValue)}; ` +
            `RSI(${RSI2_REVERSION.rsiPeriod}) ${rsiValue.toFixed(2)} (нейтральный); ATR(${RSI2_REVERSION.atrPeriod}) ${price(atrValue)}`,
        };
      },
    };
  },
};
