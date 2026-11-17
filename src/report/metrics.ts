import { DateTime } from "luxon";
import type { Trade } from "../engine/types";

/** Which money result of a trade a metric block is computed on. */
export type ResultPick = (trade: Trade) => number;
export const NET: ResultPick = (trade) => trade.netPnlUsd;
export const GROSS: ResultPick = (trade) => trade.grossPnlUsd;

export interface MetricsBlock {
  readonly trades: number;
  readonly wins: number;
  readonly losses: number;
  /** Trades with a result of exactly zero. */
  readonly flat: number;
  /** Share of wins among all trades; null without trades. */
  readonly winRate: number | null;
  /** Mean result in R (result / risk at the stop). */
  readonly meanR: number | null;
  /** winRate * mean winning R - lossRate * mean losing R; equals meanR, shown because the TZ names both. */
  readonly expectancyR: number | null;
  readonly meanUsd: number | null;
  readonly totalUsd: number;
  /** Sum of wins / sum of losses; null without trades, Infinity without losses. */
  readonly profitFactor: number | null;
  /** Largest fall of the balance from a peak, as a share of that peak, on this set of trades in exit order. */
  readonly maxDrawdownPct: number;
  readonly maxDrawdownUsd: number;
  readonly longestLosingStreak: number;
  readonly finalBalance: number;
}

const EMPTY = (initialBalance: number): MetricsBlock => ({
  trades: 0,
  wins: 0,
  losses: 0,
  flat: 0,
  winRate: null,
  meanR: null,
  expectancyR: null,
  meanUsd: null,
  totalUsd: 0,
  profitFactor: null,
  maxDrawdownPct: 0,
  maxDrawdownUsd: 0,
  longestLosingStreak: 0,
  finalBalance: initialBalance,
});

/** R of a trade on the chosen result: result / USD at risk when the stop is hit. */
export function rOf(trade: Trade, pick: ResultPick = NET): number {
  return pick(trade) / trade.riskUsd;
}

/**
 * Metrics of a set of trades, walked in exit order from `initialBalance`.
 * For a subset of a run the balance path is a reconstruction: the real lots
 * were sized on the whole run.
 */
export function computeMetrics(
  trades: readonly Trade[],
  initialBalance: number,
  pick: ResultPick = NET,
): MetricsBlock {
  if (trades.length === 0) return EMPTY(initialBalance);
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime);

  let wins = 0;
  let losses = 0;
  let flat = 0;
  let sumWinUsd = 0;
  let sumLossUsd = 0;
  let sumR = 0;
  let sumWinR = 0;
  let sumLossR = 0;
  let balance = initialBalance;
  let peak = initialBalance;
  let maxDrawdownUsd = 0;
  let maxDrawdownPct = 0;
  let streak = 0;
  let longestLosingStreak = 0;

  for (const trade of ordered) {
    const usd = pick(trade);
    const r = usd / trade.riskUsd;
    sumR += r;
    if (usd > 0) {
      wins++;
      sumWinUsd += usd;
      sumWinR += r;
      streak = 0;
    } else if (usd < 0) {
      losses++;
      sumLossUsd += -usd;
      sumLossR += -r;
      streak++;
      longestLosingStreak = Math.max(longestLosingStreak, streak);
    } else {
      flat++;
      streak = 0;
    }
    balance += usd;
    if (balance > peak) peak = balance;
    const drawdown = peak - balance;
    if (drawdown > maxDrawdownUsd) maxDrawdownUsd = drawdown;
    if (peak > 0 && drawdown / peak > maxDrawdownPct) maxDrawdownPct = drawdown / peak;
  }

  const count = ordered.length;
  const winRate = wins / count;
  const lossRate = losses / count;
  const meanWinR = wins === 0 ? 0 : sumWinR / wins;
  const meanLossR = losses === 0 ? 0 : sumLossR / losses;
  return {
    trades: count,
    wins,
    losses,
    flat,
    winRate,
    meanR: sumR / count,
    expectancyR: winRate * meanWinR - lossRate * meanLossR,
    meanUsd: (sumWinUsd - sumLossUsd) / count,
    totalUsd: sumWinUsd - sumLossUsd,
    profitFactor: sumLossUsd === 0 ? Infinity : sumWinUsd / sumLossUsd,
    maxDrawdownPct,
    maxDrawdownUsd,
    longestLosingStreak,
    finalBalance: balance,
  };
}

export interface CostTotals {
  readonly spreadUsd: number;
  readonly slippageUsd: number;
  readonly commissionUsd: number;
  readonly swapUsd: number;
}

export function costTotals(trades: readonly Trade[]): CostTotals {
  const sum = (pick: (trade: Trade) => number): number =>
    trades.reduce((total, trade) => total + pick(trade), 0);
  return {
    spreadUsd: sum((trade) => trade.spreadCostUsd),
    slippageUsd: sum((trade) => trade.slippageCostUsd),
    commissionUsd: sum((trade) => trade.commissionUsd),
    swapUsd: sum((trade) => trade.swapUsd),
  };
}

export interface BreakdownRow {
  readonly key: string;
  readonly metrics: MetricsBlock;
}

/** Metrics per group, groups in the order of `keys` (or sorted by key when not given). */
export function breakdown(
  trades: readonly Trade[],
  initialBalance: number,
  groupOf: (trade: Trade) => string,
  keys?: readonly string[],
): BreakdownRow[] {
  const groups = new Map<string, Trade[]>();
  for (const trade of trades) {
    const key = groupOf(trade);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [trade]);
    else group.push(trade);
  }
  const order = keys ?? [...groups.keys()].sort();
  return order
    .filter((key) => groups.has(key))
    .map((key) => ({
      key,
      metrics: computeMetrics(groups.get(key) as Trade[], initialBalance),
    }));
}

export const WEEKDAYS_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] as const;

export const TASHKENT = "Asia/Tashkent";
export const LONDON = "Europe/London";

const inZone = (utcMs: number, zone: string): DateTime =>
  DateTime.fromMillis(utcMs, { zone });

/** Entry year, UTC. */
export const yearUtc = (trade: Trade): string =>
  String(new Date(trade.entryTime).getUTCFullYear());

/** Entry hour, UTC, two digits. */
export const hourUtc = (trade: Trade): string =>
  String(new Date(trade.entryTime).getUTCHours()).padStart(2, "0");

/**
 * Entry weekday in the given zone. The report uses broker server time: the
 * Monday open at 00:00 server time is still Sunday in UTC.
 */
export const weekdayIn =
  (zone: string) =>
  (trade: Trade): string =>
    WEEKDAYS_RU[inZone(trade.entryTime, zone).weekday - 1] as string;

/** Entries from 19:00 to 21:00 Tashkent time, both ends included (TZ 9, "окно заказчика"). */
export function inCustomerWindow(trade: Trade): boolean {
  const local = inZone(trade.entryTime, TASHKENT);
  const minutes = local.hour * 60 + local.minute;
  return minutes >= 19 * 60 && minutes <= 21 * 60;
}

/** Entry on Monday before 12:00 London time (12:00 itself is not "before"). */
export function isMondayMorningLondon(trade: Trade): boolean {
  const local = inZone(trade.entryTime, LONDON);
  return local.weekday === 1 && local.hour < 12;
}

/** Entry on Friday after 12:00 London time (12:00 itself is not "after"). */
export function isFridayAfternoonLondon(trade: Trade): boolean {
  const local = inZone(trade.entryTime, LONDON);
  return local.weekday === 5 && local.hour * 60 + local.minute > 12 * 60;
}

export interface Bootstrap {
  readonly repeats: number;
  readonly seed: number;
  readonly meanR: number;
  /** 2.5th and 97.5th percentiles of the resampled means. */
  readonly lower: number;
  readonly upper: number;
}

/** Small deterministic PRNG (mulberry32), so a report can be reproduced exactly. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * 95% confidence interval of the mean R by resampling the trades with
 * replacement `repeats` times (TZ 9: 10 000). Null without trades.
 */
export function bootstrapMeanR(
  values: readonly number[],
  repeats = 10_000,
  seed = 1,
): Bootstrap | null {
  const count = values.length;
  if (count === 0) return null;
  const random = mulberry32(seed);
  const means = new Float64Array(repeats);
  for (let repeat = 0; repeat < repeats; repeat++) {
    let sum = 0;
    for (let draw = 0; draw < count; draw++) {
      sum += values[Math.floor(random() * count)] as number;
    }
    means[repeat] = sum / count;
  }
  means.sort();
  const at = (share: number): number =>
    means[Math.min(repeats - 1, Math.max(0, Math.floor(share * repeats)))] as number;
  return {
    repeats,
    seed,
    meanR: values.reduce((total, value) => total + value, 0) / count,
    lower: at(0.025),
    upper: at(0.975),
  };
}
