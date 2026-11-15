import { CliUsageError, parseCliArgs, USAGE } from "./cli-args";
import { ConfigError, loadConfig } from "./config";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
// Stub commands must not look successful: a `validate` that exits 0 without
// validating anything would be read as "data is fine".
const EXIT_NOT_IMPLEMENTED = 2;

function main(argv: readonly string[]): number {
  const args = parseCliArgs(argv);

  if (args.command === "help") {
    console.log(USAGE);
    return EXIT_OK;
  }

  const config = loadConfig();

  switch (args.command) {
    case "validate":
      console.error(
        `validate: ещё не реализовано (шаг 2 ТЗ).\n` +
          `  dataDir: ${config.dataDir}\n` +
          `  brokerTimeZone: ${config.brokerTimeZone}`,
      );
      return EXIT_NOT_IMPLEMENTED;
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
