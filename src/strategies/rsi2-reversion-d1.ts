import { DateTime } from "luxon";
import type { Strategy, StrategyAction, StrategyInstance } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { RsiWilder } from "../indicators/rsi";
import { Sma } from "../indicators/sma";
import { FX_AND_GOLD, US_INDICES } from "./baskets";

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

/** What differs between the daily system and its hourly transfer (TZ 17.13). */
export interface Rsi2Variant {
  /** The candle every indicator and rule reads. */
  readonly signalTimeframe: "D1" | "H1";
  /** Entries only from bars that close at or after this server-time instant (ISO, no zone). */
  readonly tradeFrom?: string;
  /** Orders placed by hand at a wall-clock hour instead of at the daily close (TZ 17.49). Daily variant only. */
  readonly orderClock?: OrderClock;
}

/** A whole hour of the day on the clock of a place: 9 in Asia/Tashkent is 09:00 there, summer and winter. */
export interface OrderClock {
  readonly hour: number;
  readonly zone: string;
}

/**
 * A daily strategy traded by a person who looks once a day (TZ 17.48, 17.49).
 * The rule still decides at the close of a daily bar, but its order, an entry
 * or an exit, is held back: it goes out at the first hourly close at or after
 * `clock` on the day it would have been filled in, and the engine fills it at
 * the next hourly open. That day is the server day of the first hourly bar
 * that opens after the daily close. An order still held at the next daily
 * close was never placed: it is dropped and that close decides anew. The stop
 * distance comes with the signal, so the stop stands that far from the late
 * fill; a stop already resting at the broker is not delayed.
 */
export function placedAtClock(rule: StrategyInstance, clock: OrderClock): StrategyInstance {
  // `after` is the daily close that gave the order, `release` the moment it may go out.
  let held: { action: Exclude<StrategyAction, { kind: "cancel" }>; after: number; release: number | null } | null = null;
  return {
    onBarClose(ctx) {
      // The rule looks only at daily closes and returns null on every other bar.
      const fresh = rule.onBarClose(ctx);
      if (ctx.justClosed("D1")) {
        held = fresh === null || fresh.kind === "cancel" ? null : { action: fresh, after: ctx.now, release: null };
        return null;
      }
      if (held === null) return null;
      // The bar that has just closed: once one has opened after the signal, its server day is the order's day.
      const opened = ctx.bars("H1").last()?.time;
      if (opened === undefined) return null;
      if (held.release === null && opened >= held.after) {
        const { year, month, day } = DateTime.fromMillis(opened, { zone: ctx.zone });
        held.release = DateTime.fromObject({ year, month, day, hour: clock.hour }, { zone: clock.zone }).toMillis();
      }
      if (held.release === null || ctx.now < held.release) return null;
      const { action } = held;
      held = null;
      return action;
    },
  };
}

/** UTC ms of a server-time instant; minus infinity when there is none. */
export function serverInstant(iso: string | undefined, zone: string): number {
  return iso === undefined ? Number.NEGATIVE_INFINITY : DateTime.fromISO(iso, { zone }).toMillis();
}

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
 *
 * With `signalTimeframe` H1 (TZ 17.13) every rule reads hourly candles
 * instead, and entries are taken only from `tradeFrom` on.
 */
function createRsi2Strategy(
  name: string,
  symbols: readonly string[],
  variant: Rsi2Variant = { signalTimeframe: "D1" },
): Strategy {
  const tf = variant.signalTimeframe;
  const clock = variant.orderClock;
  if (clock !== undefined && tf !== "D1") throw new Error(`${name}: orderClock is for the daily variant only`);
  return {
    name,
    params: {
      ...RSI2_REVERSION,
      rsiMethod: "Wilder (as MT5 Relative Strength Index)",
      atrMethod: "Wilder",
      signalTimeframe: tf,
      executionTimeframe: "H1",
      ...(variant.tradeFrom === undefined ? {} : { tradeFrom: `${variant.tradeFrom} server time` }),
      ...(clock === undefined ? {} : { ordersPlacedAt: `${String(clock.hour).padStart(2, "0")}:00 ${clock.zone}` }),
    },
    executionTimeframe: "H1",
    symbols,
    create: () => {
      const atr = new AtrWilder(RSI2_REVERSION.atrPeriod);
      const rsi = new RsiWilder(RSI2_REVERSION.rsiPeriod);
      const trend = new Sma(RSI2_REVERSION.trendSmaPeriod);
      const exit = new Sma(RSI2_REVERSION.exitSmaPeriod);
      let tradeFrom: number | null = null;
      const rule: StrategyInstance = {
        onBarClose(ctx) {
          if (!ctx.justClosed(tf)) return null;
          const bars = ctx.bars(tf);
          const last = bars.last();
          if (last === undefined) return null;
          const atrValue = atr.update(bars);
          const rsiValue = rsi.update(bars);
          const trendValue = trend.update(bars);
          const exitValue = exit.update(bars);
          const price = (value: number): string => value.toFixed(ctx.spec.digits);

          // Rule 4: the exit, checked from the close of the entry day on.
          const position = ctx.position;
          if (position !== null) {
            if (Number.isNaN(exitValue)) return null;
            if (position.direction === "BUY" ? last.close > exitValue : last.close < exitValue) {
              const side = position.direction === "BUY" ? ">" : "<";
              return {
                kind: "exit",
                reason: `${tf} close ${price(last.close)} ${side} SMA(${RSI2_REVERSION.exitSmaPeriod}) ${price(exitValue)}`,
              };
            }
            return null;
          }

          // Rules 1-3 and 5 with no position open (rule 6).
          tradeFrom ??= serverInstant(variant.tradeFrom, ctx.zone);
          if (ctx.now < tradeFrom) return null;
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
              `${tf} close ${price(last.close)} ${buy ? ">" : "<"} SMA(${RSI2_REVERSION.trendSmaPeriod}) ${price(trendValue)}; ` +
              `RSI(${RSI2_REVERSION.rsiPeriod}) ${rsiValue.toFixed(2)}; ATR(${RSI2_REVERSION.atrPeriod}) ${price(atrValue)}`,
          };
        },
      };
      return clock === undefined ? rule : placedAtClock(rule, clock);
    },
  };
}

export const rsi2ReversionD1 = createRsi2Strategy("Rsi2ReversionD1", FX_AND_GOLD);

/**
 * Rsi2ReversionIndexD1 (TZ 17.12): the same frozen rules on the US index
 * CFDs, the market the system was written for.
 */
export const rsi2ReversionIndexD1 = createRsi2Strategy("Rsi2ReversionIndexD1", US_INDICES);

/**
 * The hour the customer named on 2026-11-27 for placing orders by hand: by
 * 09:00 in Tashkent, which is 06:00 on the server in winter and 07:00 in
 * summer. Entries only from 2016-09-01: a delay within the day needs real
 * hourly bars (see RSI2_INDEX_H1 below).
 */
export const RSI2_INDEX_AT_9_TASHKENT: Rsi2Variant = {
  signalTimeframe: "D1",
  tradeFrom: "2016-09-01T00:00",
  orderClock: { hour: 9, zone: "Asia/Tashkent" },
};

/**
 * Rsi2ReversionIndexD1At9Tashkent (TZ 17.49): the confirmed rules of
 * Rsi2ReversionIndexD1 with nothing changed but the moment the orders are
 * placed, 09:00 Tashkent time instead of the daily open at 01:00 server time.
 */
export const rsi2ReversionIndexD1At9Tashkent = createRsi2Strategy("Rsi2ReversionIndexD1At9Tashkent", US_INDICES, RSI2_INDEX_AT_9_TASHKENT);

/**
 * Real hourly bars of the index CFDs start on 2016-01-25 (US500), 2016-01-27
 * (US30) and 2016-07-20 (US2000); before that the H1 files hold one bar a day.
 * By this date each index has over 700 real hourly bars to warm the indicators.
 */
export const RSI2_INDEX_H1: Rsi2Variant = { signalTimeframe: "H1", tradeFrom: "2016-09-01T00:00" };

/**
 * Rsi2ReversionIndexH1 (TZ 17.13): the same frozen rules read on hourly
 * candles of the US index CFDs, all sessions, with no forced close at the
 * end of the day.
 */
export const rsi2ReversionIndexH1 = createRsi2Strategy("Rsi2ReversionIndexH1", US_INDICES, RSI2_INDEX_H1);
