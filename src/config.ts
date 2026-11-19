import { readFileSync } from "node:fs";
import path from "node:path";
import { IANAZone } from "luxon";
import { z } from "zod";

// Fixed by the TZ (sections 5, 6, 8). Not configurable on purpose.
export const TIMEFRAMES = ["D1", "H1", "M15"] as const;
/**
 * Shown on the chart page only: never validated, never loaded by the engine,
 * never part of the common range that sets the dev/test/holdout boundaries.
 */
export const CHART_ONLY_TIMEFRAMES = ["M5", "M1"] as const;
export const DATASETS = ["dev", "test", "holdout"] as const;
export const STRATEGY_NAMES = [
  "TrendD1",
  "BreakoutRetestV1-A",
  "BreakoutRetestV1-B",
  // Stage 2 (TZ section 16): V1-A plus a minimum stop distance.
  "BreakoutRetestV2-minstop",
  // Stage 2 (TZ 16.3): V1-A with the stop moved to the entry after +1R.
  "BreakoutRetestV2-breakeven",
  // Stage 2 (TZ 16.4): breakout and retest of a strong daily level.
  "StrongLevelD1",
  // Stage 2 (TZ 16.5): a rectangle after an impulse, broken in the impulse direction.
  "RectangleV1",
  // Stage 3 (TZ 17.3): trade against an H1 breakout that closed back inside.
  "FailedBreakoutV1",
  // Stage 3 (TZ 17.4): Connors RSI(2) mean reversion on daily bars.
  "Rsi2ReversionD1",
  // Stage 3 (TZ 17.5): EURUSD by the time of day, after Breedon and Ranaldo (2013).
  "TimeOfDayEURUSD",
  // Stage 3 (TZ 17.6): the turn of the month on US index CFDs, and its mid-month control.
  "TurnOfMonthIndex",
  "MidMonthIndexControl",
  // Stage 3 (TZ 17.7, 17.8): two ideas from the customer's Telegram channels.
  "ThreeTouchTrendD1",
  "SeriesBreakH4",
  // Stage 3 (TZ 17.10): gold range breakout with a limit order, from the course lessons.
  "GoldFlatLimitM15",
] as const;

/** An instrument name as MT5 writes it, e.g. EURUSD or XAUUSD. The set comes from the config (TZ 17). */
export type SymbolName = string;
export type Timeframe = (typeof TIMEFRAMES)[number];
export type ChartOnlyTimeframe = (typeof CHART_ONLY_TIMEFRAMES)[number];
export type AnyTimeframe = Timeframe | ChartOnlyTimeframe;
export type Dataset = (typeof DATASETS)[number];
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export const DEFAULT_CONFIG_PATH = "config/default.json";

// Node's Intl accepts raw offsets like "+05:00" as a time zone. The TZ forbids
// hand-written offsets (section 4), so only named zones pass.
function isNamedIanaZone(value: string): boolean {
  return !/^[+-]/.test(value) && IANAZone.isValidZone(value);
}

/**
 * One instrument. `digits` gives the point (10^-digits) and the pip (10 points);
 * `usdSide` says how a result in the quote currency becomes USD: "quote" for
 * EURUSD or XAUUSD (already USD), "base" for USDJPY or USDCAD (divide by the
 * price). Crosses without USD on either side are not supported.
 */
const symbolSchema = z.strictObject({
  digits: z.number().int().min(0).max(8),
  contractSize: z.number().positive(),
  usdSide: z.enum(["quote", "base"]),
  /** Pips per night, signed as MT5 shows them: negative is paid. */
  swapLongPips: z.number(),
  swapShortPips: z.number(),
  /** Per-instrument overrides of the cost defaults in `costs`. */
  minSpreadPoints: z.number().nonnegative().optional(),
  commissionPerLotRoundTrip: z.number().nonnegative().optional(),
  /**
   * Slippage in this instrument's own points (10^-digits) instead of
   * `costs.slippagePips`: a forex pip means nothing for an index (TZ 17.6).
   */
  slippagePoints: z.number().nonnegative().optional(),
  /**
   * The weekday whose rollover charges three nights. Wednesday for forex and
   * metals; FundedNext charges index CFDs on Friday (TZ 17.6). Default Wednesday.
   */
  tripleSwapDay: z.enum(["wednesday", "friday"]).optional(),
  /**
   * The price at which swapLongPips/swapShortPips were quoted. When set, a
   * trade's swap is scaled by its entry price over this price: financing is a
   * share of the position's value, and an index that has tripled since 2015
   * would otherwise be charged three times too much early on (TZ 17.6).
   */
  swapReferencePrice: z.number().positive().optional(),
  /**
   * false: this instrument's weekly close is reported but does not confirm or
   * refute the server time zone, because its trading schedule differs from
   * the FX week (TZ 17.2, gold). Default true.
   */
  timeZoneCheck: z.boolean().optional(),
});

export type SymbolConfig = z.infer<typeof symbolSchema>;

export const configSchema = z.strictObject({
  brokerTimeZone: z.string().refine(isNamedIanaZone, {
    error: "must be a named IANA time zone, e.g. Europe/Athens",
  }),
  dataDir: z.string().min(1),
  reportsDir: z.string().min(1),
  initialCapitalUsd: z.number().positive(),
  riskPerTradePct: z.number().positive().max(100),
  costs: z.strictObject({
    minSpreadPoints: z.number().nonnegative(),
    commissionPerLotRoundTrip: z.number().nonnegative(),
    slippagePips: z.number().nonnegative(),
  }),
  symbols: z
    .record(
      z.string().regex(/^[A-Z0-9]{3,12}$/, {
        error: "symbol names are upper-case letters and digits, e.g. EURUSD",
      }),
      symbolSchema,
    )
    .refine((symbols) => Object.keys(symbols).length > 0, {
      error: "at least one symbol is required",
    })
    .refine((symbols) => Object.values(symbols).some((own) => own.timeZoneCheck !== false), {
      error: "at least one symbol must confirm the time zone (timeZoneCheck not false)",
    }),
  /** Fixed dataset boundaries, server-time dates (TZ 17.2). Without them they follow the data (TZ 6). */
  datasets: z
    .strictObject({
      testStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      holdoutStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .optional(),
  usdExposureLimit: z.boolean(),
  /**
   * The MT5 economic calendar exported by tools/mt5/ExportCalendar.mq5.
   * Optional: without it strategies and reports simply see no news.
   */
  calendar: z
    .strictObject({
      file: z.string().min(1),
      /**
       * For exports without a <UTC> column (script 1.00): the server's offset
       * from UTC, in hours, at the moment of export. MT5 applies that one
       * offset to the whole history (checked 2026-11-19).
       */
      exportOffsetHours: z.number().min(-12).max(14).optional(),
    })
    .optional(),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Instrument names in config order. */
export function symbolNames(config: Config): string[] {
  return Object.keys(config.symbols);
}

export function symbolConfig(config: Config, symbol: string): SymbolConfig {
  const found = config.symbols[symbol];
  if (found === undefined) {
    throw new ConfigError(`Symbol ${symbol} is not in the config`);
  }
  return found;
}

export function parseConfig(raw: unknown, source = "config"): Config {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid ${source}:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/** Reads and validates the config. A relative path is resolved from the current working directory. */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  const absolutePath = path.resolve(configPath);

  let text: string;
  try {
    text = readFileSync(absolutePath, "utf8");
  } catch (cause) {
    throw new ConfigError(`Cannot read config file ${absolutePath}`, { cause });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`Config file ${absolutePath} is not valid JSON`, {
      cause,
    });
  }

  return parseConfig(raw, absolutePath);
}
