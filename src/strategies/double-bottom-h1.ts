import { DateTime } from "luxon";
import { symbolCurrencies } from "../data/calendar";
import type { Bar } from "../data/types";
import { roundPrice } from "../engine/symbols";
import type { ClosedBars, MarketContext, Signal, Strategy, StrategyAction } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { FX_AND_GOLD } from "./baskets";
import { inSession } from "./breakout-retest-v1";
import { swingAt } from "./three-touch-trend-d1";

/** Fixed by TZ 17.15 (approved 2026-11-20). Not configurable on purpose. */
export const DOUBLE_BOTTOM = {
  /** Rule 1: a swing point stands out of this many H1 bars on both sides. */
  wingsH1: 5,
  atrPeriod: 14,
  /** Rule 2: the two bottoms differ by at most this many ATR. */
  levelToleranceAtr: 0.5,
  /** Rule 3: the figure is at least this many ATR high. */
  minHeightAtr: 2,
  /** Rule 4: the close this many bars before the first bottom is `impulseAtr` away from it. */
  impulseBars: 6,
  impulseAtr: 2,
  /** Rule 5: the order stands this many ATR beyond the middle point. Rule 7: stop buffer. */
  entryBufferAtr: 0.1,
  stopBufferAtr: 0.1,
  /** Rule 8: half closed at 1:1 with the rest at breakeven, the rest taken at 1:2. */
  partialAtR: 1,
  partialFraction: 0.5,
  takeProfitR: 2,
  /** Rule 10: the order lives this many H1 bars after the bar that placed it. */
  orderLifeH1: 24,
  /** Rule 11: the order does not work this close to an important release. */
  newsMinutes: 30,
} as const;

const M15 = 15 * 60_000;
const NEWS = DOUBLE_BOTTOM.newsMinutes * 60_000;

type Kind = "low" | "high";

interface Swing {
  readonly index: number;
  readonly price: number;
}

/** The middle point of a figure: the highest high (lowest low) strictly between its two swing points. */
export function middlePoint(bars: ClosedBars, first: number, second: number, kind: Kind): Swing {
  let index = -1;
  let price = kind === "low" ? -Infinity : Infinity;
  for (let i = first + 1; i < second; i++) {
    const bar = bars.at(i) as Bar;
    const value = kind === "low" ? bar.high : bar.low;
    if (kind === "low" ? value > price : value < price) {
      price = value;
      index = i;
    }
  }
  return { index, price };
}

/**
 * Rule 11: whether a stop order works in the M15 bar that opens at `barOpen`.
 * The bar has to lie whole inside the London or New York hours and must not
 * overlap the 30 minutes before or after an important release of the
 * instrument's currencies.
 */
export function orderWorksAt(ctx: Pick<MarketContext, "news">, currencies: readonly string[], barOpen: number): boolean {
  const barClose = barOpen + M15;
  if (!inSession(barOpen) || !inSession(barClose)) return false;
  // A release at t closes the bar when t - 30 min < close and t + 30 min > open.
  return ctx.news(barOpen - NEWS + 1, barClose + NEWS, { currencies, minImportance: "HIGH" }).length === 0;
}

function createInstance() {
  const atr = new AtrWilder(DOUBLE_BOTTOM.atrPeriod);
  const last: Record<Kind, Swing | null> = { low: null, high: null };
  let started = false;
  /** Index of the H1 bar whose close placed the resting order. */
  let placedIndex: number | null = null;

  const time = (ctx: MarketContext, utcMs: number): string =>
    DateTime.fromMillis(utcMs, { zone: ctx.zone }).toFormat("yyyy-LL-dd HH:mm");

  /** Rules 2 to 8 for two swing points of one kind in a row; null when they make no figure. */
  const figure = (ctx: MarketContext, h1: ClosedBars, n: number, kind: Kind, first: Swing, second: Swing, atrValue: number): Signal | null => {
    const buy = kind === "low";
    const sign = buy ? 1 : -1;
    // Rule 2: the two bottoms stand on one level.
    if (Math.abs(second.price - first.price) > DOUBLE_BOTTOM.levelToleranceAtr * atrValue) return null;
    // Rule 3: the middle point and the height of the figure.
    const middle = middlePoint(h1, first.index, second.index, kind);
    const far = buy ? Math.min(first.price, second.price) : Math.max(first.price, second.price);
    if (sign * (middle.price - far) < DOUBLE_BOTTOM.minHeightAtr * atrValue) return null;
    // Rule 4: the price came to the first bottom fast.
    const before = h1.at(first.index - DOUBLE_BOTTOM.impulseBars);
    if (first.index - DOUBLE_BOTTOM.impulseBars < 0 || before === undefined) return null;
    if (sign * (before.close - first.price) < DOUBLE_BOTTOM.impulseAtr * atrValue) return null;

    const entry = roundPrice(ctx.spec, middle.price + sign * DOUBLE_BOTTOM.entryBufferAtr * atrValue);
    const stop = roundPrice(ctx.spec, far - sign * DOUBLE_BOTTOM.stopBufferAtr * atrValue);
    // Rule 5: a figure whose order price was already reached after the second bottom is spent.
    for (let i = second.index + 1; i <= n; i++) {
      const bar = h1.at(i) as Bar;
      if (buy ? bar.high >= entry : bar.low <= entry) return null;
    }

    const currencies = symbolCurrencies(ctx.symbol);
    const price = (value: number): string => value.toFixed(ctx.spec.digits);
    const at = (index: number): string => time(ctx, (h1.at(index) as Bar).time);
    const name = buy ? "дно" : "вершина";
    return {
      kind: "entry",
      direction: buy ? "BUY" : "SELL",
      stopLoss: { price: stop },
      takeProfit: { rMultiple: DOUBLE_BOTTOM.takeProfitR },
      stopEntry: {
        price: entry,
        // Rule 10: the figure is broken once the price reaches the stop.
        cancelAt: stop,
        worksAt: (barOpen) => orderWorksAt(ctx, currencies, barOpen),
      },
      partial: { rMultiple: DOUBLE_BOTTOM.partialAtR, fraction: DOUBLE_BOTTOM.partialFraction, breakeven: true },
      reason:
        `L ${price(entry)} (${buy ? "high" : "low"} ${at(middle.index)}); ` +
        `середина ${price(middle.price)}; ` +
        `${name} ${at(first.index)} ${price(first.price)}; ${name} ${at(second.index)} ${price(second.price)}; ` +
        `ордер ${time(ctx, ctx.now)}; ATR(14) ${price(atrValue)}; стоп ${price(stop)}`,
    };
  };

  return {
    onBarClose(ctx: MarketContext): StrategyAction | null {
      if (!ctx.justClosed("H1")) return null;
      const h1 = ctx.bars("H1");
      const n = h1.length - 1;
      if (h1.at(n) === undefined) return null;
      const atrValue = atr.update(h1);
      const wings = DOUBLE_BOTTOM.wingsH1;

      if (!started) {
        started = true;
        // Rule 11 cannot be kept without the calendar: refuse to run blind.
        if (ctx.news(0, Number.MAX_SAFE_INTEGER, { currencies: symbolCurrencies(ctx.symbol), minImportance: "HIGH" }).length === 0) {
          throw new Error(`DoubleBottomH1: в календаре нет важных новостей для ${ctx.symbol}. Правило новостей (ТЗ 17.15, п. 11) без календаря не работает.`);
        }
        // The last swing point of each kind confirmed before the run starts.
        for (const kind of ["low", "high"] as const) {
          for (let m = n - 1; m >= 2 * wings && last[kind] === null; m--) {
            last[kind] = swingAt(h1, m, kind, wings);
          }
        }
      }

      // Rule 1: swing points are tracked always; two in a row may make a figure.
      const figures: { kind: Kind; first: Swing; second: Swing }[] = [];
      for (const kind of ["low", "high"] as const) {
        const swing = swingAt(h1, n, kind, wings);
        if (swing === null) continue;
        const previous = last[kind];
        last[kind] = swing;
        if (previous !== null) figures.push({ kind, first: previous, second: swing });
      }

      // Rule 10: the order is withdrawn after 24 closed H1 bars.
      if (ctx.order !== null && placedIndex !== null && n - placedIndex >= DOUBLE_BOTTOM.orderLifeH1) {
        placedIndex = null;
        return { kind: "cancel", reason: `не исполнен за ${DOUBLE_BOTTOM.orderLifeH1} свечи H1` };
      }

      // Rule 12: a figure confirmed with a position open or an order waiting is skipped.
      if (ctx.position !== null || ctx.order !== null) return null;
      if (Number.isNaN(atrValue)) return null;
      // A bottom and a top confirmed on one bar: the buy is checked first.
      for (const { kind, first, second } of figures) {
        const signal = figure(ctx, h1, n, kind, first, second, atrValue);
        if (signal !== null) {
          placedIndex = n;
          return signal;
        }
      }
      return null;
    },
  };
}

/**
 * DoubleBottomH1 (TZ 17.15), after the lessons of the customer's two Telegram
 * authors: two H1 swing lows in a row on one level after a fast fall, a buy
 * stop just above the high between them, the stop under the lower bottom,
 * half closed at 1:1 with the rest at breakeven and taken at 1:2. The order
 * works only in London and New York hours and away from important news.
 * Double tops mirror it.
 */
export const doubleBottomH1: Strategy = {
  name: "DoubleBottomH1",
  params: {
    ...DOUBLE_BOTTOM,
    atrMethod: "Wilder",
    entry: "stop order on the middle point",
    sessions: "08:00-17:00 Europe/London or America/New_York, whole M15 bar inside",
    news: "HIGH, exact time, currencies of the instrument",
    signalTimeframe: "H1",
    executionTimeframe: "M15",
  },
  executionTimeframe: "M15",
  symbols: FX_AND_GOLD,
  create: () => createInstance(),
};
