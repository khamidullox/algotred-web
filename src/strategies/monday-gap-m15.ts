import { DateTime } from "luxon";
import { NEW_YORK } from "../data/time";
import type { Bar } from "../data/types";
import { roundPrice } from "../engine/symbols";
import type { ClosedBars, MarketContext, Strategy, StrategyAction } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { FX_AND_GOLD } from "./baskets";

/** Fixed by TZ 17.16 (approved 2026-11-20). Not configurable on purpose. */
export const MONDAY_GAP = {
  atrPeriod: 14,
  /** Rule 3: the decision is taken this many minutes after the open of the week. */
  waitMinutes: 60,
  /** Rule 4: the distance to the Friday close is at least this many daily ATR. */
  minGapAtr: 0.2,
  /** Rule 8: part of the position is closed at this share of the gap, the rest goes to breakeven. */
  partialGapShare: 0.5,
  partialFraction: 0.5,
  /** Rule 10: the position is closed at the first bar that opens at or after this New York hour. */
  exitHourNewYork: 16,
} as const;

const M15 = 15 * 60_000;
const WAIT = MONDAY_GAP.waitMinutes * 60_000;

/**
 * Rule 1: true when a Saturday noon, server time, lies inside the break in
 * trading from `from` (the close of the last bar) to `to` (the open of the
 * next one). Holiday breaks in the middle of a week hold no Saturday.
 */
export function spansSaturdayNoon(from: number, to: number, zone: string): boolean {
  if (to <= from) return false;
  let noon = DateTime.fromMillis(from, { zone }).set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
  if (noon.toMillis() < from) noon = noon.plus({ days: 1 });
  // Luxon weekdays: 6 is Saturday.
  while (noon.weekday !== 6) noon = noon.plus({ days: 1 });
  return noon.toMillis() <= to;
}

/** Rule 10: the nearest 16:00 New York after `time`, UTC ms. */
export function exitTimeAfter(time: number): number {
  let exit = DateTime.fromMillis(time, { zone: NEW_YORK }).set({
    hour: MONDAY_GAP.exitHourNewYork,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  if (exit.toMillis() <= time) exit = exit.plus({ days: 1 });
  return exit.toMillis();
}

interface Week {
  /** Open time of the first bar of the week, UTC ms. */
  readonly open: number;
  /** Rule 2: the last bar before the weekend break and its close. */
  readonly fridayTime: number;
  readonly fridayClose: number;
}

/** The week that starts with the bar at `index`, or null when the bar does not follow a weekend break. */
function weekAt(bars: ClosedBars, index: number, zone: string): Week | null {
  const previous = bars.at(index - 1);
  const bar = bars.at(index);
  if (index < 1 || previous === undefined || bar === undefined) return null;
  const previousClose = previous.time + M15;
  // Consecutive bars: no break at all.
  if (bar.time === previousClose) return null;
  if (!spansSaturdayNoon(previousClose, bar.time, zone)) return null;
  return { open: bar.time, fridayTime: previous.time, fridayClose: previous.close };
}

function createInstance() {
  const atr = new AtrWilder(MONDAY_GAP.atrPeriod);
  /** Index of the last M15 bar looked at for a weekend break. */
  let scanned = -1;
  let week: Week | null = null;
  /** Rule 10: the exit still to be scheduled for the position this week opened. */
  let exitAt: number | null = null;

  const time = (ctx: MarketContext, utcMs: number): string =>
    DateTime.fromMillis(utcMs, { zone: ctx.zone }).toFormat("yyyy-LL-dd HH:mm");

  return {
    onBarClose(ctx: MarketContext): StrategyAction | null {
      const m15 = ctx.bars("M15");
      const n = m15.length - 1;
      const bar = m15.at(n);
      if (bar === undefined) return null;

      // Rules 1 and 2: the open of the week and the close before the break.
      if (scanned === -1) {
        // The week the run starts in began before the first call.
        for (let i = n; i >= 1 && week === null; i--) week = weekAt(m15, i, ctx.zone);
      } else {
        for (let i = scanned + 1; i <= n; i++) week = weekAt(m15, i, ctx.zone) ?? week;
      }
      scanned = n;

      // Rule 10: once the position is open, its exit is scheduled.
      if (ctx.position !== null) {
        if (exitAt === null) return null;
        const notBefore = exitAt;
        exitAt = null;
        return { kind: "exit", reason: `${MONDAY_GAP.exitHourNewYork}:00 Нью-Йорк`, notBefore };
      }

      // Rule 3: the bar that closes exactly one hour after the open of the week.
      if (week === null || ctx.now !== week.open + WAIT) return null;
      // Rule 4: the distance left to the Friday close against the daily ATR.
      const atrValue = atr.update(ctx.bars("D1"));
      if (Number.isNaN(atrValue)) return null;
      const close = bar.close;
      const gap = Math.abs(week.fridayClose - close);
      if (gap < MONDAY_GAP.minGapAtr * atrValue) return null;

      // Rule 5: towards the Friday close.
      const buy = close < week.fridayClose;
      const sign = buy ? 1 : -1;
      const stop = roundPrice(ctx.spec, close - sign * gap);
      const half = roundPrice(ctx.spec, close + sign * MONDAY_GAP.partialGapShare * gap);
      exitAt = exitTimeAfter(ctx.now);
      const price = (value: number): string => value.toFixed(ctx.spec.digits);
      return {
        kind: "entry",
        direction: buy ? "BUY" : "SELL",
        // Rule 7: as far from the decision price as the Friday close, on the other side.
        stopLoss: { price: stop },
        // Rule 9: the whole gap.
        takeProfit: { price: week.fridayClose },
        // Rule 8: half of the gap.
        partial: { price: half, fraction: MONDAY_GAP.partialFraction, breakeven: true },
        // Rule 6: only the open of the very next bar.
        expectedEntryTime: ctx.now,
        reason:
          `L ${price(week.fridayClose)} (close ${time(ctx, week.fridayTime)}); ` +
          `открытие недели ${time(ctx, week.open)}; через час ${price(close)}; ` +
          `гэп ${price(gap)} = ${(gap / atrValue).toFixed(2)} ATR(${MONDAY_GAP.atrPeriod}) D1 ${price(atrValue)}; ` +
          `стоп ${price(stop)}; половина ${price(half)}; срок ${time(ctx, exitAt)}`,
      };
    },
  };
}

/**
 * MondayGapM15 (TZ 17.16), after a market review of the customer's Telegram
 * export: the gap between the Friday close and the price one hour into the
 * new week tends to be closed. When that distance is at least 0.2 of the daily
 * ATR the strategy trades towards the Friday close: stop one gap away on the
 * other side, half closed at 50% of the gap with the rest at breakeven, the
 * rest taken at the Friday close, everything out by 16:00 New York.
 */
export const mondayGapM15: Strategy = {
  name: "MondayGapM15",
  params: {
    ...MONDAY_GAP,
    atrMethod: "Wilder",
    atrTimeframe: "D1",
    weekOpen: "first M15 bar after a break that holds a Saturday noon, server time",
    stop: "one gap beyond the decision price",
    takeProfit: "the Friday close",
    exit: "first M15 bar opening at or after 16:00 America/New_York",
    executionTimeframe: "M15",
  },
  executionTimeframe: "M15",
  symbols: FX_AND_GOLD,
  create: () => createInstance(),
};
