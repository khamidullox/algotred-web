// Research stand (TZ 17.17): runs parameterised strategies on the `dev`
// dataset only and prints a line of metrics for each. The span is fixed to
// `dev` here on purpose: a search over rules must never see `test` or
// `holdout`. Nothing is saved to `reports/` or to EXPERIMENTS.md.
import { loadConfig, type Config } from "../src/config";
import { readCalendar, type NewsEvent } from "../src/data/calendar";
import { readAllSeries } from "../src/data/load";
import { splitCommonRange } from "../src/data/split";
import { buildSymbolData } from "../src/data/symbol-data";
import type { TimeSpan } from "../src/data/time";
import { skippedTimeZoneSymbols, validateSeries } from "../src/data/validate";
import { runBacktest, type SymbolData } from "../src/engine/backtest";
import type { BacktestResult, Strategy, Trade } from "../src/engine/types";

export interface Stand {
  readonly config: Config;
  readonly data: readonly SymbolData[];
  /** The `dev` span, and only it. */
  readonly span: TimeSpan;
  readonly news: readonly NewsEvent[];
}

export function loadStand(): Stand {
  const config = loadConfig();
  const zone = config.brokerTimeZone;
  const inputs = readAllSeries(config);
  const report = validateSeries(inputs, zone, skippedTimeZoneSymbols(config));
  if (!report.ok || report.commonRange === null) throw new Error("the data did not pass validation: run npm run validate");
  const split = splitCommonRange(report.commonRange, zone, config.datasets);
  return {
    config,
    data: buildSymbolData(inputs, report.commonRange),
    span: split.dev,
    news: readCalendar(config).events,
  };
}

export interface Group {
  readonly n: number;
  readonly meanR: number;
}

export interface Metrics {
  readonly trades: number;
  readonly skipped: number;
  /** After costs. */
  readonly meanR: number;
  /** The same fills with every cost at zero. */
  readonly grossR: number;
  readonly pf: number;
  readonly winPct: number;
  /** mean R -/+ 1.96 standard errors: a quick interval for ranking, not the report's bootstrap. */
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly totalUsd: number;
  readonly maxDrawdownPct: number;
  readonly perMonth: number;
  /** Share of the calendar months of the span that ended in profit. */
  readonly monthsPlusPct: number;
  readonly nights: number;
  readonly bySymbol: Readonly<Record<string, Group>>;
  readonly byYear: Readonly<Record<string, Group>>;
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;

function groups(trades: readonly Trade[], keyOf: (trade: Trade) => string): Record<string, Group> {
  const byKey = new Map<string, number[]>();
  for (const trade of trades) byKey.set(keyOf(trade), [...(byKey.get(keyOf(trade)) ?? []), trade.rMultiple]);
  return Object.fromEntries([...byKey.entries()].sort().map(([key, list]) => [key, { n: list.length, meanR: mean(list) }]));
}

export function metricsOf(result: BacktestResult): Metrics {
  const { trades } = result;
  const rs = trades.map((trade) => trade.rMultiple);
  const m = mean(rs);
  const sd = Math.sqrt(mean(rs.map((value) => (value - m) ** 2)) * (rs.length / Math.max(1, rs.length - 1)));
  const se = sd / Math.sqrt(Math.max(1, rs.length));
  const win = trades.filter((trade) => trade.netPnlUsd > 0).reduce((a, trade) => a + trade.netPnlUsd, 0);
  const loss = -trades.filter((trade) => trade.netPnlUsd < 0).reduce((a, trade) => a + trade.netPnlUsd, 0);
  let peak = result.initialBalance;
  let drawdown = 0;
  for (const trade of trades) {
    peak = Math.max(peak, trade.balanceAfter);
    drawdown = Math.max(drawdown, (peak - trade.balanceAfter) / peak);
  }
  const months = (result.span.end - result.span.start) / (30.4375 * 86_400_000);
  const monthly = new Map<string, number>();
  for (const trade of trades) {
    const key = new Date(trade.exitTime).toISOString().slice(0, 7);
    monthly.set(key, (monthly.get(key) ?? 0) + trade.netPnlUsd);
  }
  return {
    trades: trades.length,
    skipped: result.skipped.length,
    meanR: m,
    grossR: mean(trades.map((trade) => trade.grossPnlUsd / trade.riskUsd)),
    pf: loss === 0 ? Number.POSITIVE_INFINITY : win / loss,
    winPct: (100 * trades.filter((trade) => trade.netPnlUsd > 0).length) / Math.max(1, trades.length),
    ciLow: m - 1.96 * se,
    ciHigh: m + 1.96 * se,
    totalUsd: result.finalBalance - result.initialBalance,
    maxDrawdownPct: 100 * drawdown,
    perMonth: trades.length / months,
    monthsPlusPct: (100 * [...monthly.values()].filter((value) => value > 0).length) / Math.round(months),
    nights: mean(trades.map((trade) => trade.nights)),
    bySymbol: groups(trades, (trade) => trade.symbol),
    byYear: groups(trades, (trade) => new Date(trade.entryTime).toISOString().slice(0, 4)),
  };
}

export function evaluate(stand: Stand, strategy: Strategy, costMultiplier = 1): Metrics {
  return metricsOf(
    runBacktest({ data: stand.data, strategy, span: stand.span, config: stand.config, news: stand.news, options: { costMultiplier } }),
  );
}

const signed = (value: number, digits = 3): string => (Number.isNaN(value) ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`);

/** One tab-separated line; `header()` names the columns. */
export function line(label: string, m: Metrics): string {
  const per = (group: Readonly<Record<string, Group>>): string =>
    Object.entries(group)
      .map(([key, value]) => `${key}:${signed(value.meanR, 2)}(${value.n})`)
      .join(" ");
  return [
    label,
    m.trades,
    signed(m.meanR),
    signed(m.grossR),
    Number.isFinite(m.pf) ? m.pf.toFixed(2) : "inf",
    m.winPct.toFixed(1),
    signed(m.ciLow),
    m.totalUsd.toFixed(0),
    m.maxDrawdownPct.toFixed(1),
    m.perMonth.toFixed(1),
    m.monthsPlusPct.toFixed(0),
    m.nights.toFixed(1),
    per(m.bySymbol),
    per(m.byYear),
  ].join("\t");
}

export function header(): string {
  return ["rule", "trades", "meanR", "grossR", "PF", "win%", "ciLow", "USD", "maxDD%", "perMonth", "months+%", "nights", "by symbol", "by year"].join("\t");
}
