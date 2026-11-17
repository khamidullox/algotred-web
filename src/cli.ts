import { CliUsageError, parseCliArgs, USAGE } from "./cli-args";
import { ConfigError, loadConfig } from "./config";
import {
  assertDatasetAccess,
  datasetSpan,
  describeSpan,
  HoldoutGuardError,
  splitCommonRange,
  SplitError,
} from "./data/split";
import { validateData } from "./data/validate";
import { formatValidationReport } from "./data/validate-report";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
// A stub command must not look successful.
const EXIT_NOT_IMPLEMENTED = 2;
const EXIT_DATA_ERRORS = 3;
const EXIT_HOLDOUT_CLOSED = 4;

const MAX_ERRORS_SHOWN = 5;

function main(argv: readonly string[]): number {
  const args = parseCliArgs(argv);

  if (args.command === "help") {
    console.log(USAGE);
    return EXIT_OK;
  }

  const config = loadConfig();

  switch (args.command) {
    case "validate": {
      const report = validateData(config);
      console.log(formatValidationReport(report));
      return report.ok ? EXIT_OK : EXIT_DATA_ERRORS;
    }
    case "backtest": {
      const access = { holdoutAcknowledged: args.holdoutAcknowledged };
      // Checked before any file is read: a holdout run that was not confirmed
      // must not get as far as the data.
      assertDatasetAccess(args.dataset, access);

      const report = validateData(config);
      if (!report.ok || report.commonRange === null) {
        const errors = report.issues.filter(
          (issue) => issue.severity === "error",
        );
        console.error(
          `backtest: данные не прошли проверку, ошибок: ${errors.length}. Полный отчёт: npm run validate`,
        );
        for (const issue of errors.slice(0, MAX_ERRORS_SHOWN)) {
          console.error(`  - ${issue.message}`);
        }
        return EXIT_DATA_ERRORS;
      }

      const zone = config.brokerTimeZone;
      const split = splitCommonRange(report.commonRange, zone);
      const days = describeSpan(datasetSpan(split, args.dataset, access), zone);
      console.log(
        `Стратегия: ${args.strategy}\n` +
          `Набор данных: ${args.dataset}, с ${days.firstDay} по ${days.lastDay} включительно ` +
          `(${days.days} дн., дни сервера ${zone})`,
      );
      console.error(
        "backtest: стратегии ещё не реализованы (шаги 5 и 7 ТЗ). Запуск не выполнен, в EXPERIMENTS.md ничего не записано.",
      );
      return EXIT_NOT_IMPLEMENTED;
    }
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
