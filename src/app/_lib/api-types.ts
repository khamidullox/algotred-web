// Shapes shared by route handlers and client components. Types only: client
// code must never import values from the engine, which reads the file system.
import type { Dataset, SymbolName, Timeframe } from "../../config";

export interface ChartBar {
  /** Bar open time, UTC, seconds. */
  time: number;
  /** The same instant shifted so that a UTC axis shows broker server time. */
  serverTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  spreadPoints: number;
}

export interface BarsResponse {
  symbol: SymbolName;
  timeframe: Timeframe;
  digits: number;
  total: number;
  offset: number;
  bars: ChartBar[];
  /** Start of the holdout set, UTC seconds: bars from there on are never served. Null when unknown. */
  hiddenFrom: number | null;
}

export interface UploadResponse {
  file: string;
  symbol: SymbolName;
  timeframe: Timeframe;
  rows: number;
  rowErrors: number;
}

export interface ApiError {
  error: string;
  exists?: boolean;
  file?: string;
}

/** One saved backtest run, as listed on the data page. */
export interface RunSummary {
  /** `dev/2026-11-17_12-30-00_TrendD1`: dataset and directory name. */
  id: string;
  strategy: string;
  dataset: Dataset;
  /** UTC ms. */
  finishedAt: number;
  trades: number;
  /** First and last server-time days of the dataset, yyyy-MM-dd. */
  firstDay: string;
  lastDay: string;
}

export type ChartTradeExit = "stop" | "take" | "strategy" | "end-of-data" | "breakeven";

export interface TradeMoment {
  /** As written by the strategy: «пробой», «ретест», «провал», «касание», … */
  readonly label: string;
  /** UTC seconds of the bar the strategy named (its open, server time converted). */
  readonly time: number;
}

export interface TrendPoint {
  /** UTC seconds. */
  readonly time: number;
  readonly price: number;
}

/** What the chart can draw from a trade's `reason` text (see trade-reason.ts). */
export interface ReasonMarks {
  /** Price of the level the trade was built on, when the strategy names one. */
  readonly level: number | null;
  /** When the level appeared, if the text says so; UTC seconds. */
  readonly levelFrom: number | null;
  readonly moments: readonly TradeMoment[];
  /** ThreeTouchTrendD1: the two swing points of the line and the touch, on the line. */
  readonly trendLine: readonly TrendPoint[] | null;
}

/** What the chart needs to draw one trade. Times in UTC seconds, like ChartBar. */
export interface ChartTrade {
  n: number;
  symbol: SymbolName;
  direction: "BUY" | "SELL";
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  exitTime: number;
  exitPrice: number;
  exitReason: ChartTradeExit;
  lots: number;
  netPnlUsd: number;
  rMultiple: number;
  reason: string;
  marks: ReasonMarks;
}

export interface RunResponse {
  summary: RunSummary;
  brokerTimeZone: string;
  trades: ChartTrade[];
}
