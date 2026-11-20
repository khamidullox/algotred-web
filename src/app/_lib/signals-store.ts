// What the confirmed daily strategy says on the latest daily bars in the data
// folder, for the "Signals" page. Server-side only: reads the D1 files on
// every request. It shows the state of a backtested rule; it places no orders.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../config";
import { decodeMt5File, Mt5CsvFormatError, parseMt5Csv } from "../../data/mt5-csv";
import { createServerTimeConverter, nextZoneDay } from "../../data/time";
import type { Bar } from "../../data/types";
import { ClosedBarsView } from "../../engine/closed-bars";
import { lotsForRisk, LOT_STEP, riskAtStopUsd } from "../../engine/sizing";
import { symbolSpec, type SymbolSpec } from "../../engine/symbols";
import { AtrWilder } from "../../indicators/atr";
import { RsiWilder } from "../../indicators/rsi";
import { Sma } from "../../indicators/sma";
import { closedDailyBars, replayDaily, type DailyState, type DailyTrade } from "../../signals/daily-state";
import { RSI2_REVERSION, rsi2ReversionIndexD1 } from "../../strategies/rsi2-reversion-d1";

const DAY_MS = 86_400_000;
/** Data older than this many days is called out: a weekend plus a holiday fits inside. */
export const STALE_AFTER_DAYS = 4;
const RECENT_TRADES = 5;

const TITLES: Readonly<Record<string, string>> = {
  US500: "S&P 500",
  US30: "Dow Jones",
  US2000: "Russell 2000",
  USTEC: "Nasdaq 100",
};

/**
 * Nasdaq 100 is not in the strategy's frozen instrument list (its history is
 * too short for `dev`), but the same rules held on it when checked apart
 * (TZ 17.18). It is shown when its daily export is in the data folder, with
 * the contract FundedNext gives its indices.
 */
const EXTRA: readonly { readonly spec: SymbolSpec; readonly note: string }[] = [
  {
    spec: { symbol: "USTEC", digits: 2, point: 0.01, pip: 0.1, contractSize: 10, usdSide: "quote" },
    note: "В набор стратегии не входит: правила проверены на нём отдельно (ТЗ 17.18).",
  },
];

export interface SignalIndicators {
  readonly close: number;
  readonly trendSma: number;
  readonly rsi: number;
  readonly exitSma: number;
  readonly atr: number;
}

export interface SignalSizing {
  /** The stop distance in price units: 2 x ATR(20) for a signal, entry to stop for an open position. */
  readonly stopDistance: number;
  /** Lots for the configured risk, rounded down to 0.01; 0 when even 0.01 risks too much. */
  readonly lots: number;
  /** USD lost at the stop with the minimum lot. */
  readonly minLotRiskUsd: number;
}

export interface SignalCard {
  readonly symbol: string;
  readonly title: string;
  readonly digits: number;
  /** Set for an instrument outside the strategy's own list. */
  readonly note: string | null;
  /** Why there is nothing to show, or null. */
  readonly problem: string | null;
  readonly file: string | null;
  /** Open time of the last closed daily bar, UTC ms. */
  readonly asOf: number | null;
  /** Whole days since that bar closed. */
  readonly ageDays: number;
  /** True when the last row of the file was a day still trading and was left out. */
  readonly unfinishedDayDropped: boolean;
  readonly indicators: SignalIndicators | null;
  readonly state: DailyState;
  readonly sizing: SignalSizing | null;
  /** The last closed trades of the replay, newest first. */
  readonly recent: readonly DailyTrade[];
}

export interface SignalsView {
  readonly strategy: string;
  readonly riskUsd: number;
  readonly cards: readonly SignalCard[];
}

/**
 * The daily export of a symbol in the data folder: the TZ name (US500_D1.csv)
 * or the name MT5 gives it (USTEC_Daily_202207060000_202610300000.csv). When
 * there are several, the one changed last. Null when there is none.
 */
export function findDailyExport(dataDir: string, symbol: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return null;
  }
  const pattern = new RegExp(`^${symbol}_(?:D1|Daily)(?:_\\d{12}_\\d{12})?\\.csv$`, "i");
  const found = names
    .filter((name) => pattern.test(name))
    .map((name) => ({ name, changed: statSync(path.join(dataDir, name)).mtimeMs }))
    .sort((a, b) => b.changed - a.changed)[0];
  return found === undefined ? null : path.join(dataDir, found.name);
}

function readDaily(file: string, zone: string): Bar[] {
  const text = decodeMt5File(readFileSync(file));
  return parseMt5Csv(text, { timeframe: "D1", toUtc: createServerTimeConverter(zone) }).bars;
}

/** The strategy's own indicators on the last closed bar, for the page to show what the rule looks at. */
function indicatorsOf(bars: readonly Bar[]): SignalIndicators | null {
  const last = bars.at(-1);
  if (last === undefined) return null;
  const view = new ClosedBarsView(bars, bars.length);
  return {
    close: last.close,
    trendSma: new Sma(RSI2_REVERSION.trendSmaPeriod).update(view),
    rsi: new RsiWilder(RSI2_REVERSION.rsiPeriod).update(view),
    exitSma: new Sma(RSI2_REVERSION.exitSmaPeriod).update(view),
    atr: new AtrWilder(RSI2_REVERSION.atrPeriod).update(view),
  };
}

function card(spec: SymbolSpec, note: string | null, file: string | null, zone: string, riskUsd: number, now: number): SignalCard {
  const base = {
    symbol: spec.symbol,
    title: TITLES[spec.symbol] ?? spec.symbol,
    digits: spec.digits,
    note,
    file,
    asOf: null,
    ageDays: 0,
    unfinishedDayDropped: false,
    indicators: null,
    state: { kind: "flat" } as DailyState,
    sizing: null,
    recent: [],
  };
  if (file === null) return { ...base, problem: `Нет файла ${spec.symbol}_D1.csv в папке данных.` };
  let all: Bar[];
  try {
    all = readDaily(file, zone);
  } catch (error) {
    if (!(error instanceof Mt5CsvFormatError)) throw error;
    return { ...base, problem: error.message };
  }
  const bars = closedDailyBars(all, zone, now);
  const last = bars.at(-1);
  if (last === undefined) return { ...base, problem: "В файле нет ни одной закрытой дневной свечи." };

  const replay = replayDaily(rsi2ReversionIndexD1, spec.symbol, spec, zone, bars);
  const { state } = replay;
  const stopDistance =
    state.kind === "enter" ? state.stopDistance
    : state.kind === "flat" ? null
    : Math.abs(state.position.entryPrice - state.position.stopLoss);
  const price = state.kind === "open" || state.kind === "exit" ? state.position.entryPrice : last.close;
  return {
    ...base,
    problem: null,
    asOf: last.time,
    ageDays: Math.max(0, Math.floor((now - nextZoneDay(last.time, zone)) / DAY_MS)),
    unfinishedDayDropped: bars.length < all.length,
    indicators: indicatorsOf(bars),
    state,
    sizing:
      stopDistance === null
        ? null
        : {
            stopDistance,
            lots: lotsForRisk(spec, riskUsd, stopDistance, price),
            minLotRiskUsd: riskAtStopUsd(spec, LOT_STEP, stopDistance, price),
          },
    recent: replay.trades.slice(-RECENT_TRADES).reverse(),
  };
}

export function loadSignals(config: Config, now: number = Date.now()): SignalsView {
  const zone = config.brokerTimeZone;
  const riskUsd = (config.initialCapitalUsd * config.riskPerTradePct) / 100;
  const own = (rsi2ReversionIndexD1.symbols ?? [])
    .filter((symbol) => config.symbols[symbol] !== undefined)
    .map((symbol) => card(symbolSpec(config, symbol), null, findDailyExport(config.dataDir, symbol), zone, riskUsd, now));
  // An extra instrument is shown only when its export is there.
  const extra = EXTRA.flatMap(({ spec, note }) => {
    const file = findDailyExport(config.dataDir, spec.symbol);
    return file === null ? [] : [card(spec, note, file, zone, riskUsd, now)];
  });
  return { strategy: rsi2ReversionIndexD1.name, riskUsd, cards: [...own, ...extra] };
}
