import type { Config, Dataset } from "../config";
import { describeSpan, type SpanDays } from "../data/split";
import type { TimeSpan } from "../data/time";
import type { BacktestResult, ParamValue, SkipReason, Trade } from "../engine/types";
import {
  bootstrapMeanR,
  breakdown,
  computeMetrics,
  costTotals,
  excursions,
  GROSS,
  hourUtc,
  inCustomerWindow,
  isFridayAfternoonLondon,
  isMondayMorningLondon,
  NET,
  rOf,
  WEEKDAYS_RU,
  weekdayIn,
  yearUtc,
  type Bootstrap,
  type BreakdownRow,
  type CostTotals,
  type Excursions,
  type MetricsBlock,
} from "./metrics";
import type { NewsEvent } from "../data/calendar";
import { newsBreakdown, type NewsBreakdown } from "./news";
import type { SavedRun, SymbolCostNote } from "./save-run";
import { decide, type Verdict } from "./verdict";

export const REPORT_VERSION = 1;
export const BOOTSTRAP_REPEATS = 10_000;
export const BOOTSTRAP_SEED = 1;

export interface Report {
  readonly version: number;
  readonly strategy: string;
  readonly params: Readonly<Record<string, ParamValue>>;
  readonly dataset: Dataset;
  readonly span: TimeSpan;
  readonly days: SpanDays;
  readonly brokerTimeZone: string;
  readonly finishedAt: number;
  readonly costs: Config["costs"];
  /** Per-instrument cost overrides of the run (TZ 17.6); empty for older runs. */
  readonly symbolCosts: Readonly<Record<string, SymbolCostNote>>;
  readonly initialCapitalUsd: number;
  readonly riskPerTradePct: number;
  readonly usdExposureLimit: boolean;
  readonly swapAccounted: boolean;
  /** After all costs: the headline numbers. */
  readonly afterCosts: MetricsBlock;
  /** The same trades with spread, slippage, commission and swap at zero. */
  readonly beforeCosts: MetricsBlock;
  readonly costTotals: CostTotals;
  readonly bySymbol: readonly BreakdownRow[];
  readonly byYear: readonly BreakdownRow[];
  readonly byHourUtc: readonly BreakdownRow[];
  /** Weekday of the entry in broker server time. */
  readonly byWeekday: readonly BreakdownRow[];
  /** Entries 19:00–21:00 Asia/Tashkent. */
  readonly customerWindow: MetricsBlock;
  readonly withoutMondayMorning: MetricsBlock;
  readonly withoutFridayAfternoon: MetricsBlock;
  readonly withoutBoth: MetricsBlock;
  readonly bootstrap: Bootstrap | null;
  /** MAE/MFE in R for all trades, wins and losses; null for runs saved before the fields existed. */
  readonly excursions: Excursions | null;
  /** The run repeated with spread, commission and slippage doubled. */
  readonly stress: { readonly costMultiplier: number; readonly afterCosts: MetricsBlock; readonly trades: number };
  /** The run repeated with usdExposureLimit flipped, so both settings are shown (TZ 7.5). */
  readonly exposure: {
    readonly withLimit: MetricsBlock;
    readonly withoutLimit: MetricsBlock;
    readonly skippedByLimit: number;
  };
  readonly verdict: Verdict;
  readonly skipped: ReadonlyArray<{ readonly reason: SkipReason; readonly count: number }>;
  readonly warnings: readonly string[];
  /** Trades near important news and the rest; absent in reports made before 2026-11-19 or without a calendar. */
  readonly news?: NewsBreakdown | null;
}

export interface ReportInput {
  readonly run: SavedRun;
  readonly stress: BacktestResult;
  readonly exposureFlipped: BacktestResult;
  /** The economic calendar, or null when the config has none. */
  readonly news?: readonly NewsEvent[] | null;
}

function countSkipped(result: BacktestResult): Array<{ reason: SkipReason; count: number }> {
  const counts = new Map<SkipReason, number>();
  for (const skip of result.skipped) counts.set(skip.reason, (counts.get(skip.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));
}

export function buildReport({ run, stress, exposureFlipped, news }: ReportInput): Report {
  const trades: readonly Trade[] = run.trades;
  const initial = run.initialBalance;
  const afterCosts = computeMetrics(trades, initial, NET);
  const beforeCosts = computeMetrics(trades, initial, GROSS);
  const bySymbol = breakdown(trades, initial, (trade) => trade.symbol, run.symbols);
  const bootstrap = bootstrapMeanR(
    trades.map((trade) => rOf(trade)),
    BOOTSTRAP_REPEATS,
    BOOTSTRAP_SEED,
  );
  const limited = run.usdExposureLimit ? afterCosts : computeMetrics(exposureFlipped.trades, initial);
  const unlimited = run.usdExposureLimit ? computeMetrics(exposureFlipped.trades, initial) : afterCosts;
  const limitedResult = run.usdExposureLimit ? run : exposureFlipped;

  const warnings: string[] = [];
  if (!run.swapAccounted) {
    warnings.push("Своп не учтён: в конфиге все значения свопа нулевые (раздел 7.3 ТЗ).");
  }
  if (run.costs.minSpreadPoints === 0 && run.costs.commissionPerLotRoundTrip === 0) {
    warnings.push(
      "Минимальный спред и комиссия равны нулю: издержки взяты только из колонки спреда файла, которая занижает их (раздел 5 ТЗ).",
    );
  }
  if (afterCosts.trades > 0 && trades.some((trade) => trade.exitReason === "end-of-data")) {
    warnings.push(
      `${trades.filter((trade) => trade.exitReason === "end-of-data").length} сд. закрыты концом набора по цене закрытия последней свечи.`,
    );
  }

  return {
    version: REPORT_VERSION,
    strategy: run.strategy,
    params: run.params,
    dataset: run.dataset,
    span: run.span,
    days: describeSpan(run.span, run.brokerTimeZone),
    brokerTimeZone: run.brokerTimeZone,
    finishedAt: run.finishedAt,
    costs: run.costs,
    symbolCosts: run.symbolCosts ?? {},
    initialCapitalUsd: run.initialCapitalUsd,
    riskPerTradePct: run.riskPerTradePct,
    usdExposureLimit: run.usdExposureLimit,
    swapAccounted: run.swapAccounted,
    afterCosts,
    beforeCosts,
    costTotals: costTotals(trades),
    bySymbol,
    byYear: breakdown(trades, initial, yearUtc),
    byHourUtc: breakdown(trades, initial, hourUtc),
    byWeekday: breakdown(trades, initial, weekdayIn(run.brokerTimeZone), WEEKDAYS_RU),
    customerWindow: computeMetrics(trades.filter(inCustomerWindow), initial),
    withoutMondayMorning: computeMetrics(
      trades.filter((trade) => !isMondayMorningLondon(trade)),
      initial,
    ),
    withoutFridayAfternoon: computeMetrics(
      trades.filter((trade) => !isFridayAfternoonLondon(trade)),
      initial,
    ),
    withoutBoth: computeMetrics(
      trades.filter((trade) => !isMondayMorningLondon(trade) && !isFridayAfternoonLondon(trade)),
      initial,
    ),
    bootstrap,
    excursions: excursions(trades),
    stress: {
      costMultiplier: stress.costMultiplier,
      afterCosts: computeMetrics(stress.trades, initial),
      trades: stress.trades.length,
    },
    exposure: {
      withLimit: limited,
      withoutLimit: unlimited,
      skippedByLimit: limitedResult.skipped.filter((skip) => skip.reason === "usd-exposure").length,
    },
    verdict: decide(afterCosts, bySymbol, bootstrap, run.strategy, run.dataset),
    skipped: countSkipped(run),
    warnings,
    news: news === undefined || news === null ? null : newsBreakdown(trades, news, initial, run.span, run.symbols),
  };
}
