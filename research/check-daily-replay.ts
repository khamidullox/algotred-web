// How close is the daily replay behind the "Signals" page to the engine?
// Replays Rsi2ReversionIndexD1 over the daily files and compares its trades
// with the saved engine runs on dev, test and holdout. Nothing is re-run on
// test or holdout: the saved run.json files are read.
// Usage: npx tsx research/check-daily-replay.ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config";
import { readSeriesInput } from "../src/data/load";
import { formatInZone, nextZoneDay } from "../src/data/time";
import { symbolSpec } from "../src/engine/symbols";
import type { BacktestResult } from "../src/engine/types";
import { replayDaily } from "../src/signals/daily-state";
import { rsi2ReversionIndexD1 } from "../src/strategies/rsi2-reversion-d1";

const config = loadConfig();
const zone = config.brokerTimeZone;
const runOf = (dataset: string): BacktestResult => {
  const dir = path.join(config.reportsDir, dataset);
  const name = readdirSync(dir).filter((item) => item.endsWith("_Rsi2ReversionIndexD1")).sort().at(-1);
  if (name === undefined) throw new Error(`no saved run of Rsi2ReversionIndexD1 on ${dataset}`);
  return JSON.parse(readFileSync(path.join(dir, name, "run.json"), "utf8")) as BacktestResult;
};
const runs = ["dev", "test", "holdout"].map(runOf);
const start = (runs[0] as BacktestResult).span.start;
const end = (runs[2] as BacktestResult).span.end;
const date = (ms: number): string => formatInZone(ms, zone, "yyyy-LL-dd");

let matched = 0, engineTotal = 0, sameExit = 0, replayOnly = 0, explainedByLot = 0, atBoundary = 0;
const odd: string[] = [];
for (const symbol of rsi2ReversionIndexD1.symbols ?? []) {
  const input = readSeriesInput(config, { symbol, timeframe: "D1" });
  if (input.parsed === null) throw new Error(`${input.file}: no data`);
  // What the engine sees: the common period of the data, nothing before it.
  const bars = input.parsed.bars.filter((bar) => bar.time >= start && bar.time < end);
  const replay = replayDaily(rsi2ReversionIndexD1, symbol, symbolSpec(config, symbol), zone, bars);
  const mine = new Map(replay.trades.map((trade) => [`${date(trade.entryTime)} ${trade.direction}`, trade]));
  const engineTrades = runs.flatMap((run) => run.trades.filter((trade) => trade.symbol === symbol));
  // A signal the engine dropped because 0.01 lot risked too much: the replay, which has no lot, trades it.
  const lotSkips = new Set(
    runs.flatMap((run) => run.skipped.filter((skip) => skip.symbol === symbol && skip.reason === "lot-too-small")).map((skip) => {
      // The day the signal moment falls into; in weeks when the session ends an hour early the engine
      // sees the daily close an hour into the next day.
      const entry = bars.find((bar) => nextZoneDay(bar.time, zone) > skip.signalTime);
      return entry === undefined ? "" : `${date(entry.time)} ${skip.direction}`;
    }),
  );
  const seen = new Set<string>();
  for (const trade of engineTrades) {
    engineTotal++;
    const key = `${date(trade.entryTime)} ${trade.direction}`;
    seen.add(key);
    const own = mine.get(key);
    if (own === undefined) { odd.push(`${symbol} ${key}: in the engine only (${trade.exitReason})`); continue; }
    matched++;
    const engineExit = trade.exitReason === "end-of-data" ? "end-of-data" : `${date(trade.exitTime)} ${trade.exitReason}`;
    if (engineExit === `${date(own.exitTime)} ${own.exitReason}`) sameExit++;
    else odd.push(`${symbol} ${key}: exit ${engineExit} in the engine, ${date(own.exitTime)} ${own.exitReason} in the replay`);
  }
  for (const [key, trade] of mine) {
    if (seen.has(key)) continue;
    replayOnly++;
    if (lotSkips.has(key)) { explainedByLot++; continue; }
    // A dataset ends with every position closed, so the first days of the next one can differ.
    const nearBoundary = runs.slice(1).some((run) => Math.abs(trade.entryTime - run.span.start) < 15 * 86_400_000);
    if (nearBoundary) { atBoundary++; continue; }
    odd.push(`${symbol} ${key}: in the replay only`);
  }
  console.log(`${symbol}: daily bars ${bars.length}, replay trades ${replay.trades.length}, engine trades ${engineTrades.length}, engine lot skips ${lotSkips.size}; now ${replay.state.kind}`);
}
console.log(`engine trades ${engineTotal}: found in the replay ${matched}, with the same exit day and reason ${sameExit}`);
console.log(`replay trades the engine did not make: ${replayOnly} (lot too small in the engine ${explainedByLot}, at a dataset boundary ${atBoundary}, other ${replayOnly - explainedByLot - atBoundary})`);
for (const line of odd.slice(0, 30)) console.log("  " + line);
