// What the 09:00 Tashkent order hour costs against the daily open (TZ 17.49):
// the saved run of Rsi2ReversionIndexD1At9Tashkent on a dataset is paired with
// the saved run of Rsi2ReversionIndexD1 on the same dataset. Nothing is run
// here: only run.json files are read, the latest of each name.
//
// A pair is the same instrument and the same server day of entry. The reading
// was fixed before the test run: the late rule keeps its place when its mean R
// after costs is above zero and the paired difference is not under -0.08 R.
// Usage: npx tsx research/late-check.ts [dev|test|holdout ...]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { loadConfig } from "../src/config";
import type { BacktestResult, Trade } from "../src/engine/types";
import { serverInstant } from "../src/strategies/rsi2-reversion-d1";

const OPEN = "Rsi2ReversionIndexD1";
const LATE = "Rsi2ReversionIndexD1At9Tashkent";
/** The late rule takes no entry before this server-time date: its pairs start here. */
const TRADE_FROM = "2016-09-01T00:00";
/** TZ 17.48: a loss of more than this much R a trade is large, half the edge of the rule. */
const LARGE_LOSS = 0.08;

const config = loadConfig();
const zone = config.brokerTimeZone;
const datasets = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["dev", "test", "holdout"];

const mean = (values: readonly number[]): number => (values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length);
const deviation = (values: readonly number[]): number => {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, values.length - 1));
};
const signed = (value: number, digits = 3): string => (Number.isNaN(value) ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`);
const keyOf = (trade: Trade): string => `${trade.symbol} ${DateTime.fromMillis(trade.entryTime, { zone }).toFormat("yyyy-LL-dd")}`;
const tashkent = (ms: number): string => DateTime.fromMillis(ms, { zone: "Asia/Tashkent" }).toFormat("HH:mm");

function saved(dataset: string, name: string): BacktestResult | null {
  const dir = path.join(config.reportsDir, dataset);
  if (!existsSync(dir)) return null;
  const folder = readdirSync(dir).filter((item) => item.endsWith(`_${name}`)).sort().at(-1);
  return folder === undefined ? null : (JSON.parse(readFileSync(path.join(dir, folder, "run.json"), "utf8")) as BacktestResult);
}

const pooled: number[] = [];
for (const dataset of datasets) {
  const open = saved(dataset, OPEN);
  const late = saved(dataset, LATE);
  if (open === null || late === null) {
    console.log(`${dataset}: no saved run of ${open === null ? OPEN : LATE}`);
    continue;
  }
  const from = serverInstant(TRADE_FROM, zone);
  const openTrades = open.trades.filter((trade) => trade.signalTime >= from);
  const byKey = new Map(openTrades.map((trade) => [keyOf(trade), trade]));
  const pairs = late.trades.flatMap((trade) => {
    const other = byKey.get(keyOf(trade));
    return other === undefined ? [] : [{ late: trade, open: other }];
  });
  const diffs = pairs.map((pair) => pair.late.rMultiple - pair.open.rMultiple);
  const diff = mean(diffs);
  const se = deviation(diffs) / Math.sqrt(Math.max(1, diffs.length));
  const lateR = late.trades.map((trade) => trade.rMultiple);
  const openR = openTrades.map((trade) => trade.rMultiple);
  const lateKeys = new Set(late.trades.map(keyOf));
  const bySymbol = new Map<string, number[]>();
  for (const trade of late.trades) bySymbol.set(trade.symbol, [...(bySymbol.get(trade.symbol) ?? []), trade.rMultiple]);
  const fills = new Map<string, number>();
  for (const trade of late.trades) fills.set(tashkent(trade.entryTime), (fills.get(tashkent(trade.entryTime)) ?? 0) + 1);
  if (dataset !== "dev") pooled.push(...diffs);

  console.log(`${dataset}`);
  console.log(`  at the open:      ${openR.length} trades, mean R ${signed(mean(openR))}, sum ${signed(openR.reduce((a, b) => a + b, 0), 1)} R`);
  console.log(`  at 09:00 Tashkent: ${lateR.length} trades, mean R ${signed(mean(lateR))}, sum ${signed(lateR.reduce((a, b) => a + b, 0), 1)} R, ` +
    `wins ${((100 * late.trades.filter((trade) => trade.netPnlUsd > 0).length) / Math.max(1, lateR.length)).toFixed(1)}%`);
  console.log(`  by instrument:    ${[...bySymbol.entries()].map(([symbol, list]) => `${symbol} ${list.length} trades ${signed(mean(list))}`).join("; ")}`);
  console.log(`  pairs:            ${pairs.length}; late only ${late.trades.length - pairs.length}, at the open only ${openTrades.filter((trade) => !lateKeys.has(keyOf(trade))).length}`);
  console.log(`  paired difference: ${signed(diff)} R, standard error ${se.toFixed(3)}`);
  console.log(`  entries by the Tashkent clock: ${[...fills.entries()].sort((a, b) => b[1] - a[1]).map(([at, n]) => `${at} x${n}`).join(", ")}`);
  console.log(`  reading:          mean R above zero: ${mean(lateR) > 0 ? "yes" : "NO"}; difference not under -${LARGE_LOSS}: ${diff >= -LARGE_LOSS ? "yes" : "NO"}`);
}
if (pooled.length > 0) {
  const se = deviation(pooled) / Math.sqrt(pooled.length);
  console.log(`test and holdout together: ${pooled.length} pairs, paired difference ${signed(mean(pooled))} R, standard error ${se.toFixed(3)}`);
}
