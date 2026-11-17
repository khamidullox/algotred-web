import { CliUsageError, parseCliArgs, USAGE } from "./cli-args";
import { ConfigError, loadConfig } from "./config";
import { validateData } from "./data/validate";
import { formatValidationReport } from "./data/validate-report";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
// A stub command must not look successful.
const EXIT_NOT_IMPLEMENTED = 2;
const EXIT_DATA_ERRORS = 3;

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
    case "backtest":
      console.error(
        `backtest: ещё не реализовано (шаги 3–6 ТЗ).\n` +
          `  strategy: ${args.strategy}\n` +
          `  dataset: ${args.dataset}`,
      );
      return EXIT_NOT_IMPLEMENTED;
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
  } else {
    throw error;
  }
}
