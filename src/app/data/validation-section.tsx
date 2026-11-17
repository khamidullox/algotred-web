"use client";

import { useState } from "react";
import type { Issue, ValidationReport } from "../../data/validate";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "done"; report: ValidationReport };

const share = (value: number): string => `${(value * 100).toFixed(1)}%`;
const count = (value: number): string => value.toLocaleString("ru-RU");

function serverDate(utcMs: number, zone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(utcMs);
}

function IssueList({ issues }: { issues: Issue[] }) {
  return (
    <ul className="issues">
      {issues.map((issue, index) => (
        <li key={index}>
          {issue.message}
          {issue.examples.length > 0 && (
            <ul>
              {issue.examples.map((example) => (
                <li key={example}>
                  <code>{example}</code>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

function Report({ report }: { report: ValidationReport }) {
  const zone = report.brokerTimeZone;
  const errors = report.issues.filter((issue) => issue.severity === "error");
  const warnings = report.issues.filter((issue) => issue.severity === "warning");
  const notes = report.issues.filter((issue) => issue.severity === "info");
  const m15 = report.series.filter(
    (series) => series.timeframe === "M15" && series.spread !== null,
  );
  const years = [
    ...new Set(m15.flatMap((series) => series.spread?.byYear.map((year) => year.year) ?? [])),
  ].sort((a, b) => a - b);

  return (
    <>
      <div className={`banner ${report.ok ? "ok" : "bad"}`}>
        {report.ok
          ? "Ошибок нет, данные можно использовать."
          : `Ошибок: ${errors.length}. Бэктест запускать нельзя, пока они не исправлены.`}
      </div>

      <dl className="facts">
        <div>
          <dt>Общий период</dt>
          <dd>
            {report.commonRange === null
              ? "не определён"
              : `с ${serverDate(report.commonRange.start, zone)} до ${serverDate(report.commonRange.end, zone)}, не включая этот день`}
          </dd>
        </div>
        <div>
          <dt>Часовой пояс {zone}</dt>
          <dd>
            {report.timeZoneOk === true && "подтверждён"}
            {report.timeZoneOk === false && "не подтверждён"}
            {report.timeZoneOk === null && "проверить не удалось"}
          </dd>
        </div>
      </dl>

      {errors.length > 0 && (
        <>
          <h3>Ошибки</h3>
          <IssueList issues={errors} />
        </>
      )}

      <h3>По файлам</h3>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Файл</th>
              <th scope="col">Свечей</th>
              <th scope="col">В периоде</th>
              <th scope="col">Пропущено</th>
              <th scope="col">Нулевой спред</th>
              <th scope="col">Медиана спреда</th>
              <th scope="col">Закрытие Пт 17:00 NY</th>
            </tr>
          </thead>
          <tbody>
            {report.series.map((series) => (
              <tr key={series.file}>
                <th scope="row">{series.file}</th>
                <td>{series.present ? count(series.rows) : "нет файла"}</td>
                <td>{series.usedRows === null ? "—" : count(series.usedRows)}</td>
                <td>
                  {series.usedRows === null
                    ? "—"
                    : `${count(series.missingBars)} (${share(series.missingShare)})`}
                </td>
                <td>{series.spread === null ? "—" : share(series.spread.zeroShare)}</td>
                <td>{series.spread === null ? "—" : `${series.spread.medianPoints} п.`}</td>
                <td>
                  {series.weeks === null
                    ? "—"
                    : `${series.weeks.closeOk} из ${series.weeks.total}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.consistency.length > 0 && (
        <>
          <h3>Согласованность таймфреймов</h3>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Сверка</th>
                  <th scope="col">Сверено свечей</th>
                  <th scope="col">Расхождений по ценам</th>
                  <th scope="col">Свечей без пары</th>
                </tr>
              </thead>
              <tbody>
                {report.consistency.map((item) => (
                  <tr key={`${item.symbol}-${item.higher}`}>
                    <th scope="row">
                      {item.symbol}: {item.lower} → {item.higher}
                    </th>
                    <td>{count(item.compared)}</td>
                    <td>{count(item.mismatches)}</td>
                    <td>{count(item.higherWithoutLower + item.lowerWithoutHigher)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {m15.length > 0 && (
        <>
          <h3>Спред M15 по годам</h3>
          <p className="muted">
            Среднее в пунктах и доля свечей с нулевым спредом. В колонке MT5 — минимальный
            спред за свечу, поэтому реальные издержки выше.
          </p>
          <div className="card table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Год</th>
                  {m15.map((series) => (
                    <th scope="col" key={series.symbol}>
                      {series.symbol}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {years.map((year) => (
                  <tr key={year}>
                    <th scope="row">{year}</th>
                    {m15.map((series) => {
                      const entry = series.spread?.byYear.find((item) => item.year === year);
                      return (
                        <td key={series.symbol}>
                          {entry === undefined
                            ? "—"
                            : `${entry.meanPoints.toFixed(1)} · ${share(entry.zeroShare)}`}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {warnings.length > 0 && (
        <details>
          <summary>Предупреждения ({warnings.length})</summary>
          <IssueList issues={warnings} />
        </details>
      )}
      {notes.length > 0 && (
        <details>
          <summary>К сведению ({notes.length})</summary>
          <IssueList issues={notes} />
        </details>
      )}
    </>
  );
}

export function ValidationSection() {
  const [state, setState] = useState<State>({ status: "idle" });

  async function run(): Promise<void> {
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/data/validate", { cache: "no-store" });
      const body = (await response.json()) as ValidationReport | { error: string };
      if ("error" in body) {
        setState({ status: "failed", message: body.error });
      } else {
        setState({ status: "done", report: body });
      }
    } catch {
      setState({ status: "failed", message: "Не удалось получить результат проверки." });
    }
  }

  return (
    <section>
      <h2>Проверка</h2>
      <div className="toolbar">
        <button
          type="button"
          className="button"
          onClick={() => void run()}
          disabled={state.status === "loading"}
        >
          {state.status === "loading" ? "Проверяю…" : "Проверить данные"}
        </button>
        <span className="muted">
          То же, что <code>npm run validate</code>. Занимает несколько секунд.
        </span>
      </div>
      {state.status === "failed" && <div className="card error">{state.message}</div>}
      {state.status === "done" && <Report report={state.report} />}
    </section>
  );
}
