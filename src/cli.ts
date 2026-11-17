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
import { buildReport } from "./report/build-report";
import { EXPERIMENTS_PATH, recordExperiment } from "./report/experiments";
import { formatReport, pf, pct, r } from "./report/format-report";
import { saveReport, saveRun, toSavedRun } from "./report/save-run";
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
  // Two more runs feed the report: doubled costs (TZ 7.3) and the other
  // setting of the dollar limit (TZ 7.5).
  const stress = runBacktest({ data, strategy, span, config, options: { costMultiplier: 2 } });
  const exposureFlipped = runBacktest({
    data,
    strategy,
    span,
    config,
    options: { usdExposureLimit: !result.usdExposureLimit },
  });
  const finishedAt = Date.now();

  const run = toSavedRun(result, args.dataset, config, finishedAt);
  const files = saveRun(run, config.reportsDir);
  const built = buildReport({ run, stress, exposureFlipped });
  const markdown = formatReport(built);
  saveReport(built, markdown, files.directory);

  // The journal is written before the result is shown (TZ section 6).
  const main = built.afterCosts;
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
    },
    metrics: {
      "Вердикт": built.verdict.code,
      "Сделок": main.trades,
      "Прибыльных": pct(main.winRate),
      "Средний R": r(main.meanR),
      "Profit Factor": pf(main.profitFactor),
      "Максимальная просадка": pct(main.maxDrawdownPct),
      "Итог после издержек, USD": main.totalUsd.toFixed(2),
      "Итог до издержек, USD": built.beforeCosts.totalUsd.toFixed(2),
      "Стресс-тест, USD": built.stress.afterCosts.totalUsd.toFixed(2),
      "95% ДИ среднего R":
        built.bootstrap === null
          ? "—"
          : `${r(built.bootstrap.lower)} … ${r(built.bootstrap.upper)}`,
      "Файлы": files.id,
    },
  });

  console.log("");
  console.log(markdown);
  console.log(`Файлы прогона: ${files.directory}`);
  console.log("  report.md, report.json — отчёт; trades.csv — сделки для ручной сверки; run.json — всё, что посчитал движок");
  console.log(`Время прогона: ${((finishedAt - started) / 1000).toFixed(1)} с (три прогона: основной, стресс-тест, лимит по доллару)`);
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
