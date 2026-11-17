import { DateTime } from "luxon";
import type { Bar } from "../data/types";
import type { Direction, MarketContext, Signal, Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { inSession } from "./breakout-retest-v1";

/** Fixed by TZ 16.5 (approved 2026-11-17). Not configurable on purpose. */
export const RECTANGLE = {
  atrPeriod: 14,
  impulseBars: 6,
  impulseAtr: 2,
  maxHeightAtr: 1,
  minBars: 8,
  maxBars: 30,
  breakoutBufferAtr: 0.1,
  retestBars: 6,
  stopBufferAtr: 0.1,
  maxStopAtr: 1.5,
  takeProfitR: 2,
} as const;

/** A rectangle forming after an impulse. */
interface Candidate {
  readonly direction: Direction;
  readonly impulseIndex: number;
  readonly impulseTime: number;
  readonly impulseMove: number;
  /** Midpoint of the impulse: the rectangle must stay on the far side of it. */
  readonly mid: number;
  top: number;
  bottom: number;
  bars: number;
}

interface Pending {
  readonly direction: Direction;
  readonly candidate: Candidate;
  /** ATR(14) on the breakout bar; fixed for the life of the setup. */
  readonly atr: number;
  readonly breakoutIndex: number;
  readonly breakoutTime: number;
  readonly breakoutClose: number;
}

function createInstance(zoneOf: () => string) {
  const atr = new AtrWilder(RECTANGLE.atrPeriod);
  let candidate: Candidate | null = null;
  let pending: Pending | null = null;

  const serverTime = (utcMs: number): string =>
    DateTime.fromMillis(utcMs, { zone: zoneOf() }).toFormat("yyyy-LL-dd HH:mm");

  const signalOf = (setup: Pending, retestBar: Bar, ctx: MarketContext): Signal => {
    const buy = setup.direction === "BUY";
    const buffer = RECTANGLE.stopBufferAtr * setup.atr;
    const digits = ctx.spec.digits;
    const price = (value: number): string => value.toFixed(digits);
    const rect = setup.candidate;
    return {
      kind: "entry",
      direction: setup.direction,
      stopLoss: { price: buy ? retestBar.low - buffer : retestBar.high + buffer },
      takeProfit: { rMultiple: RECTANGLE.takeProfitR },
      maxStopDistance: RECTANGLE.maxStopAtr * setup.atr,
      expectedEntryTime: ctx.now,
      reason:
        `импульс ${serverTime(rect.impulseTime)} ${buy ? "+" : "−"}${price(Math.abs(rect.impulseMove))}; ` +
        `прямоугольник ${price(rect.bottom)}–${price(rect.top)} за ${rect.bars} св.; ATR(14) ${price(setup.atr)}; ` +
        `пробой ${serverTime(setup.breakoutTime)} close ${price(setup.breakoutClose)}; ` +
        `ретест ${serverTime(retestBar.time)} ${buy ? "low" : "high"} ${price(buy ? retestBar.low : retestBar.high)}`,
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

      // Nothing is tracked while a position is open (rule 10).
      if (ctx.position !== null) {
        candidate = null;
        pending = null;
        return null;
      }

      // Rule 4: a breakout waiting for its retest.
      if (pending !== null) {
        const setup = pending;
        const buy = setup.direction === "BUY";
        const edge = buy ? setup.candidate.top : setup.candidate.bottom;
        const buffer = RECTANGLE.breakoutBufferAtr * setup.atr;
        const since = n - setup.breakoutIndex;
        if (buy ? bar.close < edge : bar.close > edge) {
          pending = null;
        } else if (
          buy
            ? bar.low <= edge + buffer && bar.close > edge
            : bar.high >= edge - buffer && bar.close < edge
        ) {
          pending = null;
          // One rectangle, one attempt: whether or not the session allows the entry.
          return inSession(ctx.now) ? signalOf(setup, bar, ctx) : null;
        } else if (since >= RECTANGLE.retestBars) {
          pending = null;
        }
        return null;
      }

      if (Number.isNaN(atrNow)) return null;

      // Rule 1: an impulse starts (or restarts) a candidate rectangle after itself.
      // The impulse bar must itself extend the move (its close is the extreme of
      // the last six closes); otherwise every flat bar in the six after a jump
      // would count as a new impulse and the rectangle could never begin.
      const before = h1.at(n - RECTANGLE.impulseBars);
      if (before !== undefined) {
        const move = bar.close - before.close;
        let extreme = true;
        for (let i = n - RECTANGLE.impulseBars + 1; i < n && extreme; i++) {
          const close = (h1.at(i) as Bar).close;
          extreme = move > 0 ? close < bar.close : close > bar.close;
        }
        if (extreme && Math.abs(move) >= RECTANGLE.impulseAtr * atrNow) {
          candidate = {
            direction: move > 0 ? "BUY" : "SELL",
            impulseIndex: n,
            impulseTime: bar.time,
            impulseMove: move,
            mid: (before.close + bar.close) / 2,
            top: -Infinity,
            bottom: Infinity,
            bars: 0,
          };
          return null;
        }
      }
      if (candidate === null) return null;

      // Rules 2 and 3 on the growing rectangle. The breakout is judged against
      // the rectangle as it stood before this bar.
      const rect = candidate;
      const buy = rect.direction === "BUY";
      const buffer = RECTANGLE.breakoutBufferAtr * atrNow;
      if (rect.bars >= RECTANGLE.minBars) {
        const brokeOut = buy ? bar.close > rect.top + buffer : bar.close < rect.bottom - buffer;
        if (brokeOut) {
          candidate = null;
          pending = {
            direction: rect.direction,
            candidate: rect,
            atr: atrNow,
            breakoutIndex: n,
            breakoutTime: bar.time,
            breakoutClose: bar.close,
          };
          return null;
        }
      }
      const brokeDown = buy ? bar.close < rect.bottom - buffer : bar.close > rect.top + buffer;
      if (rect.bars > 0 && brokeDown) {
        candidate = null;
        return null;
      }
      rect.top = Math.max(rect.top, bar.high);
      rect.bottom = Math.min(rect.bottom, bar.low);
      rect.bars++;
      const tooTall = rect.top - rect.bottom > RECTANGLE.maxHeightAtr * atrNow;
      const retraced = buy ? rect.bottom < rect.mid : rect.top > rect.mid;
      if (tooTall || retraced || rect.bars > RECTANGLE.maxBars) {
        candidate = null;
      }
      return null;
    },
  };
}

/**
 * RectangleV1 (TZ 16.5): a pause after an impulse. An H1 close that moved
 * 2 x ATR(14) in six bars starts a rectangle; the rectangle must stay within
 * 1 x ATR, on the far half of the impulse, for 8 to 30 bars; an H1 close
 * beyond its edge by 0.1 x ATR in the impulse direction is the breakout; an
 * H1 bar back to the edge within six bars that closes beyond it is the
 * retest and the signal; entry at the next M15 open inside the London or
 * New York session, stop 0.1 x ATR beyond the retest extreme (at most
 * 1.5 x ATR away), take 2R.
 */
export const rectangleV1: Strategy = {
  name: "RectangleV1",
  params: {
    ...RECTANGLE,
    atrMethod: "Wilder",
    sessions: "08:00-17:00 Europe/London or America/New_York, inclusive",
    cancelOnGapAfterRetest: true,
    signalTimeframe: "H1",
    executionTimeframe: "M15",
  },
  executionTimeframe: "M15",
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
