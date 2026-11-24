// What the confirmed daily strategy says on the latest daily bars, for the
// "Signals" page. Server-side only: reads the daily files on every request,
// from the live feed of the MT5 indicator when it is there, otherwise from
// the data folder. It shows the state of a backtested rule; it places no orders.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Config } from "../../config";
import { decodeMt5File, Mt5CsvFormatError, parseMt5Csv } from "../../data/mt5-csv";
import { createServerTimeConverter, nextZoneDay } from "../../data/time";
import type { Bar } from "../../data/types";
import { ClosedBarsView } from "../../engine/closed-bars";
import { lotsForRisk, LOT_STEP, riskAtStopUsd } from "../../engine/sizing";
import { pipValueUsdPerLot, roundPrice, symbolSpec, type SymbolSpec } from "../../engine/symbols";
import type { Direction } from "../../engine/types";
import { AtrWilder } from "../../indicators/atr";
import { RsiWilder } from "../../indicators/rsi";
import { Sma } from "../../indicators/sma";
import { closedDailyBars, replayDaily, type DailyState, type DailyTrade } from "../../signals/daily-state";
import { lotHint, type LotRules } from "../../signals/lot-hint";
import { readTerminalFeed, type FeedSymbol, type TerminalFeed } from "../../signals/terminal-feed";
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

const NASDAQ_NOTE = "В набор стратегии не входит: правила проверены на нём отдельно (ТЗ 17.18).";

/**
 * Nasdaq 100 is not in the strategy's frozen instrument list (its history is
 * too short for `dev`), but the same rules held on it when checked apart
 * (TZ 17.18). It is shown when its daily export is in the data folder, with
 * the contract FundedNext gives its indices.
 */
const EXTRA: readonly { readonly spec: SymbolSpec; readonly note: string }[] = [
  {
    spec: { symbol: "USTEC", digits: 2, point: 0.01, pip: 0.1, contractSize: 10, usdSide: "quote" },
    note: NASDAQ_NOTE,
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
  /** Lots for the configured risk, rounded down to the lot step; 0 when even the minimum lot risks too much. */
  readonly lots: number;
  /** Money lost at the stop with the minimum lot. */
  readonly minLotRiskUsd: number;
}

/** The day still trading: the last row of the file, left out of the rule's state. */
export interface TodayBar {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  /** The price when the file was written. */
  readonly last: number;
}

/** A signal to enter on a day that has already opened: where the rule's entry and stop are. */
export interface EntryPlan {
  /** The open of the entry day: the price the rule enters at. */
  readonly entryPrice: number;
  readonly stopPrice: number;
  /** True when today's range has already reached the stop. */
  readonly stopTouched: boolean;
}

/** What the rule would say tomorrow if today closed at the current price. */
export interface NextDay {
  readonly kind: DailyState["kind"];
  readonly direction: Direction | null;
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
  /** The contract facts a lot is counted from: the broker's in the terminal feed, the config's otherwise. */
  readonly lotRules: LotRules;
  readonly today: TodayBar | null;
  /** Set when the state is a signal to enter and the entry day has opened. */
  readonly plan: EntryPlan | null;
  /** True when a position of the rule is open and today's range has reached its stop. */
  readonly stopTouchedToday: boolean;
  readonly nextDay: NextDay | null;
  /** The last closed trades of the replay, newest first. */
  readonly recent: readonly DailyTrade[];
}

export type SignalsSource =
  /** Daily files of the data folder; `feedProblem` says why a feed that is there was not used. */
  | { readonly kind: "files"; readonly feedProblem: string | null }
  | {
      readonly kind: "terminal";
      readonly server: string;
      readonly serverTime: string;
      readonly ageSeconds: number;
      readonly stale: boolean;
    };

export interface SignalsView {
  readonly strategy: string;
  /** Money risked on a trade with the default account and risk. */
  readonly riskUsd: number;
  readonly source: SignalsSource;
  /** The defaults of the page's risk form: the terminal's balance when it gave one, else the config's capital. */
  readonly accountSize: number;
  readonly riskPct: number;
  readonly currency: string;
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

interface CardInput {
  readonly spec: SymbolSpec;
  readonly title: string;
  readonly note: string | null;
  readonly file: string | null;
  readonly lotRules: LotRules;
  /**
   * Whether the last row of the file is a day still trading, as the terminal
   * said when it wrote the file. Null for a file of the data folder: the
   * clock and the broker's time zone decide then.
   */
  readonly dayOpen: boolean | null;
}

function card(input: CardInput, zone: string, riskUsd: number, now: number): SignalCard {
  const { spec, file, lotRules } = input;
  const base = {
    symbol: spec.symbol,
    title: input.title,
    digits: spec.digits,
    note: input.note,
    file,
    asOf: null,
    ageDays: 0,
    unfinishedDayDropped: false,
    indicators: null,
    state: { kind: "flat" } as DailyState,
    sizing: null,
    lotRules,
    today: null,
    plan: null,
    stopTouchedToday: false,
    nextDay: null,
    recent: [],
  };
  if (file === null) return { ...base, problem: `Нет файла ${spec.symbol}_D1.csv в папке данных.` };
  let all: Bar[];
  try {
    all = readDaily(file, zone);
  } catch (error) {
    if (error instanceof Mt5CsvFormatError) return { ...base, problem: error.message };
    // The terminal may be replacing the file this very moment.
    if (input.dayOpen !== null) return { ...base, problem: "Файл от терминала сейчас не читается; страница обновится сама." };
    throw error;
  }
  const bars = input.dayOpen === null ? closedDailyBars(all, zone, now) : input.dayOpen ? all.slice(0, -1) : all;
  const last = bars.at(-1);
  if (last === undefined) return { ...base, problem: "В файле нет ни одной закрытой дневной свечи." };

  const replay = replayDaily(rsi2ReversionIndexD1, spec.symbol, spec, zone, bars);
  const { state } = replay;
  // The day still trading is the one row after the closed ones, and only when it has
  // opened before `now`: a past moment asked about never looks at a later bar.
  const lastRow = all.at(-1) as Bar;
  const unfinished =
    input.dayOpen === true || (input.dayOpen === null && all.length === bars.length + 1 && lastRow.time < now) ? lastRow : null;
  const today: TodayBar | null =
    unfinished === null ? null : { open: unfinished.open, high: unfinished.high, low: unfinished.low, last: unfinished.close };
  const touched = (direction: Direction, stop: number): boolean =>
    today !== null && (direction === "BUY" ? today.low <= stop : today.high >= stop);

  let plan: EntryPlan | null = null;
  if (state.kind === "enter" && today !== null) {
    const sign = state.direction === "BUY" ? 1 : -1;
    const stopPrice = roundPrice(spec, today.open - sign * state.stopDistance);
    plan = { entryPrice: today.open, stopPrice, stopTouched: touched(state.direction, stopPrice) };
  }
  const stopDistance =
    plan !== null ? Math.abs(plan.entryPrice - plan.stopPrice)
    : state.kind === "enter" ? state.stopDistance
    : state.kind === "flat" ? null
    : Math.abs(state.position.entryPrice - state.position.stopLoss);
  const price = state.kind === "open" || state.kind === "exit" ? state.position.entryPrice : last.close;

  let sizing: SignalSizing | null = null;
  if (stopDistance !== null) {
    if (input.dayOpen === null) {
      sizing = {
        stopDistance,
        lots: lotsForRisk(spec, riskUsd, stopDistance, price),
        minLotRiskUsd: riskAtStopUsd(spec, LOT_STEP, stopDistance, price),
      };
    } else {
      const hint = lotHint(lotRules, riskUsd, stopDistance);
      sizing = { stopDistance, lots: hint?.lots ?? 0, minLotRiskUsd: hint?.minLotRiskMoney ?? 0 };
    }
  }

  // What tomorrow would bring if the day still trading closed at its current price.
  let nextDay: NextDay | null = null;
  if (unfinished !== null) {
    const next = replayDaily(rsi2ReversionIndexD1, spec.symbol, spec, zone, all).state;
    nextDay = {
      kind: next.kind,
      direction: next.kind === "enter" ? next.direction : next.kind === "flat" ? null : next.position.direction,
    };
  }

  return {
    ...base,
    problem: null,
    asOf: last.time,
    ageDays: Math.max(0, Math.floor((now - nextZoneDay(last.time, zone)) / DAY_MS)),
    unfinishedDayDropped: bars.length < all.length,
    indicators: indicatorsOf(bars),
    state,
    sizing,
    today,
    plan,
    stopTouchedToday: (state.kind === "open" || state.kind === "exit") && touched(state.position.direction, state.position.stopLoss),
    nextDay,
    recent: replay.trades.slice(-RECENT_TRADES).reverse(),
  };
}

/**
 * The lot rules of an instrument of the config: 0.01 lots, the money of a
 * point from its contract. The strategy's instruments are quoted in USD, so
 * the price does not enter the value of a point.
 */
function configLotRules(spec: SymbolSpec): LotRules {
  return { moneyPerPointPerLot: pipValueUsdPerLot(spec, 1) / spec.pip, lotStep: LOT_STEP, lotMin: LOT_STEP, lotMax: 0 };
}

function fromFiles(config: Config, now: number, feedProblem: string | null): SignalsView {
  const zone = config.brokerTimeZone;
  const riskUsd = (config.initialCapitalUsd * config.riskPerTradePct) / 100;
  const own = (rsi2ReversionIndexD1.symbols ?? [])
    .filter((symbol) => config.symbols[symbol] !== undefined)
    .map((symbol) => {
      const spec = symbolSpec(config, symbol);
      const input = { spec, title: TITLES[symbol] ?? symbol, note: null, file: findDailyExport(config.dataDir, symbol), lotRules: configLotRules(spec), dayOpen: null };
      return card(input, zone, riskUsd, now);
    });
  // An extra instrument is shown only when its export is there.
  const extra = EXTRA.flatMap(({ spec, note }) => {
    const file = findDailyExport(config.dataDir, spec.symbol);
    const input = { spec, title: TITLES[spec.symbol] ?? spec.symbol, note, file, lotRules: configLotRules(spec), dayOpen: null };
    return file === null ? [] : [card(input, zone, riskUsd, now)];
  });
  return {
    strategy: rsi2ReversionIndexD1.name,
    riskUsd,
    source: { kind: "files", feedProblem },
    accountSize: config.initialCapitalUsd,
    riskPct: config.riskPerTradePct,
    currency: "USD",
    cards: [...own, ...extra],
  };
}

function feedCard(feed: TerminalFeed, own: FeedSymbol, zone: string, riskUsd: number, now: number): SignalCard {
  const point = 10 ** -own.digits;
  const moneyPerPointPerLot = own.tickValue / own.tickSize;
  // Only `digits` matters to the replay; the contract goes into the lot rules.
  const spec: SymbolSpec = { symbol: own.symbol, digits: own.digits, point, pip: point * 10, contractSize: moneyPerPointPerLot, usdSide: "quote" };
  const input = {
    spec,
    title: own.title === "" ? own.symbol : own.title,
    note: own.title === "Nasdaq 100" ? NASDAQ_NOTE : null,
    file: path.join(feed.dir, own.file),
    lotRules: { moneyPerPointPerLot, lotStep: own.lotStep, lotMin: own.lotMin, lotMax: own.lotMax },
    dayOpen: own.dayOpen,
  };
  return card(input, zone, riskUsd, now);
}

function fromFeed(config: Config, feed: TerminalFeed, now: number): SignalsView {
  const accountSize = feed.balance > 0 ? feed.balance : config.initialCapitalUsd;
  const riskUsd = (accountSize * config.riskPerTradePct) / 100;
  return {
    strategy: rsi2ReversionIndexD1.name,
    riskUsd,
    source: { kind: "terminal", server: feed.server, serverTime: feed.serverTime, ageSeconds: feed.ageSeconds, stale: feed.stale },
    accountSize,
    riskPct: config.riskPerTradePct,
    currency: feed.currency,
    cards: feed.symbols.map((own) => feedCard(feed, own, config.brokerTimeZone, riskUsd, now)),
  };
}

/**
 * The state of the strategy on the latest daily bars. With `feedDir` the live
 * feed of the MT5 indicator is used when it is there and readable; otherwise,
 * and always without `feedDir`, the daily files of the data folder.
 */
export function loadSignals(config: Config, now: number = Date.now(), feedDir: string | null = null): SignalsView {
  if (feedDir === null) return fromFiles(config, now, null);
  const read = readTerminalFeed(feedDir, now);
  if (read.kind === "ok") return fromFeed(config, read.feed, now);
  return fromFiles(config, now, read.kind === "broken" ? read.problem : null);
}
