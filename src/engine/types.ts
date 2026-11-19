import type { SymbolName, Timeframe } from "../config";
import type { NewsEvent, NewsFilter } from "../data/calendar";
import type { TimeSpan } from "../data/time";
import type { Bar } from "../data/types";
import type { SymbolSpec } from "./symbols";

export type Direction = "BUY" | "SELL";

/**
 * Bars that have closed by the current moment, oldest first. A strategy sees
 * the market only through this: a bar that is still forming is unreachable.
 */
export interface ClosedBars {
  readonly length: number;
  /** Bar by index; a negative index counts back from the last closed bar. */
  at(index: number): Bar | undefined;
  /** The most recently closed bar. */
  last(): Bar | undefined;
  /** The last `count` closed bars, oldest first; fewer when the history is shorter. */
  lastN(count: number): readonly Bar[];
  /** Like Array.prototype.slice, bounded by the closed bars. */
  slice(start?: number, end?: number): readonly Bar[];
}

export interface OpenPosition {
  readonly direction: Direction;
  /** Close time of the bar on which the entry signal appeared, UTC ms. */
  readonly signalTime: number;
  /** Open time of the bar in which the position was filled, UTC ms. */
  readonly entryTime: number;
  /** Actual fill, with spread and slippage. */
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number | null;
  readonly lots: number;
  readonly reason: string;
}

/** What a strategy is allowed to see at the close of a bar (TZ 7.1, 7.6). */
export interface MarketContext {
  readonly symbol: SymbolName;
  readonly spec: SymbolSpec;
  /** Broker server time zone, for strategies that print times the way MT5 shows them. */
  readonly zone: string;
  /** Close time of the bar that has just closed, UTC ms. Nothing after it is visible. */
  readonly now: number;
  bars(timeframe: Timeframe): ClosedBars;
  /** True when a bar of the timeframe has closed since the previous call. */
  justClosed(timeframe: Timeframe): boolean;
  /** The open position on this symbol, if any. */
  readonly position: OpenPosition | null;
  /** The resting limit order on this symbol, if any (TZ 17.10). */
  readonly order: RestingOrder | null;
  /**
   * Economic calendar events in [from, to), UTC ms, oldest first. The
   * schedule is visible ahead, as it is in a real calendar; the actual value
   * and the revised previous one only once the release time has come
   * (`time <= now`), so nothing leaks from the future. Empty without a calendar.
   */
  news(from: number, to: number, filter?: NewsFilter): readonly NewsEvent[];
}

/** A limit order waiting for its price (TZ 17.10). */
export interface RestingOrder {
  readonly direction: Direction;
  /** The limit price: an Ask for a buy, a Bid for a sell. */
  readonly price: number;
  /** Close time of the bar on which the order was placed, UTC ms. */
  readonly signalTime: number;
}

/**
 * A resting limit entry (TZ 17.10). It works from the bar after the signal:
 * a buy fills when the Ask reaches the price (Bid low plus the bar's spread),
 * a sell when the Bid high does; a bar that opens beyond the price fills at
 * the open. No slippage. In the bar of the fill only the stop is checked.
 */
export interface LimitSpec {
  readonly price: number;
  /**
   * The order is cancelled when the Bid reaches this level before the fill
   * (above the price for a buy, below for a sell). A bar that reaches both
   * this level and the price counts as cancelled: the order inside it is unknown.
   */
  readonly cancelAt?: number;
  /** The order is cancelled at the first bar that opens at or after this time (UTC ms). */
  readonly expiresAt?: number;
}

/**
 * Part of the position closed at a price (TZ 17.10). The rest keeps the stop
 * and the take; with `breakeven` its stop moves to the entry price from the
 * next bar. A bar that reaches the stop and this price counts as a stop.
 */
export interface PartialSpec {
  readonly price: number;
  /** Share of the lots closed, rounded down to the lot step; nothing is closed when that is 0. */
  readonly fraction: number;
  readonly breakeven: boolean;
}

/** An absolute price, or a distance from the actual entry price. */
export type StopLossSpec =
  | { readonly price: number }
  | { readonly distance: number };

/** An absolute price, a multiple of the actual stop distance, or null: the strategy exits by its own rule. */
export type TakeProfitSpec =
  | { readonly price: number }
  | { readonly rMultiple: number }
  | null;

export interface Signal {
  readonly kind: "entry";
  readonly direction: Direction;
  readonly stopLoss: StopLossSpec;
  readonly takeProfit: TakeProfitSpec;
  /**
   * The trade is skipped when the actual stop distance (from the fill to the
   * stop) is larger than this, in price units. BreakoutRetestV1 rule 7.
   */
  readonly maxStopDistance?: number;
  /**
   * The trade is skipped when the actual stop distance is smaller than this,
   * in price units. BreakoutRetestV2-minstop (TZ 16.2).
   */
  readonly minStopDistance?: number;
  /**
   * Once the favourable excursion has reached this many R at the close of a
   * bar, the stop moves to the entry price for the following bars (TZ 16.3).
   * The move never happens inside the bar that reached the level.
   */
  readonly breakevenAtR?: number;
  /**
   * Open time (UTC ms) the next bar must have for the signal to be filled;
   * when the next bar opens at any other time (a gap, the weekend) the signal
   * is dropped. Strategies whose entry must follow the signal bar at once set
   * it to the close time of the signal bar.
   */
  readonly expectedEntryTime?: number;
  /**
   * When a position in the other direction is open as the signal fills, close
   * it at the same open (exit reason "strategy") and then enter; the lot is
   * sized from the balance after that close (TZ 17.5). Without it an entry
   * signal with a position open is skipped as "position-open".
   */
  readonly reverse?: boolean;
  /**
   * A scheduled order (TZ 17.6): it rests until the first bar that opens at or
   * after this time (UTC ms) and fills at that open; earlier bars leave it
   * waiting. Without it the order fills at the next open.
   */
  readonly notBefore?: number;
  /**
   * A resting limit order instead of a market fill at the next open
   * (TZ 17.10). A new limit signal replaces a resting one. Not combined with
   * `reverse`, `notBefore` or `expectedEntryTime`.
   */
  readonly limit?: LimitSpec;
  /** Close part of the position at a price on the way to the take (TZ 17.10). */
  readonly partial?: PartialSpec;
  readonly reason: string;
}

/** Withdraw the resting limit order. Ignored when there is none. */
export interface CancelSignal {
  readonly kind: "cancel";
  readonly reason: string;
}

/** Close the open position at the next open. Ignored when there is none. */
export interface ExitSignal {
  readonly kind: "exit";
  readonly reason: string;
  /** A scheduled exit, as `Signal.notBefore`. Ignored if the position is gone by then. */
  readonly notBefore?: number;
}

export type StrategyAction = Signal | ExitSignal | CancelSignal;

export type ParamValue = number | string | boolean;

export interface StrategyInstance {
  /** Called at the close of every bar of the execution timeframe inside the dataset. */
  onBarClose(ctx: MarketContext): StrategyAction | null;
}

export interface Strategy {
  readonly name: string;
  /** Fixed by the TZ; written to EXPERIMENTS.md with every test run. */
  readonly params: Readonly<Record<string, ParamValue>>;
  /**
   * The timeframe that drives the loop: a signal is filled at the open of its
   * next bar and stops are checked on its bars (TZ 7.2: M15, or H1 for a D1 strategy).
   */
  readonly executionTimeframe: "M15" | "H1";
  /**
   * The instruments the strategy trades; the run uses only these (TZ 17.5).
   * Omitted: every instrument of the config.
   */
  readonly symbols?: readonly SymbolName[];
  /** One instance per symbol; it may keep state between bars. */
  create(symbol: SymbolName): StrategyInstance;
}

/** `breakeven` is a stop hit after it had been moved to the entry price. */
export type ExitReason = "stop" | "take" | "strategy" | "end-of-data" | "breakeven";

export interface Trade {
  readonly symbol: SymbolName;
  readonly direction: Direction;
  readonly reason: string;
  readonly signalTime: number;
  readonly entryTime: number;
  /** Actual fill, with spread and slippage. */
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number | null;
  /** From the fill to the stop, price units. */
  readonly stopDistance: number;
  readonly lots: number;
  /** USD lost if the stop is hit exactly, before costs. The R of the trade is netPnlUsd / riskUsd. */
  readonly riskUsd: number;
  /** Open time of the bar in which the position was closed; its close time for end-of-data. */
  readonly exitTime: number;
  readonly exitPrice: number;
  readonly exitReason: ExitReason;
  /** The stop in force when the position closed: the original one, or the entry price after a breakeven move. */
  readonly stopAtExit: number;
  /** Close time of the bar after which the stop was moved to breakeven, or null. */
  readonly breakevenTime: number | null;
  /** Partial close (TZ 17.10): open time of its bar, fill and lots; null when there was none. */
  readonly partialTime: number | null;
  readonly partialPrice: number | null;
  readonly partialLots: number | null;
  /** Server-time rollovers the position was held through (Saturday and Sunday nights do not count). */
  readonly nights: number;
  /**
   * Maximum adverse excursion: the furthest the price moved against the fill
   * while the position was open, in price units, measured on bar extremes at
   * the side the position is closed on (Bid for a buy, Ask for a sell). For a
   * stop exit it is the realised loss, never the bar's overshoot beyond it.
   */
  readonly maePrice: number;
  /** Maximum favourable excursion, same conventions; for a take exit it is the realised gain. */
  readonly mfePrice: number;
  /** maePrice / stopDistance. */
  readonly maeR: number;
  /** mfePrice / stopDistance. */
  readonly mfeR: number;
  /** The same fills with spread, slippage, commission and swap at zero. */
  readonly grossPnlUsd: number;
  readonly spreadCostUsd: number;
  readonly slippageCostUsd: number;
  readonly commissionUsd: number;
  /** Positive is a credit. */
  readonly swapUsd: number;
  /** grossPnlUsd - spreadCostUsd - slippageCostUsd - commissionUsd + swapUsd. */
  readonly netPnlUsd: number;
  readonly rMultiple: number;
  readonly balanceAfter: number;
}

export type SkipReason =
  | "position-open"
  | "no-next-bar"
  | "gap-after-signal"
  | "usd-exposure"
  | "invalid-levels"
  | "stop-too-far"
  | "stop-too-close"
  | "lot-too-small"
  | "order-cancelled"
  | "order-expired";

export interface SkippedSignal {
  readonly symbol: SymbolName;
  readonly direction: Direction;
  readonly signalTime: number;
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface BacktestResult {
  readonly strategy: string;
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly executionTimeframe: Timeframe;
  /** Instruments the run was given, in config order. */
  readonly symbols: readonly SymbolName[];
  readonly span: TimeSpan;
  readonly brokerTimeZone: string;
  readonly initialBalance: number;
  readonly finalBalance: number;
  /** 1 for a normal run, 2 for the stress test. */
  readonly costMultiplier: number;
  readonly usdExposureLimit: boolean;
  /** False when every swap setting is zero: the report must then warn that swap is not accounted for. */
  readonly swapAccounted: boolean;
  readonly trades: readonly Trade[];
  readonly skipped: readonly SkippedSignal[];
}
