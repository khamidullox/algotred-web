import { DateTime } from "luxon";
import type { Bar } from "../data/types";
import type {
  ClosedBars,
  Direction,
  MarketContext,
  Signal,
  Strategy,
} from "../engine/types";
import { AtrWilder } from "../indicators/atr";

/** Fixed by TZ 16.4 (approved 2026-11-17). Not configurable on purpose. */
export const STRONG_LEVEL = {
  wingsD1: 10,
  lifeD1: 120,
  touchAtr: 0.5,
  breakoutBufferAtr: 0.1,
  retestBarsD1: 5,
  stopBufferAtr: 0.1,
  maxStopAtr: 1.5,
  takeProfitR: 2,
  atrPeriod: 14,
} as const;

type Side = "resistance" | "support";

interface Level {
  readonly side: Side;
  readonly price: number;
  /** Index of the D1 bar whose high (or low) is the level. */
  readonly formedIndex: number;
  /** Index of the D1 bar at whose close the level became known. */
  readonly knownIndex: number;
  readonly expiresIndex: number;
  touches: number;
}

interface Pending {
  readonly direction: Direction;
  readonly level: Level;
  /** ATR(14) D1 on the breakout bar; fixed for the life of the setup. */
  readonly atr: number;
  readonly breakoutIndex: number;
  readonly breakoutTime: number;
  readonly breakoutClose: number;
}

function createInstance(zoneOf: () => string) {
  const atr = new AtrWilder(STRONG_LEVEL.atrPeriod);
  let levels: Level[] = [];
  let pending: Pending | null = null;

  const serverDay = (utcMs: number): string =>
    DateTime.fromMillis(utcMs, { zone: zoneOf() }).toFormat("yyyy-LL-dd");

  const touches = (level: Level, bar: Bar, atrValue: number): boolean => {
    if (Number.isNaN(atrValue)) return false;
    const reach = STRONG_LEVEL.touchAtr * atrValue;
    return level.side === "resistance"
      ? bar.high >= level.price - reach && bar.close < level.price
      : bar.low <= level.price + reach && bar.close > level.price;
  };

  /** Rule 1: a D1 extreme that stands out of `wings` bars on both sides, known once the right wing has closed. */
  const discover = (d1: ClosedBars, n: number): void => {
    const wings = STRONG_LEVEL.wingsD1;
    const c = n - wings;
    if (c - wings < 0) return;
    const centre = d1.at(c) as Bar;
    let leftHigh = -Infinity;
    let leftLow = Infinity;
    for (let i = c - wings; i < c; i++) {
      const bar = d1.at(i) as Bar;
      leftHigh = Math.max(leftHigh, bar.high);
      leftLow = Math.min(leftLow, bar.low);
    }
    let rightHigh = -Infinity;
    let rightLow = Infinity;
    for (let i = c + 1; i <= n; i++) {
      const bar = d1.at(i) as Bar;
      rightHigh = Math.max(rightHigh, bar.high);
      rightLow = Math.min(rightLow, bar.low);
    }
    const found: Level[] = [];
    if (centre.high > leftHigh && centre.high > rightHigh) {
      found.push({ side: "resistance", price: centre.high, formedIndex: c, knownIndex: n, expiresIndex: n + STRONG_LEVEL.lifeD1, touches: 0 });
    }
    if (centre.low < leftLow && centre.low < rightLow) {
      found.push({ side: "support", price: centre.low, formedIndex: c, knownIndex: n, expiresIndex: n + STRONG_LEVEL.lifeD1, touches: 0 });
    }
    // Rule 2 counts touches from the bar after the extreme, including the right wing.
    for (const level of found) {
      for (let i = c + 1; i <= n; i++) {
        if (touches(level, d1.at(i) as Bar, atr.at(i))) level.touches++;
      }
      levels.push(level);
    }
  };

  const signalOf = (setup: Pending, retestBar: Bar, retestIndex: number, ctx: MarketContext): Signal => {
    const buy = setup.direction === "BUY";
    const buffer = STRONG_LEVEL.stopBufferAtr * setup.atr;
    const digits = ctx.spec.digits;
    const price = (value: number): string => value.toFixed(digits);
    const d1 = ctx.bars("D1");
    return {
      kind: "entry",
      direction: setup.direction,
      stopLoss: { price: buy ? retestBar.low - buffer : retestBar.high + buffer },
      takeProfit: { rMultiple: STRONG_LEVEL.takeProfitR },
      maxStopDistance: STRONG_LEVEL.maxStopAtr * setup.atr,
      reason:
        `L ${price(setup.level.price)} от ${serverDay((d1.at(setup.level.formedIndex) as Bar).time)}, касаний ${setup.level.touches}; ` +
        `ATR(14) D1 ${price(setup.atr)}; пробой ${serverDay(setup.breakoutTime)} close ${price(setup.breakoutClose)}; ` +
        `ретест ${serverDay(retestBar.time)} ${buy ? "low" : "high"} ${price(buy ? retestBar.low : retestBar.high)}` +
        (retestIndex - setup.breakoutIndex > 1 ? ` (${retestIndex - setup.breakoutIndex}-й день)` : ""),
    };
  };

  return {
    onBarClose(ctx: MarketContext): Signal | null {
      if (!ctx.justClosed("D1")) return null;
      const d1 = ctx.bars("D1");
      const n = d1.length - 1;
      const bar = d1.at(n);
      if (bar === undefined) return null;
      const atrNow = atr.update(d1);

      // Level bookkeeping runs always; trades only without an open position.
      discover(d1, n);
      for (const level of levels) {
        if (level.knownIndex < n && touches(level, bar, atrNow)) level.touches++;
      }
      levels = levels.filter((level) => n <= level.expiresIndex);
      const buffer = Number.isNaN(atrNow) ? Infinity : STRONG_LEVEL.breakoutBufferAtr * atrNow;
      const broken = levels.filter((level) =>
        level.side === "resistance"
          ? bar.close > level.price + buffer
          : bar.close < level.price - buffer,
      );
      if (broken.length > 0) {
        // Rule 3: one level, one attempt, whatever comes of it.
        levels = levels.filter((level) => !broken.includes(level));
      }

      if (ctx.position !== null) {
        pending = null;
        return null;
      }

      // Rule 4 on a pending breakout.
      if (pending !== null) {
        const setup = pending;
        const buy = setup.direction === "BUY";
        const since = n - setup.breakoutIndex;
        const retestBuffer = STRONG_LEVEL.breakoutBufferAtr * setup.atr;
        if (buy ? bar.close < setup.level.price : bar.close > setup.level.price) {
          pending = null;
        } else if (
          buy
            ? bar.low <= setup.level.price + retestBuffer && bar.close > setup.level.price
            : bar.high >= setup.level.price - retestBuffer && bar.close < setup.level.price
        ) {
          pending = null;
          return signalOf(setup, bar, n, ctx);
        } else if (since >= STRONG_LEVEL.retestBarsD1) {
          pending = null;
        }
        return null;
      }

      // A new setup from today's breakouts: only a touched level, the nearest one when several broke.
      const candidates = broken.filter((level) => level.touches > 0);
      if (candidates.length === 0 || Number.isNaN(atrNow)) return null;
      candidates.sort(
        (a, b) => Math.abs(bar.close - a.price) - Math.abs(bar.close - b.price),
      );
      const level = candidates[0] as Level;
      pending = {
        direction: level.side === "resistance" ? "BUY" : "SELL",
        level,
        atr: atrNow,
        breakoutIndex: n,
        breakoutTime: bar.time,
        breakoutClose: bar.close,
      };
      return null;
    },
  };
}

/**
 * StrongLevelD1 (TZ 16.4): a daily level that stands out of ten bars on each
 * side and was touched at least once; a D1 close beyond it by 0.1 x ATR(14)
 * is the breakout, a D1 bar back to the level within five days that closes
 * beyond it is the retest, the entry is the next D1 open, the stop sits
 * 0.1 x ATR beyond the retest extreme (at most 1.5 x ATR away), the take is
 * 2R. Runs on H1 bars like TrendD1.
 */
export const strongLevelD1: Strategy = {
  name: "StrongLevelD1",
  params: {
    ...STRONG_LEVEL,
    atrMethod: "Wilder",
    signalTimeframe: "D1",
    executionTimeframe: "H1",
  },
  executionTimeframe: "H1",
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
