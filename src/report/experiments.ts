import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import type { Dataset, StrategyName } from "../config";
import { describeSpan } from "../data/split";
import type { TimeSpan } from "../data/time";

export const EXPERIMENTS_PATH = "EXPERIMENTS.md";

/** Runs on these datasets are always written to the journal (TZ section 6). */
export const JOURNALED_DATASETS: readonly Dataset[] = ["test", "holdout"];

export const JOURNAL_HEADER = `# EXPERIMENTS

Журнал запусков на наборах \`test\` и \`holdout\` (раздел 6 ТЗ). Записи дописывает команда \`backtest\` автоматически. Руками не править и не удалять.

Если правило изменили после просмотра \`test\`, это новая стратегия с новым именем, и её \`test\`-результат уже не считается независимым.

## Запуски
`;

export type JournalValue = string | number | boolean;

export interface ExperimentRun {
  /** When the run finished, UTC ms. */
  readonly finishedAt: number;
  readonly strategy: StrategyName;
  readonly dataset: Dataset;
  /** The dataset boundaries the run actually used. */
  readonly span: TimeSpan;
  readonly brokerTimeZone: string;
  /** Everything that changes the result: strategy parameters and cost settings. */
  readonly parameters: Readonly<Record<string, JournalValue>>;
  readonly metrics: Readonly<Record<string, JournalValue>>;
}

// A line break inside a value would break the Markdown list.
const oneLine = (value: JournalValue): string =>
  String(value).replace(/\s*[\r\n]+\s*/g, " ");

function valueLines(values: Readonly<Record<string, JournalValue>>): string[] {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return ["  - нет"];
  }
  return entries.map(([key, value]) => `  - ${oneLine(key)}: ${oneLine(value)}`);
}

/** One journal entry as Markdown, ending with a line break. */
export function formatExperiment(run: ExperimentRun): string {
  const finished = DateTime.fromMillis(run.finishedAt, { zone: "utc" }).toFormat(
    "yyyy-LL-dd HH:mm:ss 'UTC'",
  );
  const days = describeSpan(run.span, run.brokerTimeZone);
  return [
    `### ${finished} · ${run.strategy} · ${run.dataset}`,
    "",
    `- Набор данных: \`${run.dataset}\`, с ${days.firstDay} по ${days.lastDay} включительно ` +
      `(${days.days} дн., дни сервера \`${run.brokerTimeZone}\`)`,
    "- Параметры:",
    ...valueLines(run.parameters),
    "- Главные метрики:",
    ...valueLines(run.metrics),
    "",
  ].join("\n");
}

/**
 * Writes a finished run to the journal. Runs on `dev` are not journaled.
 * Existing entries are never rewritten: the file is only appended to.
 *
 * Call it before the result is shown, so a result that was seen is always a
 * result that was recorded. Returns true when an entry was written.
 */
export function recordExperiment(
  run: ExperimentRun,
  file: string = path.resolve(EXPERIMENTS_PATH),
): boolean {
  if (!JOURNALED_DATASETS.includes(run.dataset)) {
    return false;
  }
  const entry = formatExperiment(run);
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.trim() === "") {
    writeFileSync(file, `${JOURNAL_HEADER}\n${entry}`);
    return true;
  }
  const gap = /\r?\n\r?\n$/.test(current)
    ? ""
    : current.endsWith("\n")
      ? "\n"
      : "\n\n";
  appendFileSync(file, gap + entry);
  return true;
}
