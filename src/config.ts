import { readFileSync } from "node:fs";
import path from "node:path";
import { IANAZone } from "luxon";
import { z } from "zod";

// Fixed by the TZ (sections 5, 6, 8). Not configurable on purpose.
export const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY"] as const;
export const TIMEFRAMES = ["D1", "H1", "M15"] as const;
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
] as const;

export type SymbolName = (typeof SYMBOLS)[number];
export type Timeframe = (typeof TIMEFRAMES)[number];
export type Dataset = (typeof DATASETS)[number];
export type StrategyName = (typeof STRATEGY_NAMES)[number];

export const DEFAULT_CONFIG_PATH = "config/default.json";

// Node's Intl accepts raw offsets like "+05:00" as a time zone. The TZ forbids
// hand-written offsets (section 4), so only named zones pass.
function isNamedIanaZone(value: string): boolean {
  return !/^[+-]/.test(value) && IANAZone.isValidZone(value);
}

const swapSchema = z.strictObject({
  swapLongPips: z.number(),
  swapShortPips: z.number(),
});

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
    swap: z.strictObject({
      EURUSD: swapSchema,
      GBPUSD: swapSchema,
      USDJPY: swapSchema,
    }),
  }),
  usdExposureLimit: z.boolean(),
});

export type Config = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
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
