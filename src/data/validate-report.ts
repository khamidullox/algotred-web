import { DATASETS } from "../config";
import {
  describeSpan,
  splitCommonRange,
  SplitError,
  type DatasetSplit,
  type FrozenBoundaries,
} from "./split";
import { formatInZone, type TimeSpan } from "./time";
import type { Issue, ValidationReport } from "./validate";

function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

function share(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function issueLines(label: string, issues: readonly Issue[]): string[] {
  if (issues.length === 0) {
    return [];
  }
  const lines = ["", `${label} (${issues.length}):`];
  for (const issue of issues) {
    lines.push(`  - ${issue.message}`);
    for (const example of issue.examples) {
      lines.push(`      ${example}`);
    }
  }
  return lines;
}

function datasetLines(
  common: TimeSpan,
  zone: string,
  frozen: FrozenBoundaries | undefined,
): string[] {
  let split: DatasetSplit;
  try {
    split = splitCommonRange(common, zone, frozen);
  } catch (error) {
    if (error instanceof SplitError) {
      return ["", `Наборы данных: разделить нельзя. ${error.message}`];
    }
    throw error;
  }
  return [
    "",
    frozen === undefined
      ? "Наборы данных (дни сервера, обе даты включительно):"
      : "Наборы данных, границы закреплены в конфиге (дни сервера, обе даты включительно):",
    ...table(
      DATASETS.map((dataset) => {
        const days = describeSpan(split[dataset], zone);
        return [
          `  ${dataset}`,
          `${days.firstDay} — ${days.lastDay}`,
          `${days.days} дн.`,
          dataset === "holdout" ? "закрыт, нужен --i-understand-holdout" : "",
        ];
      }),
    ),
  ];
}

/** Plain-text report for the console. */
export function formatValidationReport(
  report: ValidationReport,
  frozen?: FrozenBoundaries,
): string {
  const zone = report.brokerTimeZone;
  const lines: string[] = [];
  lines.push(`Проверка данных. Часовой пояс сервера: ${zone}`);
  if (report.commonRange === null) {
    lines.push("Общий период: не определён");
  } else {
    lines.push(
      `Общий период: с ${formatInZone(report.commonRange.start, zone, "yyyy-LL-dd")} ` +
        `до ${formatInZone(report.commonRange.end, zone, "yyyy-LL-dd")}, не включая этот день (время сервера)`,
    );
    lines.push(...datasetLines(report.commonRange, zone, frozen));
  }

  lines.push("");
  lines.push(
    ...table([
      [
        "Файл",
        "Свечей",
        "В периоде",
        "Пропущено",
        "Нулевой спред",
        "Медиана спреда",
        "Закрытие Пт 17:00 NY",
      ],
      ...report.series.map((series) => [
        series.file,
        series.present ? String(series.rows) : "нет файла",
        series.usedRows === null ? "—" : String(series.usedRows),
        series.usedRows === null
          ? "—"
          : `${series.missingBars} (${share(series.missingShare)})`,
        series.spread === null ? "—" : share(series.spread.zeroShare),
        series.spread === null ? "—" : `${series.spread.medianPoints} п.`,
        series.weeks === null
          ? "—"
          : `${series.weeks.closeOk} из ${series.weeks.total}`,
      ]),
    ]),
  );

  if (report.consistency.length > 0) {
    lines.push("", "Согласованность таймфреймов:");
    lines.push(
      ...table(
        report.consistency.map((item) => [
          `  ${item.symbol} ${item.lower} -> ${item.higher}`,
          `сверено ${item.compared}`,
          `расхождений ${item.mismatches}`,
          `без пары ${item.higherWithoutLower + item.lowerWithoutHigher}`,
        ]),
      ),
    );
  }

  const m15 = report.series.filter(
    (series) => series.timeframe === "M15" && series.spread !== null,
  );
  if (m15.length > 0) {
    const years = [
      ...new Set(
        m15.flatMap((series) =>
          (series.spread?.byYear ?? []).map((year) => year.year),
        ),
      ),
    ].sort((a, b) => a - b);
    lines.push("", "Спред M15 по годам: среднее в пунктах / доля нулевых");
    lines.push(
      ...table([
        ["  Год", ...m15.map((series) => series.symbol)],
        ...years.map((year) => [
          `  ${year}`,
          ...m15.map((series) => {
            const entry = series.spread?.byYear.find(
              (item) => item.year === year,
            );
            return entry === undefined
              ? "—"
              : `${entry.meanPoints.toFixed(1)} / ${share(entry.zeroShare)}`;
          }),
        ]),
      ]),
    );
  }

  const of = (severity: Issue["severity"]): Issue[] =>
    report.issues.filter((issue) => issue.severity === severity);
  lines.push(...issueLines("Ошибки", of("error")));
  lines.push(...issueLines("Предупреждения", of("warning")));
  lines.push(...issueLines("К сведению", of("info")));

  lines.push("");
  if (report.timeZoneOk === true) {
    lines.push("Часовой пояс: подтверждён.");
  } else if (report.timeZoneOk === false) {
    lines.push("Часовой пояс: НЕ подтверждён.");
  } else {
    lines.push("Часовой пояс: проверить не удалось.");
  }
  lines.push(
    report.ok
      ? "Итог: ошибок нет, данные можно использовать."
      : `Итог: ошибок ${of("error").length}. Бэктест запускать нельзя, пока они не исправлены.`,
  );
  return lines.join("\n");
}
