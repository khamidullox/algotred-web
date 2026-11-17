import { DateTime } from "luxon";
import type { Trade } from "../engine/types";
import { SYMBOL_SPECS } from "../engine/symbols";

/** Column order of trades.csv. Prices in the symbol's digits, money in cents, times both server and UTC. */
export const TRADE_CSV_COLUMNS = [
  "n",
  "symbol",
  "direction",
  "signal_server",
  "entry_server",
  "entry_price",
  "stop_loss",
  "take_profit",
  "stop_points",
  "lots",
  "risk_usd",
  "exit_server",
  "exit_price",
  "exit_reason",
  "nights",
  "mae_pips",
  "mfe_pips",
  "mae_r",
  "mfe_r",
  "gross_usd",
  "spread_usd",
  "slippage_usd",
  "commission_usd",
  "swap_usd",
  "net_usd",
  "r",
  "balance_after",
  "entry_utc",
  "exit_utc",
  "reason",
] as const;

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",;\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function tradeRow(trade: Trade, index: number, zone: string): string[] {
  const spec = SYMBOL_SPECS[trade.symbol];
  const price = (value: number | null): string =>
    value === null ? "" : value.toFixed(spec.digits);
  const server = (utcMs: number): string =>
    DateTime.fromMillis(utcMs, { zone }).toFormat("yyyy-LL-dd HH:mm");
  const utc = (utcMs: number): string =>
    DateTime.fromMillis(utcMs, { zone: "utc" }).toFormat("yyyy-LL-dd'T'HH:mm'Z'");
  const money = (value: number): string => value.toFixed(2);
  return [
    String(index + 1),
    trade.symbol,
    trade.direction,
    server(trade.signalTime),
    server(trade.entryTime),
    price(trade.entryPrice),
    price(trade.stopLoss),
    price(trade.takeProfit),
    String(Math.round(trade.stopDistance / spec.point)),
    trade.lots.toFixed(2),
    money(trade.riskUsd),
    server(trade.exitTime),
    price(trade.exitPrice),
    trade.exitReason,
    String(trade.nights),
    (trade.maePrice / spec.pip).toFixed(1),
    (trade.mfePrice / spec.pip).toFixed(1),
    trade.maeR.toFixed(2),
    trade.mfeR.toFixed(2),
    money(trade.grossPnlUsd),
    money(trade.spreadCostUsd),
    money(trade.slippageCostUsd),
    money(trade.commissionUsd),
    money(trade.swapUsd),
    money(trade.netPnlUsd),
    trade.rMultiple.toFixed(3),
    money(trade.balanceAfter),
    utc(trade.entryTime),
    utc(trade.exitTime),
    trade.reason,
  ];
}

/** The trade list as CSV text with a header, one trade per line, CRLF line ends. */
export function tradesToCsv(trades: readonly Trade[], zone: string): string {
  const lines = [
    TRADE_CSV_COLUMNS.join(","),
    ...trades.map((trade, index) => tradeRow(trade, index, zone).map(csvCell).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}
