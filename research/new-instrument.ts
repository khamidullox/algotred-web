// Runs frozen strategies on instruments that no run of the project has used
// (TZ 17.18). The rules are not touched: this is a check on new markets, not
// a search. The instruments are not in config/default.json, where their
// history would move the start of `dev` for everything else; their files live
// in folders of their own and their costs are set here.
// Usage: npx tsx research/new-instrument.ts ndx|ndx-broker|ndx2|calibrate|world|shares-broker|shares-etfs|shares-dow [file for the trades of the strategy]
import { readFileSync, writeFileSync } from "node:fs";
import { loadConfig, type Config, type SymbolConfig } from "../src/config";
import { readSeriesInput } from "../src/data/load";
import { startOfZoneDay } from "../src/data/time";
import type { Bar } from "../src/data/types";
import { runBacktest, type SymbolData } from "../src/engine/backtest";
import type { BacktestResult, Strategy, Trade } from "../src/engine/types";
import { rsi2IndexControl } from "../src/strategies/rsi2-index-control";
import { rsi2ReversionIndexD1 } from "../src/strategies/rsi2-reversion-d1";
import { header, line, metricsOf } from "./lib";
import baskets from "./share-baskets.json";

interface Instrument {
  readonly symbol: string;
  readonly dataDir: string;
  readonly config: SymbolConfig;
}

/**
 * Nasdaq 100 CFD as exported from MT5 on 2026-11-18 (history from 2020-06-01,
 * prices with one decimal). Costs follow US500 in proportion to the price:
 * financing 6.4% a year long (the highest of the known FundedNext index
 * rates), the spread floor and the slippage a little above the same share of
 * the price. One lot is one index, so the 0.01-lot step never blocks a trade.
 */
const NASDAQ: Instrument = {
  symbol: "USTECH100M",
  dataDir: "data/raw/research-ndx",
  config: {
    digits: 1,
    contractSize: 1,
    usdSide: "quote",
    commissionPerLotRoundTrip: 0,
    tripleSwapDay: "friday",
    timeZoneCheck: false,
    // 0.017767% and 0.004832% of the price a night, the US500 rates, at the last close of the export.
    swapLongPips: -5.2343,
    swapShortPips: -1.4235,
    swapReferencePrice: 29460.3,
    // 2.0 index points; the file shows 0.2 to 2.1.
    minSpreadPoints: 20,
    // 1.0 index point a side.
    slippagePoints: 10,
  },
};

/**
 * The same export with the contract FundedNext gives NDX100 (help centre and
 * swap calculator, read 2026-11-18 and 2026-11-20): 10 USD a point for one
 * lot, swap -372.912 / -57.6 points a lot a night, which is -3.729 / -0.576
 * index points; the index stood near 27116 then. The spread is not published,
 * so the 2.0-point floor stays an assumption.
 */
const NASDAQ_FUNDEDNEXT: Instrument = {
  ...NASDAQ,
  config: { ...NASDAQ.config, contractSize: 10, swapLongPips: -3.72912, swapShortPips: -0.576, swapReferencePrice: 27116 },
};

/**
 * The same index from the MetaQuotes-Demo server (history from 2022-07-06, two
 * decimals): a second export to check the first against. The same cost shares.
 */
const NASDAQ_METAQUOTES: Instrument = {
  symbol: "USTEC",
  dataDir: "data/raw/research-ndx",
  config: {
    digits: 2,
    contractSize: 1,
    usdSide: "quote",
    commissionPerLotRoundTrip: 0,
    tripleSwapDay: "friday",
    timeZoneCheck: false,
    swapLongPips: -50.443,
    swapShortPips: -13.719,
    swapReferencePrice: 28391.5,
    minSpreadPoints: 200,
    slippagePoints: 100,
  },
};

const YAHOO_DIR = "data/raw/research-yahoo";

/**
 * An exchange index from Yahoo Finance (research/fetch-yahoo.mjs): daily bars
 * only, so stops are checked on the day range. Costs are a share of the last
 * close, set above the US500 shares: spread 0.015% of the price, slippage
 * 0.0035% a side, financing 6.4% a year long. One lot is one index. Results
 * are in the index currency, which does not matter for R.
 */
function exchangeIndex(symbol: string): Instrument {
  const summary = JSON.parse(readFileSync(`${YAHOO_DIR}/summary.json`, "utf8")) as { name: string; lastClose: number }[];
  const own = summary.find((item) => item.name === symbol);
  if (own === undefined) throw new Error(`${symbol} is not in ${YAHOO_DIR}/summary.json: run research/fetch-yahoo.mjs`);
  const point = 0.01;
  return {
    symbol,
    dataDir: YAHOO_DIR,
    config: {
      digits: 2,
      contractSize: 1,
      usdSide: "quote",
      commissionPerLotRoundTrip: 0,
      tripleSwapDay: "friday",
      timeZoneCheck: false,
      swapLongPips: -(0.00017767 * own.lastClose) / (10 * point),
      swapShortPips: -(0.00004832 * own.lastClose) / (10 * point),
      swapReferencePrice: own.lastClose,
      minSpreadPoints: Math.round((0.00015 * own.lastClose) / point),
      slippagePoints: Math.round((0.000035 * own.lastClose) / point),
    },
  };
}

/**
 * A US share or fund from Yahoo Finance (TZ 17.22). Its CFD trades in exchange hours only, so the next
 * daily open is the real next price. The costs of a round trip follow the price and sit in the spread
 * column of the file (0.078% in all: spread, commission, slippage); financing as for the indices,
 * 6.4% a year long. One lot is one share.
 */
function exchangeShare(ticker: string): Instrument {
  const summary = JSON.parse(readFileSync(`${YAHOO_DIR}/summary-stocks.json`, "utf8")) as { ticker: string; lastClose: number }[];
  const own = summary.find((item) => item.ticker === ticker);
  if (own === undefined) throw new Error(`${ticker} is not in ${YAHOO_DIR}/summary-stocks.json: run research/fetch-yahoo.mjs stocks`);
  const pip = 0.001;
  return {
    symbol: `ST${ticker}`,
    dataDir: YAHOO_DIR,
    config: {
      digits: 4,
      contractSize: 1,
      usdSide: "quote",
      commissionPerLotRoundTrip: 0,
      tripleSwapDay: "friday",
      timeZoneCheck: false,
      swapLongPips: -(0.00017767 * own.lastClose) / pip,
      swapShortPips: -(0.00004832 * own.lastClose) / pip,
      swapReferencePrice: own.lastClose,
      minSpreadPoints: 0,
      slippagePoints: 0,
    },
  };
}

/** The server date the dev dataset starts on: the exchange files go back to 2012, so the indicators are warm by then. */
const FROM = "2015-02-02";

function load(instruments: readonly Instrument[], from: string | null, riskPerTradePct?: number): { config: Config; data: SymbolData[]; span: { start: number; end: number } } {
  const base = loadConfig();
  const main = riskPerTradePct === undefined ? base : { ...base, riskPerTradePct };
  const zone = main.brokerTimeZone;
  const config: Config = {
    ...main,
    symbols: Object.fromEntries(instruments.map((instrument) => [instrument.symbol, instrument.config])),
    datasets: undefined,
    calendar: undefined,
  };
  let start = Number.NEGATIVE_INFINITY;
  let end = Number.POSITIVE_INFINITY;
  const all = instruments.map((instrument) => {
    const bars = {} as Record<"D1" | "H1" | "M15", readonly Bar[]>;
    for (const timeframe of ["D1", "H1", "M15"] as const) {
      const input = readSeriesInput({ ...config, dataDir: instrument.dataDir }, { symbol: instrument.symbol, timeframe });
      if (input.parsed === null) throw new Error(`${input.file}: ${input.formatError ?? "the file is missing"}`);
      bars[timeframe] = input.parsed.bars;
    }
    start = Math.max(start, startOfZoneDay((bars.D1[0] as Bar).time, zone));
    // Whole server days only: the last day of an export is usually cut short.
    end = Math.min(end, startOfZoneDay((bars.D1.at(-1) as Bar).time, zone));
    return { symbol: instrument.symbol, bars };
  });
  // History before the span warms the indicators; nothing after its end is given to the engine.
  const data = all.map(({ symbol, bars }) => {
    const cut = (list: readonly Bar[]): Bar[] => list.filter((bar) => bar.time < end);
    return { symbol, bars: { D1: cut(bars.D1), H1: cut(bars.H1), M15: cut(bars.M15) } };
  });
  const wanted = from === null ? start : startOfZoneDay(Date.parse(`${from}T12:00:00Z`), zone);
  return { config, data, span: { start: Math.max(start, wanted), end } };
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const meanR = (list: readonly Trade[]): string =>
  list.length === 0 ? "n/a" : `${(list.reduce((a, trade) => a + trade.rMultiple, 0) / list.length >= 0 ? "+" : "")}${(list.reduce((a, trade) => a + trade.rMultiple, 0) / list.length).toFixed(3)}`;

/** The three periods of the project's own datasets, by the entry time. */
function eras(result: BacktestResult): string {
  const test = Date.parse("2021-12-08T22:00:00Z");
  const holdout = Date.parse("2024-11-15T22:00:00Z");
  const of = (from: number, to: number): readonly Trade[] => result.trades.filter((trade) => trade.entryTime >= from && trade.entryTime < to);
  const part = (label: string, list: readonly Trade[]): string => `${label} ${meanR(list)} R (${list.length})`;
  return [part("to 2021-12-08", of(-Infinity, test)), part("to 2024-11-15", of(test, holdout)), part("after", of(holdout, Infinity))].join("; ");
}

function report(label: string, instruments: readonly Instrument[], from: string | null, riskPerTradePct?: number): void {
  const { config, data, span } = load(instruments, from, riskPerTradePct);
  console.log(`\n${label}: ${instruments.map((instrument) => instrument.symbol).join(", ")}; span ${day(span.start)} to ${day(span.end)} (UTC dates)`);
  console.log(header());
  const strategies: readonly Strategy[] = [rsi2ReversionIndexD1, rsi2IndexControl];
  for (const strategy of strategies) {
    const own = { ...strategy, symbols: instruments.map((instrument) => instrument.symbol) };
    for (const costMultiplier of [1, 2]) {
      const result = runBacktest({ data, strategy: own, span, config, options: { costMultiplier } });
      console.log(line(`${strategy.name}${costMultiplier === 1 ? "" : " | costs x2"}`, metricsOf(result)));
      if (costMultiplier === 1 && strategy === rsi2ReversionIndexD1 && process.argv[3] !== undefined) writeFileSync(process.argv[3], JSON.stringify(result.trades));
      if (costMultiplier === 1 && instruments.length > 4) {
        // How many instruments made money, and how many positions were open at once.
        const bySymbol = new Map<string, number[]>();
        for (const trade of result.trades) bySymbol.set(trade.symbol, [...(bySymbol.get(trade.symbol) ?? []), trade.rMultiple]);
        const positive = [...bySymbol.values()].filter((list) => list.reduce((a, b) => a + b, 0) > 0).length;
        const moments = result.trades.flatMap((trade) => [[trade.entryTime, 1], [trade.exitTime, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        let open = 0, most = 0;
        for (const [, change] of moments) { open += change; most = Math.max(most, open); }
        const daysWithEntry = new Map<number, number>();
        for (const trade of result.trades) daysWithEntry.set(trade.entryTime, (daysWithEntry.get(trade.entryTime) ?? 0) + 1);
        console.log(`  instruments in profit ${positive} of ${instruments.length} (traded ${bySymbol.size}); most positions open at once ${most}; most entries on one day ${Math.max(0, ...daysWithEntry.values())}`);
      }
      if (costMultiplier === 1) {
        const buys = result.trades.filter((trade) => trade.direction === "BUY");
        const sells = result.trades.filter((trade) => trade.direction === "SELL");
        console.log(`  buys ${buys.length} (${meanR(buys)} R), sells ${sells.length} (${meanR(sells)} R); skipped ${result.skipped.length}; ${eras(result)}`);
      }
    }
  }
}

const basket = process.argv[2];
if (basket === "ndx") {
  report("Nasdaq 100 CFD, never used before", [NASDAQ], null);
} else if (basket === "ndx-broker") {
  // How many signals the 0.01-lot step leaves on a 10,000 USD account.
  report("Nasdaq 100 with the FundedNext contract, risk 0.5% a trade", [NASDAQ_FUNDEDNEXT], null);
  report("Nasdaq 100 with the FundedNext contract, risk 1% a trade", [NASDAQ_FUNDEDNEXT], null, 1);
} else if (basket === "ndx2") {
  report("Nasdaq 100 CFD, the MetaQuotes-Demo export", [NASDAQ_METAQUOTES], null);
} else if (basket === "calibrate") {
  // The US indices from the exchange: the same rule on them is already known from the broker's files.
  report("US indices from the exchange (calibration of the proxy)", ["SPXCASH", "DJICASH", "RUTCASH", "NDXCASH"].map(exchangeIndex), FROM);
} else if (basket === "world") {
  report("Indices outside the US, from the exchange", ["GER40", "UK100", "JP225", "FRA40", "EU50", "AUS200", "HK50"].map(exchangeIndex), FROM);
} else if (basket === "shares-broker") {
  report("US shares the broker lists", baskets.BROKER.map(exchangeShare), FROM);
} else if (basket === "shares-etfs") {
  report("US index and sector funds", baskets.ETFS.map(exchangeShare), FROM);
} else if (basket === "shares-dow") {
  report("The Dow Jones thirty of February 2015", baskets.DOW2015.map(exchangeShare), FROM);
} else {
  throw new Error("usage: npx tsx research/new-instrument.ts ndx|ndx-broker|ndx2|calibrate|world|shares-broker|shares-etfs|shares-dow");
}
