import { DateTime } from "luxon";
import type { Bar } from "../data/types";
import type { ClosedBars, MarketContext, Signal, Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { FX_AND_GOLD } from "./baskets";
import { inSession } from "./breakout-retest-v1";

/** Fixed by TZ 17.3 (approved 2026-11-18). Not configurable on purpose. */
export const FAILED_BREAKOUT = {
  levelLookback: 20,
  /** The bar that set the level stands at least this many bars before the breakout bar. */
  levelMinAgeBars: 4,
  atrPeriod: 14,
  breakoutBufferAtr: 0.1,
  failureBars: 6,
  stopBufferAtr: 0.1,
  maxStopAtr: 1.5,
  minStopAtr: 0.5,
  takeProfitR: 2,
} as const;

/** The side the breakout went to; the trade goes the other way. */
type Side = "up" | "down";

export interface Level {
  readonly price: number;
  /** Index of the latest bar that set the extreme. */
  readonly index: number;
}

/**
 * Rule 1: the highest high ("up") or lowest low ("down") of the 20 bars before
 * the bar at `end`, and the latest bar that set it. Null while the history is
 * too short.
 */
export function levelBefore(bars: ClosedBars, end: number, side: Side): Level | null {
  const start = end - FAILED_BREAKOUT.levelLookback;
  if (start < 0) return null;
  let price = side === "up" ? -Infinity : Infinity;
  let index = -1;
  for (let i = start; i < end; i++) {
    const bar = bars.at(i) as Bar;
    const value = side === "up" ? bar.high : bar.low;
    // Ties move the index forward: a repeated extreme counts at its latest bar.
    if (side === "up" ? value >= price : value <= price) {
      price = value;
      index = i;
    }
  }
  return { price, index };
}

interface Setup {
  readonly side: Side;
  readonly level: Level;
  readonly levelTime: number;
  /** ATR(14) on the breakout bar; fixed for the life of the setup. */
  readonly atr: number;
  readonly breakoutIndex: number;
  readonly breakoutTime: number;
  readonly breakoutClose: number;
  /** Highest high ("up") or lowest low ("down") from the breakout bar on. */
  extreme: number;
}

function createInstance(zoneOf: () => string) {
  const atr = new AtrWilder(FAILED_BREAKOUT.atrPeriod);
  let setup: Setup | null = null;

  const serverTime = (utcMs: number): string =>
    DateTime.fromMillis(utcMs, { zone: zoneOf() }).toFormat("yyyy-LL-dd HH:mm");

  const signalOf = (current: Setup, failure: Bar, ctx: MarketContext): Signal => {
    const up = current.side === "up";
    const buffer = FAILED_BREAKOUT.stopBufferAtr * current.atr;
    const price = (value: number): string => value.toFixed(ctx.spec.digits);
    return {
      kind: "entry",
      direction: up ? "SELL" : "BUY",
      // Rule 5: beyond the extreme of the breakout, failure bar included.
      stopLoss: { price: up ? current.extreme + buffer : current.extreme - buffer },
      takeProfit: { rMultiple: FAILED_BREAKOUT.takeProfitR },
      maxStopDistance: FAILED_BREAKOUT.maxStopAtr * current.atr,
      minStopDistance: FAILED_BREAKOUT.minStopAtr * current.atr,
      // Rule 4: only the M15 that opens right after the failure bar.
      expectedEntryTime: ctx.now,
      reason:
        `L ${price(current.level.price)} (${up ? "high" : "low"} ${serverTime(current.levelTime)}); ` +
        `ATR(14) ${price(current.atr)}; ` +
        `пробой ${up ? "вверх" : "вниз"} ${serverTime(current.breakoutTime)} close ${price(current.breakoutClose)}; ` +
        `провал ${serverTime(failure.time)} close ${price(failure.close)}; ` +
        `${up ? "max" : "min"} ${price(current.extreme)}`,
    };
  };

  return {
    onBarClose(ctx: MarketContext): Signal | null {
      if (!ctx.justClosed("H1")) return null;
      const h1 = ctx.bars("H1");
      const n = h1.length - 1;
      const bar = h1.at(n);
      if (bar === undefined) return null;
      const atrNow = atr.update(h1);

      // Rule 9: nothing is tracked while a position is open.
      if (ctx.position !== null) {
        setup = null;
        return null;
      }

      // Rule 3: a breakout waiting for its failure. While it waits, no new
      // breakouts are looked for, and the bar that ends it starts nothing.
      if (setup !== null) {
        const current = setup;
        const up = current.side === "up";
        current.extreme = up ? Math.max(current.extreme, bar.high) : Math.min(current.extreme, bar.low);
        if (up ? bar.close < current.level.price : bar.close > current.level.price) {
          setup = null;
          // Rule 8: outside the sessions the setup is spent without a trade.
          return inSession(ctx.now) ? signalOf(current, bar, ctx) : null;
        }
        if (n - current.breakoutIndex >= FAILED_BREAKOUT.failureBars) {
          setup = null;
        }
        return null;
      }

      if (Number.isNaN(atrNow)) return null;

      // Rules 1 and 2 on the bar that has just closed.
      const buffer = FAILED_BREAKOUT.breakoutBufferAtr * atrNow;
      for (const side of ["up", "down"] as const) {
        const level = levelBefore(h1, n, side);
        if (level === null) return null;
        const broke =
          side === "up" ? bar.close > level.price + buffer : bar.close < level.price - buffer;
        if (!broke) continue;
        if (n - level.index < FAILED_BREAKOUT.levelMinAgeBars) return null;
        setup = {
          side,
          level,
          levelTime: (h1.at(level.index) as Bar).time,
          atr: atrNow,
          breakoutIndex: n,
          breakoutTime: bar.time,
          breakoutClose: bar.close,
          extreme: side === "up" ? bar.high : bar.low,
        };
        return null;
      }
      return null;
    },
  };
}

/**
 * FailedBreakoutV1 (TZ 17.3): trade against an H1 breakout that failed. The
 * level is the extreme of the 20 H1 bars before the breakout bar, set at least
 * four bars earlier; the breakout is an H1 close beyond it by 0.1 x ATR(14);
 * the failure is an H1 close back inside within the next six bars. Entry at
 * the next M15 open inside the London or New York session, stop 0.1 x ATR
 * beyond the extreme of the breakout (0.5 to 1.5 x ATR away), take 2R.
 */
export const failedBreakoutV1: Strategy = {
  name: "FailedBreakoutV1",
  params: {
    ...FAILED_BREAKOUT,
    atrMethod: "Wilder",
    sessions: "08:00-17:00 Europe/London or America/New_York, inclusive",
    cancelOnGapAfterFailure: true,
    signalTimeframe: "H1",
    executionTimeframe: "M15",
  },
  executionTimeframe: "M15",
  symbols: FX_AND_GOLD,
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
