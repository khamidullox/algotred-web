import type { SymbolName, Timeframe } from "../config";
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
  /** Close time of the bar that has just closed, UTC ms. Nothing after it is visible. */
  readonly now: number;
  bars(timeframe: Timeframe): ClosedBars;
  /** True when a bar of the timeframe has closed since the previous call. */
  justClosed(timeframe: Timeframe): boolean;
  /** The open position on this symbol, if any. */
  readonly position: OpenPosition | null;
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
  readonly reason: string;
}

/** Close the open position at the next open. Ignored when there is none. */
export interface ExitSignal {
  readonly kind: "exit";
  readonly reason: string;
}

export type StrategyAction = Signal | ExitSignal;

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
  /** One instance per symbol; it may keep state between bars. */
  create(symbol: SymbolName): StrategyInstance;
}

export type ExitReason = "stop" | "take" | "strategy" | "end-of-data";

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
  /** Server-time rollovers the position was held through (Saturday and Sunday nights do not count). */
  readonly nights: number;
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
  | "usd-exposure"
  | "invalid-levels"
  | "stop-too-far"
  | "lot-too-small";

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
