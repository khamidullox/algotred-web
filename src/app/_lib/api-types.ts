// Shapes shared by route handlers and client components. Types only: client
// code must never import values from the engine, which reads the file system.
import type { AnyTimeframe, Dataset, SymbolName, Timeframe } from "../../config";

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
  timeframe: AnyTimeframe;
  digits: number;
  total: number;
  offset: number;
  bars: ChartBar[];
  /** Start of the holdout set, UTC seconds: bars of the project's files from there on are never served. Null when unknown. */
  hiddenFrom: number | null;
  /** End of the hidden holdout set, UTC seconds, when the terminal's candles are served after it (TZ 17.52); else null. */
  hiddenTo: number | null;
  /** Open time of the first and the last candle served from the terminal, UTC seconds; null when none. */
  liveFrom: number | null;
  liveTo: number | null;
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

/** One economic calendar release for the chart. Times in UTC seconds. */
export interface NewsItem {
  time: number;
  currency: string;
  code: string;
  name: string;
  importance: "LOW" | "MODERATE" | "HIGH" | "NONE";
  unit: number;
  multiplier: number;
  actual: number | null;
  forecast: number | null;
  previous: number | null;
}

export interface NewsResponse {
  items: NewsItem[];
  /** Why there is no calendar, when there is none. */
  problem: string | null;
}

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
  /** Partial close on the way to the take (TZ 17.10), or null. */
  partialTime: number | null;
  partialPrice: number | null;
  lots: number;
  netPnlUsd: number;
  rMultiple: number;
  reason: string;
  marks: ReasonMarks;
}

/** A resting order that went without a fill (TZ 17.15). Times in UTC seconds, like ChartBar. */
export interface ChartOrder {
  symbol: SymbolName;
  direction: "BUY" | "SELL";
  kind: "limit" | "stop";
  price: number;
  placedTime: number;
  endTime: number;
  /** Why it went, in the engine's words. */
  detail: string;
  marks: ReasonMarks;
}

export interface RunResponse {
  summary: RunSummary;
  brokerTimeZone: string;
  trades: ChartTrade[];
  /** Orders that were never filled; empty for runs saved before they were recorded. */
  orders: ChartOrder[];
}
