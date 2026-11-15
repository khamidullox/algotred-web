import { parseArgs } from "node:util";
import {
  DATASETS,
  STRATEGY_NAMES,
  type Dataset,
  type StrategyName,
} from "./config";

export type CliArgs =
  | { command: "help" }
  | { command: "validate" }
  | {
      command: "backtest";
      strategy: StrategyName;
      dataset: Dataset;
      holdoutAcknowledged: boolean;
    };

export class CliUsageError extends Error {
  override name = "CliUsageError";
}

export const USAGE = `Использование:
  npm run validate
  npm run backtest -- --strategy <имя> [--dataset dev|test|holdout] [--i-understand-holdout]

Стратегии: ${STRATEGY_NAMES.join(", ")}
Набор данных по умолчанию: dev`;

function isOneOf<T extends string>(
  allowed: readonly T[],
  value: string,
): value is T {
  return (allowed as readonly string[]).includes(value);
}

function parseBacktestArgs(argv: readonly string[]): CliArgs {
  let values: {
    strategy?: string;
    dataset: string;
    "i-understand-holdout": boolean;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        strategy: { type: "string" },
        dataset: { type: "string", default: "dev" },
        "i-understand-holdout": { type: "boolean", default: false },
      },
    }));
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new CliUsageError(`backtest: ${reason}`, { cause });
  }

  if (values.strategy === undefined) {
    throw new CliUsageError("backtest: не указан флаг --strategy");
  }
  if (!isOneOf(STRATEGY_NAMES, values.strategy)) {
    throw new CliUsageError(
      `backtest: неизвестная стратегия "${values.strategy}". Доступны: ${STRATEGY_NAMES.join(", ")}`,
    );
  }
  if (!isOneOf(DATASETS, values.dataset)) {
    throw new CliUsageError(
      `backtest: неизвестный набор данных "${values.dataset}". Доступны: ${DATASETS.join(", ")}`,
    );
  }

  return {
    command: "backtest",
    strategy: values.strategy,
    dataset: values.dataset,
    holdoutAcknowledged: values["i-understand-holdout"],
  };
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  const [command, ...rest] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return { command: "help" };
    case "validate":
      if (rest.length > 0) {
        throw new CliUsageError(
          `validate: лишние аргументы: ${rest.join(" ")}`,
        );
      }
      return { command: "validate" };
    case "backtest":
      return parseBacktestArgs(rest);
    default:
      throw new CliUsageError(`Неизвестная команда "${command}"`);
  }
}
