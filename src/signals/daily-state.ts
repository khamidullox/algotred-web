import { nextZoneDay } from "../data/time";
import type { Bar } from "../data/types";
import { ClosedBarsView } from "../engine/closed-bars";
import { roundPrice, type SymbolSpec } from "../engine/symbols";
import type { Direction, MarketContext, OpenPosition, Signal, Strategy, StrategyAction } from "../engine/types";

/** A trade of the daily replay: entry at a day's open, exit at a day's open or at the stop. */
export interface DailyTrade {
  readonly direction: Direction;
  /** Open time of the entry day, UTC ms. */
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly stopLoss: number;
  /** Open time of the day the position was closed in, UTC ms. */
  readonly exitTime: number;
  readonly exitPrice: number;
  readonly exitReason: "stop" | "strategy";
  /** The move in units of the stop distance, before any costs. */
  readonly r: number;
  readonly reason: string;
}

export interface DailyPosition {
  readonly direction: Direction;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly reason: string;
  /** Daily closes seen with the position open. */
  readonly days: number;
}

/** What the strategy says at the close of the last daily bar. */
export type DailyState =
  /** No position and no signal. */
  | { readonly kind: "flat" }
  /** A signal at the last close: enter at the next open. */
  | { readonly kind: "enter"; readonly direction: Direction; readonly stopDistance: number; readonly reason: string }
  /** A position is open and stays. */
  | { readonly kind: "open"; readonly position: DailyPosition }
  /** A position is open and the last close told to leave at the next open. */
  | { readonly kind: "exit"; readonly position: DailyPosition; readonly reason: string };

export interface DailyReplay {
  /** The last closed daily bar, or null without bars. */
  readonly asOf: Bar | null;
  readonly state: DailyState;
  /** Closed trades, oldest first. */
  readonly trades: readonly DailyTrade[];
}

const EMPTY = new ClosedBarsView([]);

/**
 * The daily bars that have closed by `now`: the last row of an export is the
 * day still trading when the file was saved on the same day.
 */
export function closedDailyBars(bars: readonly Bar[], zone: string, now: number): Bar[] {
  return bars.filter((bar) => nextZoneDay(bar.time, zone) <= now);
}

/**
 * Drives a daily strategy over closed D1 bars alone and reports where it
 * stands after the last one. The rules are the strategy's own code; only the
 * execution is simplified: an order fills at the open of the next daily bar
 * with no spread or slippage, and the stop is checked on the day's range (the
 * engine checks it on hourly bars, so a rare trade can differ). It is the
 * answer to "what does the strategy say today", not a backtest.
 *
 * Supports what the daily strategies use: market entries with a stop and
 * exits by the strategy's rule. Anything else throws instead of guessing.
 */
export function replayDaily(strategy: Strategy, symbol: string, spec: SymbolSpec, zone: string, bars: readonly Bar[]): DailyReplay {
  const instance = strategy.create(symbol);
  const view = new ClosedBarsView(bars);
  const trades: DailyTrade[] = [];
  let position: (OpenPosition & { days: number }) | null = null;
  let pending: StrategyAction | null = null;
  let now = 0;

  const ctx: MarketContext = {
    symbol,
    spec,
    zone,
    get now() {
      return now;
    },
    bars: (timeframe) => (timeframe === "D1" ? view : EMPTY),
    justClosed: (timeframe) => timeframe === "D1",
    get position() {
      return position;
    },
    order: null,
    news: () => [],
  };

  const close = (bar: Bar, price: number, exitReason: "stop" | "strategy"): void => {
    if (position === null) return;
    const sign = position.direction === "BUY" ? 1 : -1;
    const distance = sign * (position.entryPrice - position.stopLoss);
    trades.push({
      direction: position.direction,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      stopLoss: position.stopLoss,
      exitTime: bar.time,
      exitPrice: price,
      exitReason,
      r: (sign * (price - position.entryPrice)) / distance,
      reason: position.reason,
    });
    position = null;
  };

  const open = (bar: Bar, signal: Signal, signalTime: number): void => {
    if (signal.takeProfit !== null || signal.partial !== undefined || signal.limit !== undefined || signal.stopEntry !== undefined || signal.notBefore !== undefined) {
      throw new Error(`replayDaily: ${strategy.name} uses an order the daily replay does not model`);
    }
    const sign = signal.direction === "BUY" ? 1 : -1;
    const stopLoss = roundPrice(spec, "price" in signal.stopLoss ? signal.stopLoss.price : bar.open - sign * signal.stopLoss.distance);
    // A stop on the wrong side of the open: the engine would skip the trade.
    if (!(sign * (bar.open - stopLoss) > 0)) return;
    position = {
      direction: signal.direction,
      signalTime,
      entryTime: bar.time,
      entryPrice: bar.open,
      stopLoss,
      takeProfit: null,
      lots: 0,
      reason: signal.reason,
      days: 0,
    };
  };

  bars.forEach((bar, index) => {
    // The open of the day: what the previous close decided.
    if (pending !== null) {
      if (pending.kind === "entry" && position === null) open(bar, pending, now);
      else if (pending.kind === "exit") close(bar, bar.open, "strategy");
      pending = null;
    }
    // Inside the day: the stop, at the open when the day opens beyond it.
    if (position !== null) {
      const { direction, stopLoss } = position;
      if (direction === "BUY" && bar.low <= stopLoss) close(bar, Math.min(bar.open, stopLoss), "stop");
      else if (direction === "SELL" && bar.high >= stopLoss) close(bar, Math.max(bar.open, stopLoss), "stop");
    }
    // The close of the day.
    view.advanceTo(index + 1);
    now = nextZoneDay(bar.time, zone);
    if (position !== null) position = { ...position, days: position.days + 1 };
    const action = instance.onBarClose(ctx);
    if (action === null || action.kind === "cancel") return;
    if (action.kind === "entry" && position !== null) return;
    if (action.kind === "exit" && position === null) return;
    pending = action;
  });

  const asOf = bars.at(-1) ?? null;
  // Both are assigned inside the loop callback; the assertions undo the narrowing to their initial null.
  const held = position as (OpenPosition & { days: number }) | null;
  const own = (p: OpenPosition & { days: number }): DailyPosition => ({
    direction: p.direction,
    entryTime: p.entryTime,
    entryPrice: p.entryPrice,
    stopLoss: p.stopLoss,
    reason: p.reason,
    days: p.days,
  });
  const last = pending as StrategyAction | null;
  let state: DailyState = { kind: "flat" };
  if (last !== null && last.kind === "entry") {
    const distance = "distance" in last.stopLoss ? last.stopLoss.distance : Math.abs((asOf as Bar).close - last.stopLoss.price);
    state = { kind: "enter", direction: last.direction, stopDistance: distance, reason: last.reason };
  } else if (last !== null && last.kind === "exit" && held !== null) {
    state = { kind: "exit", position: own(held), reason: last.reason };
  } else if (held !== null) {
    state = { kind: "open", position: own(held) };
  }
  return { asOf, state, trades };
}
