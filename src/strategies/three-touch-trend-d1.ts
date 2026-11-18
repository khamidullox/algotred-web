import { DateTime } from "luxon";
import type { Bar } from "../data/types";
import type { ClosedBars, MarketContext, Signal, Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { FX_GOLD_AND_INDICES } from "./baskets";

/** Fixed by TZ 17.7 (approved 2026-11-18). Not configurable on purpose. */
export const THREE_TOUCH = {
  /** A swing point stands out of this many D1 bars on both sides (as StrongLevelD1). */
  wingsD1: 10,
  /** A line lives this many D1 bars after its second point (as StrongLevelD1). */
  lifeD1: 120,
  atrPeriod: 14,
  touchBufferAtr: 0.1,
  stopBufferAtr: 0.1,
} as const;

type Kind = "low" | "high";

interface Swing {
  readonly index: number;
  readonly price: number;
}

/** A trend line through two swing points: rising through lows, falling through highs. */
interface Line {
  readonly kind: Kind;
  readonly first: Swing;
  readonly second: Swing;
  /** Index of the D1 bar at whose close the second point became known. */
  readonly knownIndex: number;
}

/** Value of the line at a D1 bar index, extended by bar count. */
export function lineAt(line: Pick<Line, "first" | "second">, index: number): number {
  const slope = (line.second.price - line.first.price) / (line.second.index - line.first.index);
  return line.first.price + slope * (index - line.first.index);
}

/**
 * Rule 1: the bar `wings` bars back is a swing low (high) when its low (high)
 * is strictly below (above) those of `wings` bars on each side.
 */
export function swingAt(bars: ClosedBars, n: number, kind: Kind, wings: number): Swing | null {
  const c = n - wings;
  if (c - wings < 0) return null;
  const value = (bar: Bar): number => (kind === "low" ? bar.low : bar.high);
  const centre = value(bars.at(c) as Bar);
  for (let i = c - wings; i <= c + wings; i++) {
    if (i === c) continue;
    const other = value(bars.at(i) as Bar);
    if (kind === "low" ? other <= centre : other >= centre) return null;
  }
  return { index: c, price: centre };
}

function createInstance(zoneOf: () => string) {
  const atr = new AtrWilder(THREE_TOUCH.atrPeriod);
  const swings: Record<Kind, Swing[]> = { low: [], high: [] };
  const lines: Record<Kind, Line | null> = { low: null, high: null };

  const day = (utcMs: number): string => DateTime.fromMillis(utcMs, { zone: zoneOf() }).toFormat("yyyy-LL-dd");

  /** Rule 2: a new swing point may start a line with the previous one of its kind. */
  const onSwing = (kind: Kind, swing: Swing, n: number): void => {
    const list = swings[kind];
    const previous = list.at(-1);
    list.push(swing);
    if (previous === undefined) return;
    const rising = kind === "low" ? swing.price > previous.price : swing.price < previous.price;
    if (!rising) return;
    const other = kind === "low" ? swings.high : swings.low;
    const between = other.some((point) => point.index > previous.index && point.index < swing.index);
    if (!between) return;
    lines[kind] = { kind, first: previous, second: swing, knownIndex: n };
  };

  const signalOf = (line: Line, touch: Bar, n: number, d1: ClosedBars, atrValue: number, ctx: MarketContext): Signal => {
    const buy = line.kind === "low";
    const buffer = THREE_TOUCH.stopBufferAtr * atrValue;
    // Rule 6: the "second maximum" — the extreme between the second point and the touch.
    let target = buy ? -Infinity : Infinity;
    for (let i = line.second.index + 1; i < n; i++) {
      const bar = d1.at(i) as Bar;
      target = buy ? Math.max(target, bar.high) : Math.min(target, bar.low);
    }
    const price = (value: number): string => value.toFixed(ctx.spec.digits);
    return {
      kind: "entry",
      direction: buy ? "BUY" : "SELL",
      stopLoss: { price: buy ? line.second.price - buffer : line.second.price + buffer },
      takeProfit: { price: target },
      reason:
        `линия ${buy ? "по минимумам" : "по максимумам"} ${day((d1.at(line.first.index) as Bar).time)} ${price(line.first.price)} — ` +
        `${day((d1.at(line.second.index) as Bar).time)} ${price(line.second.price)}; ` +
        `касание ${day(touch.time)} при линии ${price(lineAt(line, n))}; ` +
        `тейк ${price(target)}; ATR(14) ${price(atrValue)}`,
    };
  };

  return {
    onBarClose(ctx: MarketContext): Signal | null {
      if (!ctx.justClosed("D1")) return null;
      const d1 = ctx.bars("D1");
      const n = d1.length - 1;
      const bar = d1.at(n);
      if (bar === undefined) return null;
      const atrValue = atr.update(d1);

      // Swing points are tracked always; they only become known 10 bars later.
      for (const kind of ["low", "high"] as const) {
        const swing = swingAt(d1, n, kind, THREE_TOUCH.wingsD1);
        if (swing !== null) onSwing(kind, swing, n);
      }

      let signal: Signal | null = null;
      for (const kind of ["low", "high"] as const) {
        const line = lines[kind];
        if (line === null || n <= line.knownIndex) continue;
        if (n > line.second.index + THREE_TOUCH.lifeD1) {
          lines[kind] = null;
          continue;
        }
        const value = lineAt(line, n);
        const buy = kind === "low";
        // A close through the line removes it.
        if (buy ? bar.close < value : bar.close > value) {
          lines[kind] = null;
          continue;
        }
        if (Number.isNaN(atrValue)) continue;
        const reach = THREE_TOUCH.touchBufferAtr * atrValue;
        const touched = buy ? bar.low <= value + reach && bar.close > value : bar.high >= value - reach && bar.close < value;
        if (!touched) continue;
        // Rule 3: one line, one attempt — whether or not a position can open.
        lines[kind] = null;
        if (ctx.position === null && signal === null) {
          signal = signalOf(line, bar, n, d1, atrValue, ctx);
        }
      }
      return signal;
    },
  };
}

/**
 * ThreeTouchTrendD1 (TZ 17.7), after Feruzbek Aliev's "3 touches": a rising
 * trend line through the last two D1 swing lows (a swing high between them);
 * a D1 bar that touches it within 0.1 x ATR and closes above it is the third
 * touch; buy at the next open, stop 0.1 x ATR under the second low, take at
 * the highest high since that low. Falling lines through highs mirror it.
 */
export const threeTouchTrendD1: Strategy = {
  name: "ThreeTouchTrendD1",
  params: {
    ...THREE_TOUCH,
    atrMethod: "Wilder",
    signalTimeframe: "D1",
    executionTimeframe: "H1",
  },
  executionTimeframe: "H1",
  symbols: FX_GOLD_AND_INDICES,
  create: () => {
    let zone = "utc";
    const instance = createInstance(() => zone);
    return {
      onBarClose(ctx) {
        zone = ctx.zone;
        return instance.onBarClose(ctx);
      },
    };
  },
};
