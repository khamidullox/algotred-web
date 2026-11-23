// Checks the calculation of the MT5 indicator tools/mt5/Rsi2IndexSignal.mq5.
//
// Part 1. `replayPlain` below is the indicator's loop (`Replay` in the .mq5)
// written again in TypeScript, line for line, with plain numbers and none of
// the engine's classes. It is compared with `replayDaily`, which drives the
// strategy's own code, on the daily files of the project: every trade, every
// price and the final state must be the same.
//
// Part 2. When the indicator has run in the terminal it writes its trades to
// Common\Files\algotred_rsi2_<symbol>.csv. If such files are there, they are
// compared with part 1 over the days both have.
//
// Nothing is run on test or holdout: only daily files are read.
// Usage: npx tsx research/check-mt5-signal.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config";
import { readSeriesInput } from "../src/data/load";
import { formatInZone } from "../src/data/time";
import type { Bar } from "../src/data/types";
import { symbolSpec } from "../src/engine/symbols";
import { replayDaily } from "../src/signals/daily-state";
import { rsi2ReversionIndexD1 } from "../src/strategies/rsi2-reversion-d1";

const RSI_PERIOD = 2;
const BUY_BELOW = 5;
const SELL_ABOVE = 95;
const TREND_PERIOD = 200;
const EXIT_PERIOD = 5;
const ATR_PERIOD = 20;
const ATR_MULTIPLE = 2;
const PRICE_UNITS = 100000000;

interface PlainTrade {
  direction: 1 | -1;
  signalTime: number;
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  exitTime: number;
  exitPrice: number;
  byStop: boolean;
  r: number;
}

interface PlainResult {
  state: "flat" | "enter" | "open" | "exit";
  direction: number;
  stopDistance: number;
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  trades: PlainTrade[];
}

/** NormalizeDouble of MQL5 for positive prices. */
const normalize = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;

/** The loop of `Replay` in tools/mt5/Rsi2IndexSignal.mq5, in the same order and with the same names. */
function replayPlain(bars: readonly Bar[], count: number, digits: number): PlainResult {
  const trades: PlainTrade[] = [];
  let held = false;
  let heldDirection: 1 | -1 = 1;
  let heldSignal = 0, heldEntryTime = 0, heldEntry = 0, heldStop = 0;
  let pending: "none" | "entry" | "exit" = "none";
  let pendingDirection: 1 | -1 = 1;
  let pendingDistance = 0, pendingSignal = 0;
  let gainSum = 0, lossSum = 0, gain = 0, loss = 0, rsi = 0, rsiCount = 0, rsiReady = false;
  let rangeSum = 0, atr = 0, atrCount = 0, atrReady = false;
  let trendSum = 0, exitSum = 0, trendSma = 0, exitSma = 0, trendReady = false, exitReady = false;

  const addTrade = (exitTime: number, exitPrice: number, byStop: boolean): void => {
    const distance = heldDirection * (heldEntry - heldStop);
    trades.push({
      direction: heldDirection,
      signalTime: heldSignal,
      entryTime: heldEntryTime,
      entryPrice: heldEntry,
      stopLoss: heldStop,
      exitTime,
      exitPrice,
      byStop,
      r: (heldDirection * (exitPrice - heldEntry)) / distance,
    });
  };

  for (let i = 0; i < count; i++) {
    const { open, high, low, close, time } = bars[i] as Bar;

    // the open of the day
    if (pending === "entry" && !held) {
      const stop = normalize(open - pendingDirection * pendingDistance, digits);
      if (pendingDirection * (open - stop) > 0) {
        held = true;
        heldDirection = pendingDirection;
        heldSignal = pendingSignal;
        heldEntryTime = time;
        heldEntry = open;
        heldStop = stop;
      }
    } else if (pending === "exit" && held) {
      addTrade(time, open, false);
      held = false;
    }
    pending = "none";

    // inside the day
    if (held) {
      if (heldDirection > 0 && low <= heldStop) {
        addTrade(time, Math.min(open, heldStop), true);
        held = false;
      } else if (heldDirection < 0 && high >= heldStop) {
        addTrade(time, Math.max(open, heldStop), true);
        held = false;
      }
    }

    // the close of the day: the indicators
    if (i > 0) {
      const previous = (bars[i - 1] as Bar).close;
      const change = close - previous;
      const up = change > 0 ? change : 0;
      const down = change < 0 ? -change : 0;
      if (rsiCount < RSI_PERIOD) {
        gainSum += up;
        lossSum += down;
        rsiCount++;
        if (rsiCount === RSI_PERIOD) {
          gain = gainSum / RSI_PERIOD;
          loss = lossSum / RSI_PERIOD;
        }
      } else {
        gain = (gain * (RSI_PERIOD - 1) + up) / RSI_PERIOD;
        loss = (loss * (RSI_PERIOD - 1) + down) / RSI_PERIOD;
      }
      rsiReady = rsiCount === RSI_PERIOD;
      if (rsiReady) rsi = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);

      const range = Math.max(high - low, Math.max(Math.abs(high - previous), Math.abs(low - previous)));
      if (atrCount < ATR_PERIOD) {
        rangeSum += range;
        atrCount++;
        if (atrCount === ATR_PERIOD) atr = rangeSum / ATR_PERIOD;
      } else {
        atr = (atr * (ATR_PERIOD - 1) + range) / ATR_PERIOD;
      }
      atrReady = atrCount === ATR_PERIOD;
    }

    trendSum += Math.round(close * PRICE_UNITS);
    if (i >= TREND_PERIOD) trendSum -= Math.round((bars[i - TREND_PERIOD] as Bar).close * PRICE_UNITS);
    trendReady = i >= TREND_PERIOD - 1;
    if (trendReady) trendSma = trendSum / (TREND_PERIOD * PRICE_UNITS);

    exitSum += Math.round(close * PRICE_UNITS);
    if (i >= EXIT_PERIOD) exitSum -= Math.round((bars[i - EXIT_PERIOD] as Bar).close * PRICE_UNITS);
    exitReady = i >= EXIT_PERIOD - 1;
    if (exitReady) exitSma = exitSum / (EXIT_PERIOD * PRICE_UNITS);

    // the close of the day: the rule
    if (held) {
      if (exitReady && (heldDirection > 0 ? close > exitSma : close < exitSma)) pending = "exit";
    } else if (atrReady && rsiReady && trendReady) {
      const buy = close > trendSma && rsi < BUY_BELOW;
      const sell = close < trendSma && rsi > SELL_ABOVE;
      if (buy || sell) {
        pending = "entry";
        pendingDirection = buy ? 1 : -1;
        pendingDistance = ATR_MULTIPLE * atr;
        pendingSignal = time;
      }
    }
  }

  const position = { entryTime: held ? heldEntryTime : 0, entryPrice: held ? heldEntry : 0, stopLoss: held ? heldStop : 0 };
  if (pending === "entry") {
    return { state: "enter", direction: pendingDirection, stopDistance: pendingDistance, ...position, trades };
  }
  if (pending === "exit" && held) return { state: "exit", direction: heldDirection, stopDistance: 0, ...position, trades };
  if (held) return { state: "open", direction: heldDirection, stopDistance: 0, ...position, trades };
  return { state: "flat", direction: 0, stopDistance: 0, ...position, trades };
}

const config = loadConfig();
const zone = config.brokerTimeZone;
const day = (ms: number): string => formatInZone(ms, zone, "yyyy.LL.dd");
const side = (direction: number): string => (direction > 0 ? "BUY" : "SELL");
let failed = false;

// ---- Part 1: the plain loop against the strategy's own code -------------
console.log("Part 1. The indicator's loop against the strategy's own code, on the project's daily files");
const plainBySymbol = new Map<string, { bars: readonly Bar[]; digits: number; result: PlainResult }>();
for (const symbol of rsi2ReversionIndexD1.symbols ?? []) {
  const input = readSeriesInput(config, { symbol, timeframe: "D1" });
  if (input.parsed === null) throw new Error(`${input.file}: no data`);
  const bars = input.parsed.bars;
  const spec = symbolSpec(config, symbol);
  const own = replayDaily(rsi2ReversionIndexD1, symbol, spec, zone, bars);
  const plain = replayPlain(bars, bars.length, spec.digits);
  plainBySymbol.set(symbol, { bars, digits: spec.digits, result: plain });

  const differences: string[] = [];
  if (own.trades.length !== plain.trades.length) differences.push(`trades ${own.trades.length} against ${plain.trades.length}`);
  for (let i = 0; i < Math.min(own.trades.length, plain.trades.length); i++) {
    const a = own.trades[i]!;
    const b = plain.trades[i]!;
    const same =
      a.direction === side(b.direction) &&
      a.entryTime === b.entryTime &&
      a.entryPrice === b.entryPrice &&
      a.stopLoss === b.stopLoss &&
      a.exitTime === b.exitTime &&
      a.exitPrice === b.exitPrice &&
      (a.exitReason === "stop") === b.byStop &&
      a.r === b.r;
    if (!same) differences.push(`trade ${i + 1}, entry ${day(a.entryTime)} against ${day(b.entryTime)}`);
  }
  const state = own.state;
  const stateSame =
    state.kind === plain.state &&
    (state.kind !== "enter" || (state.direction === side(plain.direction) && state.stopDistance === plain.stopDistance)) &&
    ((state.kind !== "open" && state.kind !== "exit") ||
      (state.position.direction === side(plain.direction) &&
        state.position.entryTime === plain.entryTime &&
        state.position.entryPrice === plain.entryPrice &&
        state.position.stopLoss === plain.stopLoss));
  if (!stateSame) differences.push(`state ${state.kind} against ${plain.state}`);
  if (differences.length > 0) failed = true;
  const last = bars.at(-1);
  console.log(
    `  ${symbol}: ${bars.length} days to ${last === undefined ? "-" : day(last.time)}, trades ${own.trades.length} and ${plain.trades.length}, ` +
      `state ${state.kind} and ${plain.state}: ${differences.length === 0 ? "identical" : "DIFFERENT"}`,
  );
  for (const line of differences.slice(0, 10)) console.log("    " + line);
}

// ---- Part 2: what the indicator wrote in the terminal -------------------
console.log("Part 2. The files the indicator wrote in the terminal");
const commonFiles = path.join(process.env.APPDATA ?? "", "MetaQuotes", "Terminal", "Common", "Files");
let found = 0;
for (const [symbol, mine] of plainBySymbol) {
  const file = path.join(commonFiles, `algotred_rsi2_${symbol.replace(/[^0-9A-Za-z]/g, "_")}.csv`);
  if (!existsSync(file)) continue;
  found++;
  const lines = readFileSync(file, "latin1").split(/\r?\n/).filter((line) => line !== "");
  const head = (lines[0] ?? "").split("\t");
  const field = (name: string): string => head[head.indexOf(name) + 1] ?? "";
  const rows = lines.slice(2).map((line) => line.split("\t"));
  const lastOwn = mine.bars.at(-1);
  const lastDay = lastOwn === undefined ? "" : day(lastOwn.time);
  const firstDay = field("first");
  // Wilder's averages need time to forget where the history starts.
  const from = mine.bars.find((bar) => day(bar.time) >= firstDay);
  const fromIndex = from === undefined ? mine.bars.length : mine.bars.indexOf(from) + TREND_PERIOD + 30;
  const fromDay = fromIndex < mine.bars.length ? day((mine.bars[fromIndex] as Bar).time) : "9999";
  const price = (value: number): string => value.toFixed(mine.digits);
  const key = (parts: readonly string[]): string => parts.join(" ");
  const theirs = new Map(
    rows.filter((row) => (row[2] ?? "") >= fromDay && (row[5] ?? "") <= lastDay).map((row) => [key([row[0] ?? "", row[2] ?? ""]), row]),
  );
  const ours = mine.result.trades.filter((trade) => day(trade.entryTime) >= fromDay);
  let same = 0;
  const odd: string[] = [];
  for (const trade of ours) {
    const id = key([side(trade.direction), day(trade.entryTime)]);
    const row = theirs.get(id);
    if (row === undefined) {
      odd.push(`${id}: only in the project's calculation`);
      continue;
    }
    theirs.delete(id);
    const expected = [price(trade.entryPrice), price(trade.stopLoss), day(trade.exitTime), price(trade.exitPrice), trade.byStop ? "stop" : "strategy"];
    const got = [row[3], row[4], row[5], row[6], row[7]];
    if (expected.join("|") === got.join("|")) same++;
    else odd.push(`${id}: ${got.join(" ")} in the terminal, ${expected.join(" ")} in the project`);
  }
  for (const id of theirs.keys()) odd.push(`${id}: only in the terminal`);
  if (odd.length > 0) failed = true;
  console.log(
    `  ${symbol}: terminal history from ${firstDay} to ${field("last")} (${field("bars")} days), compared from ${fromDay} to ${lastDay}: ` +
      `${same} of ${ours.length} trades identical, ${odd.length} different`,
  );
  for (const line of odd.slice(0, 15)) console.log("    " + line);
}
if (found === 0) console.log(`  no files yet in ${commonFiles}: the indicator has not run in the terminal`);
process.exitCode = failed ? 1 : 0;
