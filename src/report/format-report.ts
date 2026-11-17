import { DateTime } from "luxon";
import type { SkipReason } from "../engine/types";
import type { Report } from "./build-report";
import type { BreakdownRow, MetricsBlock } from "./metrics";
import type { CriterionStatus } from "./verdict";

const SKIP_LABELS: Readonly<Record<SkipReason, string>> = {
  "position-open": "позиция уже открыта",
  "no-next-bar": "нет следующей свечи",
  "gap-after-signal": "гэп после сигнала",
  "usd-exposure": "лимит по доллару",
  "invalid-levels": "стоп или тейк не с той стороны",
  "stop-too-far": "стоп слишком далеко",
  "lot-too-small": "лот меньше 0.01",
};

const STATUS_LABELS: Readonly<Record<CriterionStatus, string>> = {
  continue: "продолжаем",
  reject: "отклоняем",
  between: "между",
  unknown: "нет данных",
};

export const money = (value: number): string =>
  `${value < 0 ? "−" : ""}${Math.abs(value).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const pct = (share: number | null): string =>
  share === null ? "—" : `${(share * 100).toFixed(1)}%`;

export const r = (value: number | null): string =>
  value === null ? "—" : `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(3)}`;

export const pf = (value: number | null): string =>
  value === null ? "—" : value === Infinity ? "∞" : value.toFixed(2);

/** A Markdown table whose cells are padded so it also reads in a terminal. */
export function mdTable(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string[] {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...rows.map(line),
  ];
}

const metricsHeader = ["Сделок", "Прибыльных", "Средний R", "PF", "Просадка", "Серия убытков", "Итог, USD"];

function metricsCells(block: MetricsBlock): string[] {
  return [
    String(block.trades),
    pct(block.winRate),
    r(block.meanR),
    pf(block.profitFactor),
    pct(block.maxDrawdownPct),
    String(block.longestLosingStreak),
    money(block.totalUsd),
  ];
}

function metricsRows(rows: ReadonlyArray<readonly [label: string, block: MetricsBlock]>): string[] {
  return mdTable(
    ["", ...metricsHeader],
    rows.map(([label, block]) => [label, ...metricsCells(block)]),
  );
}

function breakdownRows(rows: readonly BreakdownRow[], label: string): string[] {
  if (rows.length === 0) return ["Сделок нет."];
  return mdTable(
    [label, ...metricsHeader],
    rows.map((row) => [row.key, ...metricsCells(row.metrics)]),
  );
}

function paramLines(params: Report["params"]): string[] {
  return Object.entries(params).map(([key, value]) => `- ${key}: ${String(value)}`);
}

/** The report as Markdown; the same text goes to the console. */
export function formatReport(report: Report): string {
  const main = report.afterCosts;
  const finished = DateTime.fromMillis(report.finishedAt, { zone: "utc" }).toFormat(
    "yyyy-LL-dd HH:mm 'UTC'",
  );
  const lines: string[] = [];
  const section = (title: string): void => {
    lines.push("", `## ${title}`, "");
  };

  lines.push(`# ${report.strategy} на наборе ${report.dataset}`);
  lines.push("");
  lines.push(
    `Период: ${report.days.firstDay} — ${report.days.lastDay} (${report.days.days} дн., дни сервера ${report.brokerTimeZone}). Прогон завершён ${finished}.`,
  );
  lines.push(
    `Капитал ${money(report.initialCapitalUsd)} USD, риск ${report.riskPerTradePct}% на сделку. ` +
      `Издержки: спред из файла, не меньше ${report.costs.minSpreadPoints} п.; комиссия ${report.costs.commissionPerLotRoundTrip} USD/лот; ` +
      `проскальзывание ${report.costs.slippagePips} пипс; лимит по доллару ${report.usdExposureLimit ? "включён" : "выключен"}.`,
  );
  for (const warning of report.warnings) lines.push(`- ВНИМАНИЕ: ${warning}`);

  section(`Вердикт: ${report.verdict.code}`);
  lines.push(report.verdict.note, "");
  lines.push(
    ...mdTable(
      ["Метрика", "Значение", "Продолжаем", "Отклоняем", "Итог"],
      report.verdict.criteria.map((criterion) => [
        criterion.name,
        criterion.value,
        criterion.continueRule,
        criterion.rejectRule,
        STATUS_LABELS[criterion.status],
      ]),
    ),
  );

  section("Итог");
  lines.push(
    ...metricsRows([
      ["После издержек", main],
      ["До издержек", report.beforeCosts],
      [`Стресс-тест (издержки × ${report.stress.costMultiplier})`, report.stress.afterCosts],
    ]),
  );
  lines.push("");
  lines.push(
    `Математическое ожидание ${r(main.expectancyR)} R, в среднем ${main.meanUsd === null ? "—" : money(main.meanUsd)} USD на сделку. ` +
      `Баланс ${money(report.initialCapitalUsd)} → ${money(main.finalBalance)} USD, максимальная просадка ${money(main.maxDrawdownUsd)} USD.`,
  );
  const costs = report.costTotals;
  lines.push(
    `Издержки: спред ${money(costs.spreadUsd)}, проскальзывание ${money(costs.slippageUsd)}, комиссия ${money(costs.commissionUsd)}, своп ${money(costs.swapUsd)} USD.`,
  );
  if (report.bootstrap === null) {
    lines.push("Доверительный интервал среднего R: нет сделок.");
  } else {
    lines.push(
      `95% доверительный интервал среднего R (bootstrap, ${report.bootstrap.repeats.toLocaleString("ru-RU")} повторов, seed ${report.bootstrap.seed}): ` +
        `${r(report.bootstrap.lower)} … ${r(report.bootstrap.upper)}.`,
    );
  }
  if (report.skipped.length > 0) {
    lines.push(
      `Пропущено сигналов: ${report.skipped
        .map((item) => `${SKIP_LABELS[item.reason]} ${item.count}`)
        .join(", ")}.`,
    );
  }

  section("Ход цены внутри сделки: MAE и MFE");
  if (report.excursions === null || report.excursions === undefined) {
    lines.push("Для этого прогона не записано: он сделан до того, как движок стал считать MAE/MFE.");
  } else {
    const rows: ReadonlyArray<readonly [string, typeof report.excursions.all]> = [
      ["Все сделки", report.excursions.all],
      ["Прибыльные", report.excursions.wins],
      ["Убыточные", report.excursions.losses],
    ];
    lines.push(
      ...mdTable(
        ["", "Сделок", "Медиана MAE, R", "Медиана MFE, R", "MFE ≥ 0.5R", "MFE ≥ 1R", "MAE ≥ 0.5R"],
        rows.map(([label, stats]) => [
          label,
          String(stats.trades),
          stats.medianMaeR === null ? "—" : stats.medianMaeR.toFixed(2),
          stats.medianMfeR === null ? "—" : stats.medianMfeR.toFixed(2),
          pct(stats.mfeAtLeastHalfR),
          pct(stats.mfeAtLeast1R),
          pct(stats.maeAtLeastHalfR),
        ]),
      ),
    );
    lines.push(
      "",
      "MAE — максимальный ход против позиции, MFE — в её пользу, в долях риска. Считается по экстремумам свечей на той стороне, где позиция закрывается (Bid для покупки, Ask для продажи); у стопа MAE равен фактическому убытку, у тейка MFE — фактической прибыли.",
    );
  }

  section("Лимит по доллару (раздел 7.5)");
  lines.push(
    ...metricsRows([
      ["С лимитом", report.exposure.withLimit],
      ["Без лимита", report.exposure.withoutLimit],
    ]),
  );
  lines.push("", `С лимитом пропущено сигналов: ${report.exposure.skippedByLimit}.`);

  section("По парам");
  lines.push(...breakdownRows(report.bySymbol, "Пара"));
  section("По годам входа (UTC)");
  lines.push(...breakdownRows(report.byYear, "Год"));
  section("По часу входа (UTC)");
  lines.push(...breakdownRows(report.byHourUtc, "Час"));
  section(`По дню недели входа (время сервера ${report.brokerTimeZone})`);
  lines.push(...breakdownRows(report.byWeekday, "День"));

  section("Окно заказчика и фильтры по времени");
  lines.push(
    ...metricsRows([
      ["Вход 19:00–21:00 Asia/Tashkent", report.customerWindow],
      ["Без понедельника до 12:00 Europe/London", report.withoutMondayMorning],
      ["Без пятницы после 12:00 Europe/London", report.withoutFridayAfternoon],
      ["Без того и другого", report.withoutBoth],
    ]),
  );
  lines.push(
    "",
    "Просадка в строках-подмножествах пересчитана по тем же сделкам от стартового капитала: лоты считались на полном прогоне.",
  );

  section("Параметры");
  lines.push(...paramLines(report.params));

  return `${lines.join("\n")}\n`;
}
