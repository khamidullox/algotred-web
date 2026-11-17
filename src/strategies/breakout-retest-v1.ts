import { DateTime } from "luxon";
import type { Bar } from "../data/types";
import type {
  Direction,
  MarketContext,
  Signal,
  Strategy,
  StrategyInstance,
} from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { donchian } from "../indicators/donchian";
import { Sma } from "../indicators/sma";

/** Fixed by TZ 8.2. Not configurable on purpose. */
export const BREAKOUT_RETEST = {
  levelLookback: 20,
  atrPeriod: 14,
  breakoutBufferAtr: 0.1,
  retestBars: 6,
  confirmBarsM15: 4,
  stopBufferAtr: 0.1,
  maxStopAtr: 1.5,
  takeProfitR: 2,
  trendSmaPeriod: 200,
  sessionStart: 8 * 60,
  sessionEnd: 17 * 60,
} as const;

export interface BreakoutRetestOptions {
  readonly name: string;
  /** Variant B: trade only in the direction of SMA(200) on H1. */
  readonly trendFilter: boolean;
  /**
   * Stage 2 (TZ 16.2): skip the trade when the actual stop distance is below
   * this many ATR(14); null keeps the V1 rules.
   */
  readonly minStopAtr: number | null;
}

interface Setup {
  readonly direction: Direction;
  /** The level L: the extreme of the 20 H1 bars before the breakout bar. */
  readonly level: number;
  /** ATR(14) on the breakout bar; fixed for the life of the setup. */
  readonly atr: number;
  readonly breakoutIndex: number;
  readonly breakoutTime: number;
  readonly breakoutClose: number;
  readonly retest: {
    readonly index: number;
    readonly time: number;
    /** The low of the retest bar for a buy, its high for a sell. */
    readonly extreme: number;
    /** Index of the first M15 bar that may confirm. */
    readonly confirmFrom: number;
  } | null;
}

/** 08:00–17:00 in London or in New York, both ends included (TZ 8.2, rule 9). */
export function inSession(utcMs: number): boolean {
  return ["Europe/London", "America/New_York"].some((zone) => {
    const local = DateTime.fromMillis(utcMs, { zone });
    const minutes = local.hour * 60 + local.minute;
    return minutes >= BREAKOUT_RETEST.sessionStart && minutes <= BREAKOUT_RETEST.sessionEnd;
  });
}

function createInstance(
  options: BreakoutRetestOptions,
  ctxZone: () => string,
): StrategyInstance {
  const atr = new AtrWilder(BREAKOUT_RETEST.atrPeriod);
  const sma = options.trendFilter ? new Sma(BREAKOUT_RETEST.trendSmaPeriod) : null;
  let setup: Setup | null = null;

  const serverTime = (utcMs: number): string =>
    DateTime.fromMillis(utcMs, { zone: ctxZone() }).toFormat("yyyy-LL-dd HH:mm");

  /** Rule 2 (and the trend filter of variant B) on the H1 bar that has just closed. */
  function findBreakout(ctx: MarketContext): Setup | null {
    const h1 = ctx.bars("H1");
    const index = h1.length - 1;
    const bar = h1.at(index);
    if (bar === undefined) return null;
    const channel = donchian(h1, BREAKOUT_RETEST.levelLookback);
    const atrValue = atr.at(index);
    if (channel === null || Number.isNaN(atrValue)) return null;
    const buffer = BREAKOUT_RETEST.breakoutBufferAtr * atrValue;
    const trend = sma === null ? null : sma.at(index);
    if (sma !== null && Number.isNaN(trend as number)) return null;

    let direction: Direction | null = null;
    let level = 0;
    if (bar.close > channel.high + buffer && (trend === null || bar.close > trend)) {
      direction = "BUY";
      level = channel.high;
    } else if (bar.close < channel.low - buffer && (trend === null || bar.close < trend)) {
      direction = "SELL";
      level = channel.low;
    }
    if (direction === null) return null;
    return {
      direction,
      level,
      atr: atrValue,
      breakoutIndex: index,
      breakoutTime: bar.time,
      breakoutClose: bar.close,
      retest: null,
    };
  }

  /** Rule 3 on the H1 bar that has just closed. Returns the new state of the setup. */
  function trackRetest(current: Setup, ctx: MarketContext): Setup | null {
    const h1 = ctx.bars("H1");
    const m15 = ctx.bars("M15");
    const index = h1.length - 1;
    const bar = h1.at(index) as Bar;
    const since = index - current.breakoutIndex;
    if (since < 1) return current;
    const buffer = BREAKOUT_RETEST.breakoutBufferAtr * current.atr;
    const buy = current.direction === "BUY";

    // A close back through the level cancels the setup.
    if (buy ? bar.close < current.level : bar.close > current.level) return null;

    const touched = buy
      ? bar.low <= current.level + buffer && bar.close > current.level
      : bar.high >= current.level - buffer && bar.close < current.level;
    if (touched) {
      return {
        ...current,
        retest: {
          index,
          time: bar.time,
          extreme: buy ? bar.low : bar.high,
          // The next M15 bar to close is the first candidate.
          confirmFrom: m15.length,
        },
      };
    }
    return since >= BREAKOUT_RETEST.retestBars ? null : current;
  }

  /** Rule 4 on the M15 bar that has just closed. */
  function confirmed(current: Setup, ctx: MarketContext): boolean | null {
    const retest = current.retest;
    if (retest === null) return null;
    const m15 = ctx.bars("M15");
    const index = m15.length - 1;
    if (index < retest.confirmFrom) return null;
    const bar = m15.at(index) as Bar;
    const previous = m15.at(index - 1);
    if (previous === undefined) return false;
    const yes =
      current.direction === "BUY" ? bar.close > previous.high : bar.close < previous.low;
    if (yes) return true;
    // Four M15 bars and no confirmation: the setup is over.
    return index - retest.confirmFrom + 1 >= BREAKOUT_RETEST.confirmBarsM15 ? false : null;
  }

  function signalOf(current: Setup, ctx: MarketContext): Signal {
    const retest = current.retest as NonNullable<Setup["retest"]>;
    const buy = current.direction === "BUY";
    const buffer = BREAKOUT_RETEST.stopBufferAtr * current.atr;
    const digits = ctx.spec.digits;
    const price = (value: number): string => value.toFixed(digits);
    return {
      kind: "entry",
      direction: current.direction,
      stopLoss: { price: buy ? retest.extreme - buffer : retest.extreme + buffer },
      takeProfit: { rMultiple: BREAKOUT_RETEST.takeProfitR },
      maxStopDistance: BREAKOUT_RETEST.maxStopAtr * current.atr,
      ...(options.minStopAtr === null
        ? {}
        : { minStopDistance: options.minStopAtr * current.atr }),
      // The entry must be the M15 that opens right after the confirmation;
      // a weekend or any other gap in between cancels the signal (decision of 2026-11-17).
      expectedEntryTime: ctx.now,
      reason:
        `L ${price(current.level)}; ATR(14) ${price(current.atr)}; ` +
        `пробой ${serverTime(current.breakoutTime)} close ${price(current.breakoutClose)}; ` +
        `ретест ${serverTime(retest.time)} ${buy ? "low" : "high"} ${price(retest.extreme)}; ` +
        `подтверждение ${serverTime(ctx.now - 15 * 60_000)}` +
        (sma === null ? "" : `; SMA(200) ${price(sma.at(current.breakoutIndex))}`),
    };
  }

  return {
    onBarClose(ctx) {
      const h1 = ctx.bars("H1");
      if (ctx.justClosed("H1")) {
        atr.update(h1);
        sma?.update(h1);
      }

      // No setups are tracked while a position is open (TZ 7.5: one position per pair).
      if (ctx.position !== null) {
        setup = null;
        return null;
      }

      if (ctx.justClosed("H1")) {
        if (setup !== null && setup.retest === null) {
          setup = trackRetest(setup, ctx);
        }
        if (setup === null) {
          setup = findBreakout(ctx);
        }
      }

      if (setup !== null && setup.retest !== null) {
        const result = confirmed(setup, ctx);
        if (result === true) {
          const ready = setup;
          // One breakout, one trade (TZ 7.5): the setup is spent either way.
          setup = null;
          return inSession(ctx.now) ? signalOf(ready, ctx) : null;
        }
        if (result === false) {
          setup = null;
        }
      }
      return null;
    },
  };
}

export function createBreakoutRetest(options: BreakoutRetestOptions): Strategy {
  return {
    name: options.name,
    params: {
      levelLookbackH1: BREAKOUT_RETEST.levelLookback,
      atrPeriodH1: BREAKOUT_RETEST.atrPeriod,
      atrMethod: "Wilder",
      breakoutBufferAtr: BREAKOUT_RETEST.breakoutBufferAtr,
      retestBarsH1: BREAKOUT_RETEST.retestBars,
      confirmBarsM15: BREAKOUT_RETEST.confirmBarsM15,
      stopBufferAtr: BREAKOUT_RETEST.stopBufferAtr,
      maxStopAtr: BREAKOUT_RETEST.maxStopAtr,
      takeProfitR: BREAKOUT_RETEST.takeProfitR,
      sessions: "08:00-17:00 Europe/London or America/New_York, inclusive",
      cancelOnGapAfterConfirmation: true,
      trendFilter: options.trendFilter ? `SMA(${BREAKOUT_RETEST.trendSmaPeriod}) H1` : "none",
      minStopAtr: options.minStopAtr ?? "none",
      executionTimeframe: "M15",
    },
    executionTimeframe: "M15",
    create: () => {
      // The zone is read from the context on the first call; the instance is per symbol.
      let zone = "utc";
      const instance = createInstance(options, () => zone);
      return {
        onBarClose(ctx) {
          zone = ctx.zone;
          return instance.onBarClose(ctx);
        },
      };
    },
  };
}

export const breakoutRetestV1A = createBreakoutRetest({
  name: "BreakoutRetestV1-A",
  trendFilter: false,
  minStopAtr: null,
});
export const breakoutRetestV1B = createBreakoutRetest({
  name: "BreakoutRetestV1-B",
  trendFilter: true,
  minStopAtr: null,
});
/** Stage 2, TZ 16.2: V1-A with trades whose stop is tighter than 0.5 x ATR(14) skipped. */
export const breakoutRetestV2MinStop = createBreakoutRetest({
  name: "BreakoutRetestV2-minstop",
  trendFilter: false,
  minStopAtr: 0.5,
});
