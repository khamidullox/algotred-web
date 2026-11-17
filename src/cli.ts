import { CliUsageError, parseCliArgs, USAGE } from "./cli-args";
import { ConfigError, loadConfig, type Config } from "./config";
import { readAllSeries } from "./data/load";
import {
  assertDatasetAccess,
  datasetSpan,
  describeSpan,
  HoldoutGuardError,
  splitCommonRange,
  SplitError,
} from "./data/split";
import { buildSymbolData } from "./data/symbol-data";
import { validateSeries, type ValidationReport } from "./data/validate";
import { formatValidationReport } from "./data/validate-report";
import { runBacktest } from "./engine/backtest";
import { EXPERIMENTS_PATH, recordExperiment } from "./report/experiments";
import { formatRunSummary } from "./report/run-summary";
import { saveRun, toSavedRun } from "./report/save-run";
import { STRATEGIES } from "./strategies";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
// A stub command must not look successful.
const EXIT_NOT_IMPLEMENTED = 2;
const EXIT_DATA_ERRORS = 3;
const EXIT_HOLDOUT_CLOSED = 4;

const MAX_ERRORS_SHOWN = 5;

function printDataErrors(report: ValidationReport): void {
  const errors = report.issues.filter((issue) => issue.severity === "error");
  console.error(
    `backtest: данные не прошли проверку, ошибок: ${errors.length}. Полный отчёт: npm run validate`,
  );
  for (const issue of errors.slice(0, MAX_ERRORS_SHOWN)) {
    console.error(`  - ${issue.message}`);
  }
}

function backtest(
  config: Config,
  args: Extract<ReturnType<typeof parseCliArgs>, { command: "backtest" }>,
): number {
  const access = { holdoutAcknowledged: args.holdoutAcknowledged };
  // Checked before any file is read: a holdout run that was not confirmed
  // must not get as far as the data.
  assertDatasetAccess(args.dataset, access);

  const strategy = STRATEGIES[args.strategy];
  if (strategy === undefined) {
    console.error(
      `backtest: стратегия ${args.strategy} ещё не реализована (шаг 7 ТЗ). Запуск не выполнен.`,
    );
    return EXIT_NOT_IMPLEMENTED;
  }

  const zone = config.brokerTimeZone;
  const inputs = readAllSeries(config);
  const report = validateSeries(inputs, zone);
  if (!report.ok || report.commonRange === null) {
    printDataErrors(report);
    return EXIT_DATA_ERRORS;
  }

  const split = splitCommonRange(report.commonRange, zone);
  const span = datasetSpan(split, args.dataset, access);
  const days = describeSpan(span, zone);
  console.log(
    `Считаю ${strategy.name} на наборе ${args.dataset} (${days.firstDay} — ${days.lastDay})...`,
  );

  const started = Date.now();
  const data = buildSymbolData(inputs, report.commonRange);
  const result = runBacktest({ data, strategy, span, config });
  const finishedAt = Date.now();

  const run = toSavedRun(result, args.dataset, config, finishedAt);
  const files = saveRun(run, config.reportsDir);

  // The journal is written before the result is shown (TZ section 6).
  const trades = run.trades;
  const sum = (pick: (trade: (typeof trades)[number]) => number): number =>
    trades.reduce((total, trade) => total + pick(trade), 0);
  const journaled = recordExperiment({
    finishedAt,
    strategy: args.strategy,
    dataset: args.dataset,
    span,
    brokerTimeZone: zone,
    parameters: {
      ...strategy.params,
      initialCapitalUsd: config.initialCapitalUsd,
      riskPerTradePct: config.riskPerTradePct,
      minSpreadPoints: config.costs.minSpreadPoints,
      commissionPerLotRoundTrip: config.costs.commissionPerLotRoundTrip,
      slippagePips: config.costs.slippagePips,
      swap: JSON.stringify(config.costs.swap),
      usdExposureLimit: run.usdExposureLimit,
      costMultiplier: run.costMultiplier,
    },
    metrics: {
      "Сделок": trades.length,
      "Прибыльных": trades.filter((trade) => trade.netPnlUsd > 0).length,
      "Итог до издержек, USD": sum((trade) => trade.grossPnlUsd).toFixed(2),
      "Итог после издержек, USD": sum((trade) => trade.netPnlUsd).toFixed(2),
      "Баланс в конце, USD": run.finalBalance.toFixed(2),
      "Пропущено сигналов": run.skipped.length,
      "Файлы": files.id,
    },
  });

  console.log("");
  console.log(formatRunSummary(run, files));
  console.log(`Время прогона: ${((finishedAt - started) / 1000).toFixed(1)} с`);
  if (journaled) {
    console.log(`Запуск записан в ${EXPERIMENTS_PATH}.`);
  }
  return EXIT_OK;
}

function main(argv: readonly string[]): number {
  const args = parseCliArgs(argv);

  if (args.command === "help") {
    console.log(USAGE);
    return EXIT_OK;
  }

  const config = loadConfig();

  switch (args.command) {
    case "validate": {
      const report = validateSeries(readAllSeries(config), config.brokerTimeZone);
      console.log(formatValidationReport(report));
      return report.ok ? EXIT_OK : EXIT_DATA_ERRORS;
    }
    case "backtest":
      return backtest(config, args);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof CliUsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = EXIT_USAGE;
  } else if (error instanceof ConfigError) {
    console.error(error.message);
    process.exitCode = EXIT_USAGE;
  } else if (error instanceof HoldoutGuardError) {
    console.error(error.message);
    process.exitCode = EXIT_HOLDOUT_CLOSED;
  } else if (error instanceof SplitError) {
    console.error(`backtest: ${error.message}`);
    process.exitCode = EXIT_DATA_ERRORS;
  } else {
    throw error;
  }
}
