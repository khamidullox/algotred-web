import { DateTime } from "luxon";
import type { SymbolName, Timeframe } from "../../src/config";
import { parseConfig, type Config } from "../../src/config";
import { nextZoneDay, startOfZoneDay } from "../../src/data/time";
import { MINUTE_MS, TIMEFRAME_MINUTES, type Bar } from "../../src/data/types";
import type { SymbolData } from "../../src/engine/backtest";
import type {
  MarketContext,
  Strategy,
  StrategyAction,
} from "../../src/engine/types";

export const ZONE = "Europe/Athens";

/** UTC ms of a server-time instant. */
export function at(iso: string, zone = ZONE): number {
  return DateTime.fromISO(iso, { zone }).toMillis();
}

export function bar(
  time: number,
  open: number,
  high: number,
  low: number,
  close: number,
  spreadPoints = 0,
): Bar {
  return { time, open, high, low, close, tickVolume: 1, spreadPoints };
}

/** `count` consecutive bars of a timeframe, all four prices equal to `price`. */
export function flatBars(
  timeframe: "M15" | "H1",
  from: string,
  count: number,
  price: number,
  spreadPoints = 0,
): Bar[] {
  const step = TIMEFRAME_MINUTES[timeframe] * MINUTE_MS;
  const start = at(from);
  return Array.from({ length: count }, (_, index) =>
    bar(start + index * step, price, price, price, price, spreadPoints),
  );
}

/** Returns a copy with one bar replaced by `patch`. */
export function withBar(
  bars: readonly Bar[],
  index: number,
  patch: Partial<Bar>,
): Bar[] {
  const copy = [...bars];
  copy[index] = { ...(bars[index] as Bar), ...patch };
  return copy;
}

/** Index of the bar that opens at the given server time. */
export function indexAt(bars: readonly Bar[], iso: string): number {
  const time = at(iso);
  const index = bars.findIndex((candidate) => candidate.time === time);
  if (index < 0) throw new Error(`no bar at ${iso}`);
  return index;
}

/** Builds H1 or D1 bars from lower-timeframe bars, like MT5 does. */
export function aggregateBars(
  lower: readonly Bar[],
  timeframe: "H1" | "D1",
  zone = ZONE,
): Bar[] {
  const groupStart = (time: number): number =>
    timeframe === "D1"
      ? startOfZoneDay(time, zone)
      : Math.floor(time / (60 * MINUTE_MS)) * 60 * MINUTE_MS;
  const result: Bar[] = [];
  let current: Bar | undefined;
  for (const inner of lower) {
    const start = groupStart(inner.time);
    if (current === undefined || current.time !== start) {
      if (current !== undefined) result.push(current);
      current = bar(start, inner.open, inner.high, inner.low, inner.close, inner.spreadPoints);
    } else {
      current = bar(
        start,
        current.open,
        Math.max(current.high, inner.high),
        Math.min(current.low, inner.low),
        inner.close,
        Math.min(current.spreadPoints, inner.spreadPoints),
      );
    }
  }
  if (current !== undefined) result.push(current);
  return result;
}

/** All three timeframes of a symbol from its M15 bars. */
export function symbolData(symbol: SymbolName, m15: readonly Bar[]): SymbolData {
  return {
    symbol,
    bars: {
      M15: m15,
      H1: aggregateBars(m15, "H1"),
      D1: aggregateBars(m15, "D1"),
    },
  };
}

/** Keeps only the bars that have closed by `time`, on every timeframe. */
export function truncate(data: SymbolData, time: number, zone = ZONE): SymbolData {
  const closeTime = (timeframe: Timeframe, candidate: Bar): number =>
    timeframe === "D1"
      ? nextZoneDay(candidate.time, zone)
      : candidate.time + TIMEFRAME_MINUTES[timeframe] * MINUTE_MS;
  return {
    symbol: data.symbol,
    bars: {
      M15: data.bars.M15.filter((candidate) => closeTime("M15", candidate) <= time),
      H1: data.bars.H1.filter((candidate) => closeTime("H1", candidate) <= time),
      D1: data.bars.D1.filter((candidate) => closeTime("D1", candidate) <= time),
    },
  };
}

/** The three pairs of the TZ as the engine tests know them, swaps at zero. */
export const TEST_SYMBOLS = {
  EURUSD: { digits: 5, contractSize: 100_000, usdSide: "quote" },
  GBPUSD: { digits: 5, contractSize: 100_000, usdSide: "quote" },
  USDJPY: { digits: 3, contractSize: 100_000, usdSide: "base" },
} as const;

/** A config with every cost at zero; pass overrides for the costs under test. */
export function testConfig(overrides: {
  minSpreadPoints?: number;
  commissionPerLotRoundTrip?: number;
  slippagePips?: number;
  swap?: Partial<Record<SymbolName, { swapLongPips: number; swapShortPips: number }>>;
  initialCapitalUsd?: number;
  riskPerTradePct?: number;
  usdExposureLimit?: boolean;
} = {}): Config {
  const symbols = Object.fromEntries(
    Object.entries(TEST_SYMBOLS).map(([symbol, own]) => [
      symbol,
      {
        ...own,
        swapLongPips: overrides.swap?.[symbol]?.swapLongPips ?? 0,
        swapShortPips: overrides.swap?.[symbol]?.swapShortPips ?? 0,
      },
    ]),
  );
  return parseConfig({
    brokerTimeZone: ZONE,
    dataDir: "data/raw",
    reportsDir: "reports",
    initialCapitalUsd: overrides.initialCapitalUsd ?? 10_000,
    riskPerTradePct: overrides.riskPerTradePct ?? 0.5,
    costs: {
      minSpreadPoints: overrides.minSpreadPoints ?? 0,
      commissionPerLotRoundTrip: overrides.commissionPerLotRoundTrip ?? 0,
      slippagePips: overrides.slippagePips ?? 0,
    },
    symbols,
    usdExposureLimit: overrides.usdExposureLimit ?? false,
  });
}

/**
 * A strategy that acts at scripted moments: `script` maps the close time of a
 * bar (server time ISO) to the action returned at that close.
 */
export function scripted(
  script: Readonly<Record<string, StrategyAction>>,
  executionTimeframe: "M15" | "H1" = "M15",
): Strategy {
  const byTime = new Map(
    Object.entries(script).map(([iso, action]) => [at(iso), action]),
  );
  return {
    name: "Scripted",
    params: {},
    executionTimeframe,
    create: () => ({
      onBarClose: (ctx: MarketContext) => byTime.get(ctx.now) ?? null,
    }),
  };
}

export const buy = (
  stopDistance: number,
  rMultiple: number | null = null,
  reason = "test",
): StrategyAction => ({
  kind: "entry",
  direction: "BUY",
  stopLoss: { distance: stopDistance },
  takeProfit: rMultiple === null ? null : { rMultiple },
  reason,
});

export const sell = (
  stopDistance: number,
  rMultiple: number | null = null,
  reason = "test",
): StrategyAction => ({
  kind: "entry",
  direction: "SELL",
  stopLoss: { distance: stopDistance },
  takeProfit: rMultiple === null ? null : { rMultiple },
  reason,
});

export const exit = (reason = "test exit"): StrategyAction => ({
  kind: "exit",
  reason,
});
