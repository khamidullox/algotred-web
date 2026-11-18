import { DateTime } from "luxon";
import type { MarketContext, StrategyAction, Strategy } from "../engine/types";
import { AtrWilder } from "../indicators/atr";

/** Fixed by TZ 17.5 (approved 2026-11-18). Not configurable on purpose. */
export const TIME_OF_DAY = {
  symbol: "EURUSD",
  europeZone: "Europe/London",
  europeOpenMinutes: 7 * 60,
  usZone: "America/New_York",
  usOpenMinutes: 8 * 60,
  usCloseMinutes: 16 * 60,
  atrPeriod: 20,
  atrMultiple: 2,
} as const;

interface LocalTime {
  /** Minutes since local midnight. */
  readonly minutes: number;
  /** 1 Monday .. 7 Sunday. */
  readonly weekday: number;
  /** Local date, yyyy-MM-dd. */
  readonly date: string;
}

function localTime(utcMs: number, zone: string): LocalTime {
  const local = DateTime.fromMillis(utcMs, { zone });
  return {
    minutes: local.hour * 60 + local.minute,
    weekday: local.weekday,
    date: local.toFormat("yyyy-LL-dd"),
  };
}

const weekday = (time: LocalTime): boolean => time.weekday <= 5;

/**
 * TimeOfDayEURUSD (TZ 17.5), after Breedon and Ranaldo (JMCB 2013): a
 * currency tends to fall while its own market works. Every weekday: sell
 * EURUSD at the 07:00 London open, reverse into a buy at the 08:00 New York
 * open, close at the 16:00 New York open. A stop 2 x ATR(20) of D1 away only
 * sizes the lot. Entries happen only at the open of the exact hour (a missing
 * bar cancels that entry); a position whose closing hour is missing is closed
 * at the first open after it.
 *
 * Runs on H1: `ctx.now` at a bar close is the open time of the next bar, where
 * a signal fills.
 */
export const timeOfDayEURUSD: Strategy = {
  name: "TimeOfDayEURUSD",
  params: {
    ...TIME_OF_DAY,
    europeOpen: "07:00 Europe/London",
    usOpen: "08:00 America/New_York",
    usClose: "16:00 America/New_York",
    atrMethod: "Wilder",
    signalTimeframe: "H1",
    executionTimeframe: "H1",
  },
  executionTimeframe: "H1",
  symbols: [TIME_OF_DAY.symbol],
  create: () => {
    const atr = new AtrWilder(TIME_OF_DAY.atrPeriod);
    /** New York date of the open of the position, for the overnight checks. */
    let openedOn: string | null = null;
    return {
      onBarClose(ctx: MarketContext): StrategyAction | null {
        // Incremental: only daily bars closed since the last call are added.
        const atrValue = atr.update(ctx.bars("D1"));
        const london = localTime(ctx.now, TIME_OF_DAY.europeZone);
        const newYork = localTime(ctx.now, TIME_OF_DAY.usZone);
        const price = (value: number): string => value.toFixed(ctx.spec.digits);
        const position = ctx.position;
        if (position === null) openedOn = null;

        const entry = (direction: "BUY" | "SELL", reason: string): StrategyAction | null => {
          if (Number.isNaN(atrValue)) return null;
          openedOn = newYork.date;
          return {
            kind: "entry",
            direction,
            stopLoss: { distance: TIME_OF_DAY.atrMultiple * atrValue },
            takeProfit: null,
            // Rules 1, 2 and 5: only the open of the exact hour.
            expectedEntryTime: ctx.now,
            reverse: true,
            reason: `${reason}; ATR(${TIME_OF_DAY.atrPeriod}) D1 ${price(atrValue)}`,
          };
        };

        // Rule 2: the reversal at the 08:00 New York open.
        if (weekday(newYork) && newYork.minutes === TIME_OF_DAY.usOpenMinutes) {
          return entry("BUY", "американские часы: покупка с 08:00 Нью-Йорк");
        }
        // Rule 1: the sell at the 07:00 London open.
        if (weekday(london) && london.minutes === TIME_OF_DAY.europeOpenMinutes && position === null) {
          return entry("SELL", "европейские часы: продажа с 07:00 Лондон");
        }

        if (position !== null) {
          const nextDay = openedOn !== null && newYork.date !== openedOn;
          // Rule 5: the sell lives until the 08:00 New York open; if that hour
          // never came (a missing bar), it is closed at the first open after it.
          if (position.direction === "SELL" && (nextDay || newYork.minutes > TIME_OF_DAY.usOpenMinutes)) {
            return { kind: "exit", reason: "после 08:00 Нью-Йорк без разворота" };
          }
          // Rule 3: the buy is closed at the 16:00 New York open, or at the
          // first open after it when that hour is missing.
          if (position.direction === "BUY" && (nextDay || newYork.minutes >= TIME_OF_DAY.usCloseMinutes)) {
            return { kind: "exit", reason: "16:00 Нью-Йорк" };
          }
        }
        return null;
      },
    };
  },
};
