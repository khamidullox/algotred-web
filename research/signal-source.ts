// Can the signal of Rsi2ReversionIndexD1 be computed without the terminal,
// from exchange daily prices (TZ 17.50)? The same rule is replayed by the same
// code over the broker's daily bars and over the exchange's daily prices, and
// the two sequences of signals are compared. Only agreement is measured: no
// result of any trade is counted, on any dataset.
//
// The exchange files are those of research/fetch-yahoo.mjs (data/raw/research-yahoo).
// Usage: npx tsx research/signal-source.ts [futures]
// Without an argument the exchange indices are used (SPXCASH and so on); with
// "futures" the front futures contracts (SPXFUT and so on), whose daily bar
// ends when the broker's does.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config";
import { decodeMt5File, parseMt5Csv } from "../src/data/mt5-csv";
import { createServerTimeConverter, formatInZone } from "../src/data/time";
import type { Bar } from "../src/data/types";
import type { SymbolSpec } from "../src/engine/symbols";
import { replayDaily, type DailyTrade } from "../src/signals/daily-state";
import { rsiWilder } from "../src/indicators/rsi";
import { sma } from "../src/indicators/sma";
import { RSI2_REVERSION, rsi2ReversionIndexD1 } from "../src/strategies/rsi2-reversion-d1";

const config = loadConfig();
const zone = config.brokerTimeZone;
const toUtc = createServerTimeConverter(zone);
const day = (ms: number): string => formatInZone(ms, zone, "yyyy-LL-dd");
const EXCHANGE = "data/raw/research-yahoo";
// "futures17": daily bars built from hourly futures bars, ending at 17:00 New York like the broker's (step 3).
const SOURCE = process.argv[2] === "futures" ? "FUT" : process.argv[2] === "futures17" ? "FUT17" : "CASH";
/** The rule needs 200 daily closes; compared trades start a little after that. */
const WARM_UP_BARS = 230;

/** Broker instrument, its daily file in the data folder, and the exchange index. */
const PAIRS = [
  { name: "S&P 500", broker: /^US500_D1\.csv$/, exchange: `SPX${SOURCE}` },
  { name: "Russell 2000", broker: /^US2000_D1\.csv$/, exchange: `RUT${SOURCE}` },
  { name: "Dow Jones", broker: /^US30_D1\.csv$/, exchange: `DJI${SOURCE}` },
  // Not in the strategy's own list (TZ 17.18); the broker's history starts in June 2020.
  { name: "Nasdaq 100", broker: /^USTECH100M_Daily_\d+_\d+\.csv$/, exchange: `NDX${SOURCE}` },
] as const;

function daily(file: string): Bar[] {
  return parseMt5Csv(decodeMt5File(readFileSync(file)), { timeframe: "D1", toUtc }).bars;
}

function brokerFile(pattern: RegExp): string {
  const name = readdirSync(config.dataDir).find((item) => pattern.test(item));
  if (name === undefined) throw new Error(`no file like ${pattern} in ${config.dataDir}`);
  return path.join(config.dataDir, name);
}

const spec = (symbol: string): SymbolSpec => ({ symbol, digits: 2, point: 0.01, pip: 0.1, contractSize: 10, usdSide: "quote" });
const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? Number.NaN;
const pct = (part: number, whole: number): string => (whole === 0 ? "n/a" : `${((100 * part) / whole).toFixed(1)}%`);
const keyOf = (trade: DailyTrade): string => `${trade.direction} ${day(trade.entryTime)}`;
const datasetOf = (date: string): string => (date < (config.datasets?.testStart ?? "9999") ? "dev" : date < (config.datasets?.holdoutStart ?? "9999") ? "test" : "holdout");

interface Tally {
  broker: number;
  exchange: number;
  same: number;
  near: number;
  sameExit: number;
  days: number;
  daysSame: number;
  ratios: number[];
  conditionBoth: number;
  conditionOwn: number;
  conditionOther: number;
}
const total: Tally = { broker: 0, exchange: 0, same: 0, near: 0, sameExit: 0, days: 0, daysSame: 0, ratios: [], conditionBoth: 0, conditionOwn: 0, conditionOther: 0 };
const byDataset = new Map<string, { broker: number; same: number }>();

console.log("index          broker  exchange  same day  +/-1 day | terminal's signals named | messages that match | same exit day | days in the same state | stop distance, exchange / broker: median (5%..95%)");
for (const pair of PAIRS) {
  const own = daily(brokerFile(pair.broker));
  const lastDay = own.at(-1)?.time ?? 0;
  // The exchange history goes on after the broker's file ends: nothing past it is looked at.
  const other = daily(path.join(EXCHANGE, `${pair.exchange}_D1.csv`)).filter((bar) => bar.time <= lastDay);
  // Compared from the day both series have warmed their indicators up.
  const from = Math.max(own[WARM_UP_BARS]?.time ?? Number.POSITIVE_INFINITY, other[WARM_UP_BARS]?.time ?? Number.POSITIVE_INFINITY);
  const mine = replayDaily(rsi2ReversionIndexD1, pair.exchange, spec(pair.exchange), zone, own).trades.filter((trade) => trade.entryTime >= from);
  const theirs = replayDaily(rsi2ReversionIndexD1, pair.exchange, spec(pair.exchange), zone, other).trades.filter((trade) => trade.entryTime >= from);

  const theirsByKey = new Map(theirs.map((trade) => [keyOf(trade), trade]));
  const dates = own.map((bar) => day(bar.time));
  const neighbours = (trade: DailyTrade): string[] => {
    const at = dates.indexOf(day(trade.entryTime));
    return [dates[at - 1], dates[at + 1]].filter((item): item is string => item !== undefined).map((item) => `${trade.direction} ${item}`);
  };
  let same = 0, near = 0, sameExit = 0;
  const ratios: number[] = [];
  for (const trade of mine) {
    const match = theirsByKey.get(keyOf(trade));
    const set = byDataset.get(datasetOf(day(trade.entryTime))) ?? { broker: 0, same: 0 };
    set.broker++;
    if (match !== undefined) {
      same++;
      set.same++;
      if (day(match.exitTime) === day(trade.exitTime)) sameExit++;
      ratios.push(Math.abs(match.entryPrice - match.stopLoss) / Math.abs(trade.entryPrice - trade.stopLoss));
    } else if (neighbours(trade).some((key) => theirsByKey.has(key))) {
      near++;
    }
    byDataset.set(datasetOf(day(trade.entryTime)), set);
  }

  // A position is held at the close of a day from its entry day until the day before its exit.
  const held = (trades: readonly DailyTrade[]): Set<string> => {
    const set = new Set<string>();
    for (const trade of trades) for (const date of dates) if (date >= day(trade.entryTime) && date < day(trade.exitTime)) set.add(date);
    return set;
  };
  const heldMine = held(mine);
  const heldTheirs = held(theirs);
  const compared = dates.filter((date) => date >= day(from));
  const daysSame = compared.filter((date) => heldMine.has(date) === heldTheirs.has(date)).length;

  ratios.sort((a, b) => a - b);
  console.log(
    `${pair.name.padEnd(13)} ${String(mine.length).padStart(6)}  ${String(theirs.length).padStart(8)}  ${String(same).padStart(8)}  ${String(near).padStart(8)} | ` +
      `${pct(same, mine.length).padStart(24)} | ${pct(same, theirs.length).padStart(19)} | ${pct(sameExit, same).padStart(13)} | ${pct(daysSame, compared.length).padStart(22)} | ` +
      `${quantile(ratios, 0.5).toFixed(2)} (${quantile(ratios, 0.05).toFixed(2)}..${quantile(ratios, 0.95).toFixed(2)})`,
  );
  // How far apart the two closes are, and on which days the entry condition holds in each series.
  const indexOf = new Map(other.map((bar, index) => [day(bar.time), index]));
  const closes = (bars: readonly Bar[]): number[] => bars.map((bar) => bar.close);
  const rsiOwn = rsiWilder(closes(own), RSI2_REVERSION.rsiPeriod);
  const rsiOther = rsiWilder(closes(other), RSI2_REVERSION.rsiPeriod);
  const trendOwn = sma(closes(own), RSI2_REVERSION.trendSmaPeriod);
  const trendOther = sma(closes(other), RSI2_REVERSION.trendSmaPeriod);
  const asks = (close: number, trend: number, rsi: number): boolean =>
    (close > trend && rsi < RSI2_REVERSION.buyBelowRsi) || (close < trend && rsi > RSI2_REVERSION.sellAboveRsi);
  const gaps: number[] = [];
  let both = 0, onlyOwn = 0, onlyOther = 0;
  for (let i = 1; i < own.length; i++) {
    const bar = own[i] as Bar;
    const j = indexOf.get(day(bar.time));
    if (bar.time < from || j === undefined || j < 1) continue;
    const there = other[j] as Bar;
    // The day's change is compared only when both series count it from the same previous day.
    if (day((own[i - 1] as Bar).time) === day((other[j - 1] as Bar).time)) {
      gaps.push(Math.abs(bar.close / (own[i - 1] as Bar).close - there.close / (other[j - 1] as Bar).close));
    }
    const here = asks(bar.close, trendOwn[i] as number, rsiOwn[i] as number);
    const also = asks(there.close, trendOther[j] as number, rsiOther[j] as number);
    if (here && also) both++;
    else if (here) onlyOwn++;
    else if (also) onlyOther++;
  }
  gaps.sort((a, b) => a - b);
  console.log(
    `${"".padEnd(13)} closes: the day's change differs by ${(100 * quantile(gaps, 0.5)).toFixed(2)}% in the middle, ${(100 * quantile(gaps, 0.9)).toFixed(2)}% at the 90th percentile (${gaps.length} days); ` +
      `entry condition on the same day ${both}, broker only ${onlyOwn}, source only ${onlyOther} (${pct(both, both + onlyOwn)} of the broker's)`,
  );
  total.conditionBoth += both;
  total.conditionOwn += onlyOwn;
  total.conditionOther += onlyOther;
  total.broker += mine.length;
  total.exchange += theirs.length;
  total.same += same;
  total.near += near;
  total.sameExit += sameExit;
  total.days += compared.length;
  total.daysSame += daysSame;
  total.ratios.push(...ratios);
}
total.ratios.sort((a, b) => a - b);
console.log(
  `${"All four".padEnd(13)} ${String(total.broker).padStart(6)}  ${String(total.exchange).padStart(8)}  ${String(total.same).padStart(8)}  ${String(total.near).padStart(8)} | ` +
    `${pct(total.same, total.broker).padStart(24)} | ${pct(total.same, total.exchange).padStart(19)} | ${pct(total.sameExit, total.same).padStart(13)} | ${pct(total.daysSame, total.days).padStart(22)} | ` +
    `${quantile(total.ratios, 0.5).toFixed(2)} (${quantile(total.ratios, 0.05).toFixed(2)}..${quantile(total.ratios, 0.95).toFixed(2)})`,
);
console.log(
  `Entry condition over all four: on the same day ${total.conditionBoth}, broker only ${total.conditionOwn}, source only ${total.conditionOther} ` +
    `(${pct(total.conditionBoth, total.conditionBoth + total.conditionOwn)} of the broker's days, ${pct(total.conditionBoth, total.conditionBoth + total.conditionOther)} of the source's)`,
);
console.log(`By the period of the broker's signal: ${[...byDataset.entries()].map(([name, set]) => `${name} ${set.same} of ${set.broker} (${pct(set.same, set.broker)})`).join(", ")}`);
