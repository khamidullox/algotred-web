import type { ExitReason, SkipReason, Trade } from "../engine/types";
import { describeSpan } from "../data/split";
import type { SavedRun } from "./save-run";

const EXIT_LABELS: Readonly<Record<ExitReason, string>> = {
  stop: "по стопу",
  take: "по тейку",
  strategy: "по правилу стратегии",
  "end-of-data": "закрыто концом данных",
};

const SKIP_LABELS: Readonly<Record<SkipReason, string>> = {
  "position-open": "позиция уже открыта",
  "no-next-bar": "нет следующей свечи",
  "usd-exposure": "лимит по доллару",
  "invalid-levels": "стоп или тейк не с той стороны",
  "stop-too-far": "стоп слишком далеко",
  "lot-too-small": "лот меньше 0.01",
};

function count<T extends string>(items: readonly T[]): Array<[T, number]> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const money = (value: number): string =>
  `${value < 0 ? "-" : ""}${Math.abs(value).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

/**
 * A short console account of a run: what was traded and where the files are.
 * The metrics of TZ section 9 come with the report in step 6.
 */
export function formatRunSummary(run: SavedRun, files: { directory: string } | null): string {
  const days = describeSpan(run.span, run.brokerTimeZone);
  const trades: readonly Trade[] = run.trades;
  const wins = trades.filter((trade) => trade.netPnlUsd > 0).length;
  const sum = (pick: (trade: Trade) => number): number =>
    trades.reduce((total, trade) => total + pick(trade), 0);
  const lines: string[] = [];

  lines.push(`Стратегия: ${run.strategy}`);
  lines.push(
    `Набор данных: ${run.dataset}, с ${days.firstDay} по ${days.lastDay} включительно (${days.days} дн., дни сервера ${run.brokerTimeZone})`,
  );
  const { costs } = run;
  lines.push(
    `Издержки: спред из файла, не меньше ${costs.minSpreadPoints} п.; комиссия ${costs.commissionPerLotRoundTrip} USD/лот; проскальзывание ${costs.slippagePips} пипс` +
      (run.costMultiplier !== 1 ? `; множитель стресс-теста ${run.costMultiplier}` : ""),
  );
  if (!run.swapAccounted) {
    lines.push("ВНИМАНИЕ: своп не учтён — в конфиге все значения свопа нулевые.");
  }
  lines.push(
    `Лимит по доллару (usdExposureLimit): ${run.usdExposureLimit ? "включён" : "выключен"}`,
  );
  lines.push("");

  if (trades.length === 0) {
    lines.push("Сделок нет.");
  } else {
    lines.push(`Сделок: ${trades.length}, прибыльных ${wins} (${((wins / trades.length) * 100).toFixed(1)}%)`);
    for (const symbol of [...new Set(trades.map((trade) => trade.symbol))]) {
      const own = trades.filter((trade) => trade.symbol === symbol);
      lines.push(`  ${symbol}: ${own.length} сд., итог ${money(sum((t) => (t.symbol === symbol ? t.netPnlUsd : 0)))}`);
    }
    lines.push(
      `Выходы: ${count(trades.map((trade) => trade.exitReason))
        .map(([reason, n]) => `${EXIT_LABELS[reason]} ${n}`)
        .join(", ")}`,
    );
    lines.push(`Итог до издержек: ${money(sum((t) => t.grossPnlUsd))}`);
    lines.push(
      `Издержки: спред ${money(sum((t) => t.spreadCostUsd))}, проскальзывание ${money(sum((t) => t.slippageCostUsd))}, ` +
        `комиссия ${money(sum((t) => t.commissionUsd))}, своп ${money(sum((t) => t.swapUsd))}`,
    );
    lines.push(`Итог после издержек: ${money(sum((t) => t.netPnlUsd))}`);
    lines.push(`Баланс: ${money(run.initialBalance)} -> ${money(run.finalBalance)}`);
  }
  if (run.skipped.length > 0) {
    lines.push(
      `Пропущено сигналов: ${run.skipped.length} (${count(run.skipped.map((skip) => skip.reason))
        .map(([reason, n]) => `${SKIP_LABELS[reason]} ${n}`)
        .join(", ")})`,
    );
  }
  if (files !== null) {
    lines.push("", `Файлы прогона: ${files.directory}`, "  run.json — всё, что посчитал движок; trades.csv — список сделок для ручной сверки");
  }
  return lines.join("\n");
}
