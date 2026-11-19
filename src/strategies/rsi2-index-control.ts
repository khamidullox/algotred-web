import type { Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { RsiWilder } from "../indicators/rsi";
import { Sma } from "../indicators/sma";
import { US_INDICES } from "./baskets";
import { RSI2_INDEX_H1, RSI2_REVERSION, serverInstant, type Rsi2Variant } from "./rsi2-reversion-d1";

/** Fixed by TZ 17.12 (approved 2026-11-19). Not configurable on purpose. */
export const RSI2_INDEX_CONTROL = {
  /** RSI(2) inside [low, high] is neither oversold nor overbought. */
  neutralRsiLow: 45,
  neutralRsiHigh: 55,
  /** Exit at the next open after this many closed candles, the entry candle counted. */
  holdDays: 4,
} as const;

/**
 * Rsi2IndexControl (TZ 17.12): the control for Rsi2ReversionIndexD1. Same
 * instruments, SMA(200) trend side, stop and costs, but it enters on a
 * neutral RSI(2) (45 to 55) and holds four D1 closes. It shows what a few
 * days in the trend's direction earned in 2015–2021 without any dip, so the
 * RSI(2) effect can be told apart from the rally. Informational: never a
 * candidate for test.
 *
 * With `signalTimeframe` H1 it is Rsi2IndexH1Control (TZ 17.13): the same
 * control on hourly candles, holding four H1 closes.
 */
function createRsi2Control(name: string, variant: Rsi2Variant): Strategy {
  const tf = variant.signalTimeframe;
  const { holdDays, ...neutral } = RSI2_INDEX_CONTROL;
  return {
    name,
    params: {
      rsiPeriod: RSI2_REVERSION.rsiPeriod,
      trendSmaPeriod: RSI2_REVERSION.trendSmaPeriod,
      atrPeriod: RSI2_REVERSION.atrPeriod,
      atrMultiple: RSI2_REVERSION.atrMultiple,
      ...neutral,
      ...(tf === "D1" ? { holdDays } : { holdBars: holdDays }),
      signalTimeframe: tf,
      executionTimeframe: "H1",
      ...(variant.tradeFrom === undefined ? {} : { tradeFrom: `${variant.tradeFrom} server time` }),
    },
    executionTimeframe: "H1",
    symbols: US_INDICES,
    create: () => {
      const atr = new AtrWilder(RSI2_REVERSION.atrPeriod);
      const rsi = new RsiWilder(RSI2_REVERSION.rsiPeriod);
      const trend = new Sma(RSI2_REVERSION.trendSmaPeriod);
      let closesHeld = 0;
      let tradeFrom: number | null = null;
      return {
        onBarClose(ctx) {
          if (!ctx.justClosed(tf)) return null;
          const bars = ctx.bars(tf);
          const last = bars.last();
          if (last === undefined) return null;
          const atrValue = atr.update(bars);
          const rsiValue = rsi.update(bars);
          const trendValue = trend.update(bars);
          const price = (value: number): string => value.toFixed(ctx.spec.digits);

          if (ctx.position !== null) {
            closesHeld++;
            return closesHeld >= RSI2_INDEX_CONTROL.holdDays
              ? { kind: "exit", reason: `${closesHeld}-я закрытая ${tf} с входа` }
              : null;
          }
          closesHeld = 0;

          tradeFrom ??= serverInstant(variant.tradeFrom, ctx.zone);
          if (ctx.now < tradeFrom) return null;
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
              `${tf} close ${price(last.close)} ${buy ? ">" : "<"} SMA(${RSI2_REVERSION.trendSmaPeriod}) ${price(trendValue)}; ` +
              `RSI(${RSI2_REVERSION.rsiPeriod}) ${rsiValue.toFixed(2)} (нейтральный); ATR(${RSI2_REVERSION.atrPeriod}) ${price(atrValue)}`,
          };
        },
      };
    },
  };
}

export const rsi2IndexControl = createRsi2Control("Rsi2IndexControl", { signalTimeframe: "D1" });

/** Rsi2IndexH1Control (TZ 17.13): the control for Rsi2ReversionIndexH1. */
export const rsi2IndexH1Control = createRsi2Control("Rsi2IndexH1Control", RSI2_INDEX_H1);
