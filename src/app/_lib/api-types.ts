// Shapes shared by route handlers and client components. Types only: client
// code must never import values from the engine, which reads the file system.
import type { SymbolName, Timeframe } from "../../config";

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
