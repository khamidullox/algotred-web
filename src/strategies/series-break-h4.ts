import { DateTime } from "luxon";
import type { Bar } from "../data/types";
import type { MarketContext, Signal, Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { FX_GOLD_AND_INDICES } from "./baskets";

/** Fixed by TZ 17.8 (approved 2026-11-18). Not configurable on purpose. */
export const SERIES_BREAK = {
  blockHours: 4,
  /** A block with fewer H1 bars is not a candle (holidays, the one-bar days of 2015 index data). */
  minHoursInBlock: 3,
  minSeriesBars: 6,
  /** At least two thirds of the series bars go the series' way. */
  minColourShare: 2 / 3,
  minMoveAtr: 2,
  atrPeriod: 14,
  stopBufferAtr: 0.1,
  maxStopAtr: 3,
  takeProfitR: 2,
} as const;

export interface H4Bar extends Bar {
  /** UTC ms of the block's end: the time the next hour opens. */
  readonly end: number;
}

/** Start of the server-time 4-hour block an instant belongs to. */
export function blockStart(utcMs: number, zone: string): number {
  const local = DateTime.fromMillis(utcMs, { zone });
  const hour = local.hour - (local.hour % SERIES_BREAK.blockHours);
  return local.startOf("day").set({ hour }).toMillis();
}

interface Run {
  /** Index in the H4 list of the run's first bar. */
  start: number;
}

function createInstance(zoneOf: () => string) {
  const atr = new AtrWilder(SERIES_BREAK.atrPeriod);
  const h4: H4Bar[] = [];
  let pending: { start: number; bars: Bar[] } | null = null;
  /** H1 bars already put into blocks: history before the run counts too. */
  let processed = 0;
  const up: Run = { start: 0 };
  const down: Run = { start: 0 };

  const stamp = (utcMs: number): string => DateTime.fromMillis(utcMs, { zone: zoneOf() }).toFormat("yyyy-LL-dd HH:mm");

  /** Turns the pending block into an H4 bar when it has enough hours. */
  const finalize = (): H4Bar | null => {
    const block = pending;
    pending = null;
    if (block === null || block.bars.length < SERIES_BREAK.minHoursInBlock) return null;
    const first = block.bars[0] as Bar;
    const last = block.bars.at(-1) as Bar;
    const end = DateTime.fromMillis(block.start, { zone: zoneOf() }).plus({ hours: SERIES_BREAK.blockHours }).toMillis();
    return {
      time: block.start,
      end,
      open: first.open,
      high: Math.max(...block.bars.map((bar) => bar.high)),
      low: Math.min(...block.bars.map((bar) => bar.low)),
      close: last.close,
      tickVolume: block.bars.reduce((sum, bar) => sum + bar.tickVolume, 0),
      spreadPoints: Math.min(...block.bars.map((bar) => bar.spreadPoints)),
    };
  };

  /** Rules 1-6 on a new H4 bar. */
  const onH4 = (bar: H4Bar, ctx: MarketContext): Signal | null => {
    h4.push(bar);
    const k = h4.length - 1;
    const atrValue = atr.push(bar, h4[k - 1]);
    if (k === 0) return null;
    const previous = h4[k - 1] as H4Bar;

    // Rule 7: no series are tracked while a position is open.
    if (ctx.position !== null) {
      up.start = k;
      down.start = k;
      return null;
    }

    let signal: Signal | null = null;
    const check = (kind: "up" | "down"): void => {
      const run = kind === "up" ? up : down;
      const broke = kind === "up" ? bar.low < previous.low : bar.high > previous.high;
      if (!broke) return;
      const series = h4.slice(run.start, k);
      run.start = k;
      if (signal !== null || Number.isNaN(atrValue)) return;
      if (series.length < SERIES_BREAK.minSeriesBars) return;
      const coloured = series.filter((item) => (kind === "up" ? item.close > item.open : item.close < item.open)).length;
      if (coloured < SERIES_BREAK.minColourShare * series.length - 1e-9) return;
      const move = kind === "up" ? (series.at(-1) as H4Bar).close - (series[0] as H4Bar).open : (series[0] as H4Bar).open - (series.at(-1) as H4Bar).close;
      if (move < SERIES_BREAK.minMoveAtr * atrValue) return;
      const buffer = SERIES_BREAK.stopBufferAtr * atrValue;
      const extreme = kind === "up" ? Math.max(...series.map((item) => item.high), bar.high) : Math.min(...series.map((item) => item.low), bar.low);
      const price = (value: number): string => value.toFixed(ctx.spec.digits);
      signal = {
        kind: "entry",
        direction: kind === "up" ? "SELL" : "BUY",
        stopLoss: { price: kind === "up" ? extreme + buffer : extreme - buffer },
        takeProfit: { rMultiple: SERIES_BREAK.takeProfitR },
        maxStopDistance: SERIES_BREAK.maxStopAtr * atrValue,
        // Rule 3: only the hour that opens when the signal candle closes.
        expectedEntryTime: bar.end,
        reason:
          `серия ${kind === "up" ? "вверх" : "вниз"} ${series.length} св. H4 с ${stamp((series[0] as H4Bar).time)}, ` +
          `${kind === "up" ? "белых" : "чёрных"} ${coloured}, ход ${price(move)}; ` +
          `пробой ${kind === "up" ? "минимума" : "максимума"} ${stamp(bar.time)}; ATR(14) H4 ${price(atrValue)}`,
      };
    };
    // A bar can break both sides (an outside bar); both runs restart.
    check("up");
    check("down");
    return signal;
  };

  return {
    onBarClose(ctx: MarketContext): Signal | null {
      const h1 = ctx.bars("H1");
      const zone = zoneOf();
      let signal: Signal | null = null;
      for (let i = processed; i < h1.length; i++) {
        const bar = h1.at(i) as Bar;
        // Only the bar that has just closed may give a signal; older bars only build history.
        const live = i === h1.length - 1;
        const start = blockStart(bar.time, zone);
        // A bar of a later block closes a block that ended without its last hour.
        if (pending !== null && pending.start !== start) {
          const late = finalize();
          if (late !== null) {
            const result = onH4(late, ctx);
            if (live && result !== null) signal = result;
          }
        }
        if (pending === null) pending = { start, bars: [] };
        pending.bars.push(bar);
        const end = DateTime.fromMillis(start, { zone }).plus({ hours: SERIES_BREAK.blockHours }).toMillis();
        if (bar.time + 3_600_000 >= end) {
          const done = finalize();
          if (done !== null) {
            const result = onH4(done, ctx);
            if (live && result !== null) signal = result;
          }
        }
      }
      processed = h1.length;
      return signal;
    },
  };
}

/**
 * SeriesBreakH4 (TZ 17.8), after Aziz Halikov's candle model: H4 candles
 * built from H1; a run of at least six candles in which no low breaks the
 * previous low, two thirds of them white, rising at least 2 x ATR(14) H4;
 * the first candle whose low breaks the previous low is the signal; sell at
 * the next hour's open, stop 0.1 x ATR above the run's high (at most
 * 3 x ATR away), take 2R. Falling runs mirror it.
 */
export const seriesBreakH4: Strategy = {
  name: "SeriesBreakH4",
  params: {
    ...SERIES_BREAK,
    candles: "H4 from H1, server-time blocks 00/04/08/12/16/20",
    atrMethod: "Wilder on H4",
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
