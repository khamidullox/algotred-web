import { DateTime } from "luxon";
import type { MarketContext, Strategy, StrategyAction } from "../engine/types";
import { nyseTradingDaysOfMonth } from "../data/nyse-calendar";
import { AtrWilder } from "../indicators/atr";

/**
 * The index CFDs of TZ 17.6 as `MetaQuotes-Demo` names them. The approved
 * rules name three; Nasdaq 100 (USTEC) has history only from July 2022 on
 * that server, which the frozen dataset boundaries cannot take, so the third
 * instrument waits for the customer's decision.
 */
export const INDEX_SYMBOLS = ["US500", "US30"] as const;

/** Fixed by TZ 17.6 (approved 2026-11-18). Not configurable on purpose. */
export const CALENDAR_WINDOW = {
  atrPeriod: 20,
  atrMultiple: 2,
  /** How long before the entry the order may be placed: covers a weekend and a holiday. */
  leadDays: 5,
} as const;

/** A holding window in NYSE trading days: bought at the open of `entryDay`, sold after the close of `lastDay`. */
export interface CalendarWindow {
  readonly entryDay: string;
  readonly lastDay: string;
}

const nextMonth = (year: number, month: number): [number, number] =>
  month === 12 ? [year + 1, 1] : [year, month + 1];

/** Day -1 (last trading day of the month) to day +3 (third trading day of the next). */
export function turnOfMonthWindow(year: number, month: number): CalendarWindow {
  const days = nyseTradingDaysOfMonth(year, month);
  const following = nyseTradingDaysOfMonth(...nextMonth(year, month));
  return { entryDay: days.at(-1) as string, lastDay: following[2] as string };
}

/** The control: the 10th to the 13th trading day of the month. */
export function midMonthWindow(year: number, month: number): CalendarWindow {
  const days = nyseTradingDaysOfMonth(year, month);
  return { entryDay: days[9] as string, lastDay: days[12] as string };
}

interface Planned {
  readonly window: CalendarWindow;
  readonly entryStart: number;
  readonly exitStart: number;
}

function createCalendarStrategy(options: {
  readonly name: string;
  readonly windowOf: (year: number, month: number) => CalendarWindow;
  readonly label: string;
  readonly windowRule: string;
}): Strategy {
  return {
    name: options.name,
    params: {
      ...CALENDAR_WINDOW,
      window: options.windowRule,
      calendar: "NYSE trading days; server day = futures day 17:00-17:00 New York",
      atrMethod: "Wilder",
      signalTimeframe: "D1",
      executionTimeframe: "H1",
      longOnly: true,
    },
    executionTimeframe: "H1",
    symbols: INDEX_SYMBOLS,
    create: () => {
      const atr = new AtrWilder(CALENDAR_WINDOW.atrPeriod);
      let planned: Planned | null = null;
      let exitPlaced = false;

      return {
        onBarClose(ctx: MarketContext): StrategyAction | null {
          const atrValue = atr.update(ctx.bars("D1"));
          const zone = ctx.zone;
          // A server day is the NYSE trading day of the same date (TZ 17.6).
          const startOf = (date: string): number => DateTime.fromISO(date, { zone }).toMillis();
          const dayAfter = (date: string): number =>
            DateTime.fromISO(date, { zone }).plus({ days: 1 }).toMillis();

          // Rule 3: once the position is open, the exit rests for the open after day +3.
          if (ctx.position !== null) {
            if (planned === null || exitPlaced) return null;
            exitPlaced = true;
            return {
              kind: "exit",
              notBefore: planned.exitStart,
              reason: `${options.label}: выход после ${planned.window.lastDay}`,
            };
          }
          exitPlaced = false;

          // Rule 2: the next window whose entry is still ahead.
          const now = DateTime.fromMillis(ctx.now, { zone });
          const candidates = [[now.year, now.month], nextMonth(now.year, now.month)] as const;
          let next: Planned | null = null;
          for (const [year, month] of candidates) {
            const window = options.windowOf(year, month);
            const entryStart = startOf(window.entryDay);
            // At ctx.now == entryStart the previous day has just closed: the
            // order still fills at the first open of the entry day.
            if (entryStart >= ctx.now) {
              next = { window, entryStart, exitStart: dayAfter(window.lastDay) };
              break;
            }
          }
          if (next === null) return null;
          if (next.entryStart - ctx.now > CALENDAR_WINDOW.leadDays * 86_400_000) return null;
          if (Number.isNaN(atrValue)) return null;
          // Placed again at every bar until it fills, so the stop uses the
          // last daily ATR known before the entry.
          planned = next;
          return {
            kind: "entry",
            direction: "BUY",
            stopLoss: { distance: CALENDAR_WINDOW.atrMultiple * atrValue },
            takeProfit: null,
            notBefore: next.entryStart,
            reason:
              `${options.label}: вход ${next.window.entryDay}, последний день ${next.window.lastDay}; ` +
              `ATR(${CALENDAR_WINDOW.atrPeriod}) D1 ${atrValue.toFixed(ctx.spec.digits)}`,
          };
        },
      };
    },
  };
}

/**
 * TurnOfMonthIndex (TZ 17.6), after McConnell and Xu (FAJ 2008): buy the index
 * CFDs at the open of the last NYSE trading day of the month and sell at the
 * open after the close of the third trading day of the next month; a stop
 * 2 x ATR(20) of D1 away only sizes the lot.
 */
export const turnOfMonthIndex: Strategy = createCalendarStrategy({
  name: "TurnOfMonthIndex",
  windowOf: turnOfMonthWindow,
  label: "конец месяца",
  windowRule: "last trading day of the month to the 3rd trading day of the next",
});

/** MidMonthIndexControl (TZ 17.6): the same trade on trading days 10 to 13 of the month. */
export const midMonthIndexControl: Strategy = createCalendarStrategy({
  name: "MidMonthIndexControl",
  windowOf: midMonthWindow,
  label: "контроль, середина месяца",
  windowRule: "trading days 10 to 13 of the month",
});
