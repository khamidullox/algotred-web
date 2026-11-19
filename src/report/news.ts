// How a run's trades sit against important economic news. Definitions fixed
// on 2026-11-19, before any run was looked at through them.
import { eventsBetween, symbolCurrencies, type NewsEvent } from "../data/calendar";
import type { Trade } from "../engine/types";
import { computeMetrics, type MetricsBlock } from "./metrics";

/** Entries this close to a release count as "near the news". */
export const NEWS_WINDOW_MINUTES = 30;
const WINDOW = NEWS_WINDOW_MINUTES * 60_000;

export interface NewsBreakdown {
  readonly windowMinutes: number;
  /** HIGH, exact-time events of the run's currencies inside its span. */
  readonly events: number;
  /** Entry within ± the window of such an event of the instrument's currencies. */
  readonly near: MetricsBlock;
  /** Not near, but such an event came out while the position was open. */
  readonly during: MetricsBlock;
  /** Neither. */
  readonly clear: MetricsBlock;
}

export type NewsGroup = "near" | "during" | "clear";

/** Which group a trade falls into; `events` must be sorted by time. */
export function newsGroup(trade: Pick<Trade, "symbol" | "entryTime" | "exitTime">, events: readonly NewsEvent[]): NewsGroup {
  const filter = { currencies: symbolCurrencies(trade.symbol), minImportance: "HIGH" as const };
  if (eventsBetween(events, trade.entryTime - WINDOW, trade.entryTime + WINDOW + 1, filter).length > 0) return "near";
  if (eventsBetween(events, trade.entryTime + 1, trade.exitTime, filter).length > 0) return "during";
  return "clear";
}

export function newsBreakdown(
  trades: readonly Trade[],
  events: readonly NewsEvent[],
  initialBalance: number,
  span: { readonly start: number; readonly end: number },
  symbols: readonly string[],
): NewsBreakdown {
  const groups: Record<NewsGroup, Trade[]> = { near: [], during: [], clear: [] };
  for (const trade of trades) groups[newsGroup(trade, events)].push(trade);
  const currencies = [...new Set(symbols.flatMap(symbolCurrencies))];
  return {
    windowMinutes: NEWS_WINDOW_MINUTES,
    events: eventsBetween(events, span.start, span.end, { currencies, minImportance: "HIGH" }).length,
    near: computeMetrics(groups.near, initialBalance),
    during: computeMetrics(groups.during, initialBalance),
    clear: computeMetrics(groups.clear, initialBalance),
  };
}
