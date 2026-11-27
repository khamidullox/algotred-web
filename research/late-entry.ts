// How much does the confirmed rule Rsi2ReversionIndexD1 lose when its orders
// are placed some hours after the daily open instead of at the open (TZ 17.48)?
//
// The rule's own code decides everything at the close of a daily bar, as in
// the engine. A wrapper only holds the order back: it is released at the first
// hourly close at or after the chosen server-time hour of the day the order
// would have been filled in, and the engine fills it at the next hourly open.
// The stop stays 2 x ATR(20) from the actual fill; a stop already resting at
// the broker is not delayed.
//
// dev only, and only from 2016-09-01: before 2016 the hourly files of the
// indices hold one bar a day (TZ 17.13). The hours are fixed here before the
// run; none is picked afterwards for giving the best number.
// Usage: npx tsx research/late-entry.ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Strategy, StrategyAction, Trade } from "../src/engine/types";
import { rsi2ReversionIndexD1, serverInstant } from "../src/strategies/rsi2-reversion-d1";
import { loadStand } from "./lib";

/** Real hourly bars of all three indices start by this date (the same date as Rsi2ReversionIndexH1, TZ 17.13). */
const TRADE_FROM = "2016-09-01T00:00";
/** Server-time hours of the day at which the delayed order is placed. The daily open is at 01:00. */
const HOURS = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23] as const;
type Mode = "both" | "entry" | "exit";
const HOUR_MS = 3_600_000;

/**
 * The confirmed rule with its orders held back until `hour` (server time) of
 * the day they would have been filled in. `hour` null is the rule as it is:
 * every order goes out at the daily close and fills at the next open.
 */
function late(hour: number | null, mode: Mode): Strategy {
  const inner = rsi2ReversionIndexD1;
  return {
    ...inner,
    name: hour === null ? "Rsi2AtOpen" : `Rsi2Late${hour}-${mode}`,
    create: (symbol) => {
      const own = inner.create(symbol);
      let tradeFrom: number | null = null;
      // The order waiting for its hour: `after` is the daily close that gave it,
      // `dayStart` the server midnight of the first bar that opened after it.
      let held: { action: StrategyAction; after: number; dayStart: number | null } | null = null;
      return {
        onBarClose(ctx) {
          // The rule looks only at daily closes and returns null on every other bar.
          const fresh = own.onBarClose(ctx);
          if (ctx.justClosed("D1")) {
            // An order not placed during its day is dropped: the next daily close decides anew.
            held = null;
            if (fresh === null || fresh.kind === "cancel") return null;
            tradeFrom ??= serverInstant(TRADE_FROM, ctx.zone);
            if (fresh.kind === "entry" && ctx.now < tradeFrom) return null;
            const delayed = hour !== null && (mode === "both" || mode === fresh.kind);
            if (!delayed) return fresh;
            held = { action: fresh, after: ctx.now, dayStart: null };
            return null;
          }
          if (held === null || hour === null) return null;
          // The bar that has just closed: once one has opened after the signal, its day is the order's day.
          const opened = ctx.bars("H1").last()?.time;
          if (opened === undefined) return null;
          if (held.dayStart === null && opened >= held.after) {
            held.dayStart = DateTime.fromMillis(opened, { zone: ctx.zone }).startOf("day").toMillis();
          }
          if (held.dayStart === null || ctx.now < held.dayStart + hour * HOUR_MS) return null;
          const { action } = held;
          held = null;
          return action;
        },
      };
    },
  };
}

const stand = loadStand();
const run = (strategy: Strategy): BacktestResult =>
  runBacktest({ data: stand.data, strategy, span: stand.span, config: stand.config, news: stand.news, options: { costMultiplier: 1 } });

const mean = (values: readonly number[]): number => (values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length);
const deviation = (values: readonly number[]): number => {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, values.length - 1));
};
const signed = (value: number, digits = 3): string => (Number.isNaN(value) ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`);
const zone = stand.config.brokerTimeZone;
const clock = (ms: number): string => DateTime.fromMillis(ms, { zone }).toFormat("HH:mm");
// The same signal traded at the open and late: the same instrument and the same server day of entry.
// (The engine's signalTime will not do: it is the moment the order went out, which the delay moves.)
const keyOf = (trade: Trade): string => `${trade.symbol} ${DateTime.fromMillis(trade.entryTime, { zone }).toFormat("yyyy-LL-dd")}`;

// ---- The rule as it is, and the check that the wrapper changes nothing ----
const base = run(late(null, "both"));
const baseByKey = new Map(base.trades.map((trade) => [keyOf(trade), trade]));
{
  const dir = path.join(stand.config.reportsDir, "dev");
  const name = readdirSync(dir).filter((item) => item.endsWith("_Rsi2ReversionIndexD1")).sort().at(-1);
  if (name === undefined) throw new Error("no saved dev run of Rsi2ReversionIndexD1");
  const saved = (JSON.parse(readFileSync(path.join(dir, name, "run.json"), "utf8")) as BacktestResult).trades;
  const from = serverInstant(TRADE_FROM, zone);
  // A trade the saved run was still holding on 2016-09-01 can block a signal the wrapper is free to take.
  const later = saved.filter((trade) => trade.signalTime >= from);
  const same = later.filter((trade) => {
    const own = baseByKey.get(keyOf(trade));
    return own !== undefined && own.entryTime === trade.entryTime && own.exitTime === trade.exitTime && Math.abs(own.rMultiple - trade.rMultiple) < 1e-9;
  }).length;
  console.log(`Check: the saved dev run has ${later.length} trades signalled from ${TRADE_FROM}; the wrapper at the open gives ${base.trades.length}, identical to the saved ones: ${same}`);
}

const rs = base.trades.map((trade) => trade.rMultiple);
console.log(`\nAt the open (the rule as it is), dev from ${TRADE_FROM}: ${rs.length} trades, mean R ${signed(mean(rs))} after costs, ` +
  `sum ${signed(rs.reduce((a, b) => a + b, 0), 1)} R, entries at ${[...new Set(base.trades.map((trade) => clock(trade.entryTime)))].sort().join(", ")} server time`);

const lotSkips = (result: BacktestResult): number => result.skipped.filter((skip) => skip.reason === "lot-too-small").length;
console.log(`Signals the open dropped because 0.01 lot risked too much: ${lotSkips(base)}`);

// ---- The delayed variants --------------------------------------------------
/** A few pairs of one variant are printed in full, to read the mechanics off them. */
const SAMPLE_HOUR = 5;
const samples: { late: Trade; open: Trade }[] = [];

function show(mode: Mode, title: string): void {
  console.log(`\n${title}`);
  console.log("hour   trades  mean R   sum R   win %  | paired with the open: n   diff R    se     t   moved R | only late / only open | lot skips | fills at");
  for (const hour of HOURS) {
    const result = run(late(hour, mode));
    const own = result.trades.map((trade) => trade.rMultiple);
    const matched = result.trades.flatMap((trade) => {
      const other = baseByKey.get(keyOf(trade));
      return other === undefined ? [] : [{ late: trade, open: other }];
    });
    const pairs = matched.map((pair) => pair.late.rMultiple - pair.open.rMultiple);
    // How far the price had gone the trade's way by the late fill, in units of the stop: what the late entry paid more.
    const moved = mean(matched.map((pair) => ((pair.late.direction === "BUY" ? 1 : -1) * (pair.late.entryPrice - pair.open.entryPrice)) / pair.open.stopDistance));
    const keys = new Set(result.trades.map(keyOf));
    const onlyOpen = base.trades.filter((trade) => !keys.has(keyOf(trade))).length;
    const diff = mean(pairs);
    const se = deviation(pairs) / Math.sqrt(Math.max(1, pairs.length));
    if (mode === "both" && hour === SAMPLE_HOUR) samples.push(...matched.slice(0, 6));
    const fills = mode === "exit" ? result.trades.filter((trade) => trade.exitReason === "strategy").map((trade) => clock(trade.exitTime)) : result.trades.map((trade) => clock(trade.entryTime));
    const counts = new Map<string, number>();
    for (const item of fills) counts.set(item, (counts.get(item) ?? 0) + 1);
    const usual = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([at, n]) => `${at} x${n}`).join(", ");
    console.log(
      `${String(hour).padStart(2, "0")}:00  ${String(own.length).padStart(5)}  ${signed(mean(own))}  ${signed(own.reduce((a, b) => a + b, 0), 1).padStart(6)}  ` +
        `${((100 * result.trades.filter((trade) => trade.netPnlUsd > 0).length) / Math.max(1, own.length)).toFixed(1).padStart(5)}  | ` +
        `${String(pairs.length).padStart(22)}  ${signed(diff)}  ${se.toFixed(3)}  ${signed(diff / se, 1).padStart(5)}  ${signed(moved)} | ` +
        `${String(result.trades.length - pairs.length).padStart(9)} / ${String(onlyOpen).padEnd(9)} | ${String(lotSkips(result)).padStart(9)} | ${usual}`,
    );
  }
}

show("both", "Entries and exits both placed at the hour (what a person who looks once a day does)");
show("entry", "Only entries placed at the hour, exits at the open");
show("exit", "Only exits placed at the hour, entries at the open");

console.log(`\nThe first pairs of the ${String(SAMPLE_HOUR).padStart(2, "0")}:00 variant, both orders late (open | late)`);
const stamp = (ms: number): string => DateTime.fromMillis(ms, { zone }).toFormat("yyyy-LL-dd HH:mm");
for (const { late: own, open } of samples) {
  const digits = 2;
  const one = (trade: Trade): string =>
    `in ${stamp(trade.entryTime)} at ${trade.entryPrice.toFixed(digits)}, stop ${trade.stopLoss.toFixed(digits)} (${trade.stopDistance.toFixed(digits)} away), ` +
    `out ${stamp(trade.exitTime)} at ${trade.exitPrice.toFixed(digits)} by ${trade.exitReason}, R ${signed(trade.rMultiple)}`;
  console.log(`  ${own.symbol} ${own.direction}\n    open: ${one(open)}\n    late: ${one(own)}`);
}
