import { DateTime } from "luxon";
import type { Bar } from "../data/types";
import type { Direction, MarketContext, Signal, StrategyAction, Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { inSession } from "./breakout-retest-v1";

/** Fixed by TZ 17.10 (approved 2026-11-19). Not configurable on purpose. */
export const GOLD_FLAT = {
  atrPeriod: 14,
  /** Rule 1: close beyond the close this many candles back by `impulseAtr`. */
  impulseBars: 6,
  impulseAtr: 2,
  /** Rule 2: flat of bodies, at least this many candles, at most this many, width at most `flatAtr`. */
  minFlatBars: 8,
  maxFlatBars: 48,
  flatAtr: 1.5,
  /** Rule 3: close beyond the edge by this many ATR. Rule 5: stop buffer. */
  breakoutAtr: 0.1,
  stopBufferAtr: 0.1,
  /** Rule 7: the order lives this many hours at most. */
  orderHours: 4,
  /** Rule 8: share closed at 1:1, then breakeven. */
  partialFraction: 0.5,
} as const;

const HOUR = 3_600_000;

interface Flat {
  /** Index of the first candle of the flat (after the impulse). */
  readonly start: number;
  /** ATR(14) on the impulse candle: the width limit of the flat. */
  readonly atr: number;
  /** Highest and lowest body edge so far; frozen at the first breakout. */
  top: number;
  bottom: number;
  count: number;
  frozen: boolean;
  /** Rule 9: one attempt each way. */
  up: boolean;
  down: boolean;
}

/** End of the London-or-New-York window that contains `utcMs`: 17:00 in New York that day. */
function sessionEnd(utcMs: number): number {
  return DateTime.fromMillis(utcMs, { zone: "America/New_York" }).set({ hour: 17, minute: 0, second: 0, millisecond: 0 }).toMillis();
}

function createInstance() {
  const atr = new AtrWilder(GOLD_FLAT.atrPeriod);
  let flat: Flat | null = null;

  const time = (ctx: MarketContext, utcMs: number): string =>
    DateTime.fromMillis(utcMs, { zone: ctx.zone }).toFormat("yyyy-LL-dd HH:mm");

  /** Rules 4–8: the limit order for a breakout of the frozen flat. */
  const order = (ctx: MarketContext, current: Flat, direction: Direction, bar: Bar, atrValue: number): Signal => {
    const buy = direction === "BUY";
    const buffer = GOLD_FLAT.stopBufferAtr * atrValue;
    const edge = buy ? current.top : current.bottom;
    const stop = buy ? current.bottom - buffer : current.top + buffer;
    const distance = Math.abs(edge - stop);
    const sign = buy ? 1 : -1;
    const tp1 = edge + sign * distance;
    const tp2 = edge + sign * 2 * distance;
    const digits = ctx.spec.digits;
    const price = (value: number): string => value.toFixed(digits);
    return {
      kind: "entry",
      direction,
      stopLoss: { price: stop },
      takeProfit: { price: tp2 },
      limit: {
        price: edge,
        cancelAt: tp1,
        expiresAt: Math.min(ctx.now + GOLD_FLAT.orderHours * HOUR, sessionEnd(ctx.now)),
      },
      partial: { price: tp1, fraction: GOLD_FLAT.partialFraction, breakeven: true },
      reason:
        `L ${price(edge)} (${buy ? "верх" : "низ"} флэта по телам; ${buy ? "низ" : "верх"} ${price(buy ? current.bottom : current.top)}, ` +
        `флэт с ${time(ctx, (ctx.bars("M15").at(current.start) as Bar).time)}, ${current.count} св.); ` +
        `пробой ${time(ctx, bar.time)} close ${price(bar.close)}; ATR(14) ${price(atrValue)}; ` +
        `стоп ${price(stop)}, TP1 ${price(tp1)}, TP2 ${price(tp2)}`,
    };
  };

  /** A close beyond the frozen flat that has an attempt left that way, or null. */
  const breakout = (current: Flat, bar: Bar, atrValue: number): Direction | null => {
    const reach = GOLD_FLAT.breakoutAtr * atrValue;
    if (!current.up && bar.close > current.top + reach) return "BUY";
    if (!current.down && bar.close < current.bottom - reach) return "SELL";
    return null;
  };

  const attempt = (ctx: MarketContext, current: Flat, direction: Direction, bar: Bar, atrValue: number): StrategyAction | null => {
    current.frozen = true;
    if (direction === "BUY") current.up = true;
    else current.down = true;
    // Rule 10: no order outside London or New York hours; the flat is gone then.
    if (!inSession(ctx.now)) {
      flat = null;
      return null;
    }
    return order(ctx, current, direction, bar, atrValue);
  };

  return {
    onBarClose(ctx: MarketContext): StrategyAction | null {
      const bars = ctx.bars("M15");
      const n = bars.length - 1;
      const bar = bars.at(n);
      if (bar === undefined) return null;
      const atrValue = atr.update(bars);
      if (Number.isNaN(atrValue)) return null;

      if (flat !== null && n - flat.start + 1 > GOLD_FLAT.maxFlatBars) flat = null;

      // Rule 11: with a position open nothing new is searched.
      if (ctx.position !== null) return null;

      // Rule 7: a close through the other edge withdraws the order and, with
      // an attempt left that way, places the opposite one (rule 9).
      if (ctx.order !== null) {
        if (flat === null) return null;
        const through = breakout(flat, bar, atrValue);
        if (through === null || through === ctx.order.direction) return null;
        return attempt(ctx, flat, through, bar, atrValue) ?? { kind: "cancel", reason: "флэт пробит в другую сторону" };
      }

      if (flat !== null && (flat.frozen || flat.count >= GOLD_FLAT.minFlatBars)) {
        const through = breakout(flat, bar, atrValue);
        if (through !== null) return attempt(ctx, flat, through, bar, atrValue);
      }

      // Rule 2: a forming flat takes the candle's body or dies.
      if (flat !== null && !flat.frozen) {
        const top = Math.max(flat.top, bar.open, bar.close);
        const bottom = Math.min(flat.bottom, bar.open, bar.close);
        if (top - bottom > GOLD_FLAT.flatAtr * flat.atr) {
          flat = null;
        } else {
          flat.top = top;
          flat.bottom = bottom;
          flat.count++;
        }
      }

      // Rule 1: an impulse candle starts a new flat from the next candle.
      const back = bars.at(n - GOLD_FLAT.impulseBars);
      if (back !== undefined && Math.abs(bar.close - back.close) >= GOLD_FLAT.impulseAtr * atrValue) {
        flat = { start: n + 1, atr: atrValue, top: -Infinity, bottom: Infinity, count: 0, frozen: false, up: false, down: false };
      }
      return null;
    },
  };
}

/**
 * GoldFlatLimitM15 (TZ 17.10), after the "To'g'ri Trading Start" lessons:
 * after an impulse, a flat of candle bodies on XAUUSD M15; a close beyond it
 * places a limit order on the broken edge, stop behind the other edge, half
 * closed at 1:1 with the rest at breakeven, the rest taken at 1:2.
 */
export const goldFlatLimitM15: Strategy = {
  name: "GoldFlatLimitM15",
  params: {
    ...GOLD_FLAT,
    atrMethod: "Wilder",
    flatEdges: "candle bodies",
    sessions: "08:00-17:00 Europe/London or America/New_York, inclusive",
    executionTimeframe: "M15",
  },
  executionTimeframe: "M15",
  symbols: ["XAUUSD"],
  create: () => createInstance(),
};
