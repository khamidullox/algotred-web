import Link from "next/link";
import type { Report } from "../../../../report/build-report";
import { money, pct, pf, r } from "../../../../report/format-report";
import type { BreakdownRow, MetricsBlock } from "../../../../report/metrics";

const STATUS_LABELS = {
  continue: "продолжаем",
  reject: "отклоняем",
  between: "между",
  unknown: "нет данных",
} as const;

const SKIP_LABELS = {
  "position-open": "позиция уже открыта",
  "no-next-bar": "нет следующей свечи",
  "gap-after-signal": "гэп после сигнала",
  "usd-exposure": "лимит по доллару",
  "invalid-levels": "стоп или тейк не с той стороны",
  "stop-too-far": "стоп слишком далеко",
  "lot-too-small": "лот меньше 0.01",
} as const;

function MetricsHead() {
  return (
    <tr>
      <th></th>
      <th>Сделок</th>
      <th>Прибыльных</th>
      <th>Средний R</th>
      <th>PF</th>
      <th>Просадка</th>
      <th>Серия убытков</th>
      <th>Итог, USD</th>
    </tr>
  );
}

function MetricsRow({ label, block }: { label: string; block: MetricsBlock }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{block.trades}</td>
      <td>{pct(block.winRate)}</td>
      <td>{r(block.meanR)}</td>
      <td>{pf(block.profitFactor)}</td>
      <td>{pct(block.maxDrawdownPct)}</td>
      <td>{block.longestLosingStreak}</td>
      <td className={block.totalUsd >= 0 ? "ok" : "bad"}>{money(block.totalUsd)}</td>
    </tr>
  );
}

function MetricsTable({ rows }: { rows: ReadonlyArray<readonly [string, MetricsBlock]> }) {
  return (
    <div className="card table-wrap">
      <table>
        <thead>
          <MetricsHead />
        </thead>
        <tbody>
          {rows.map(([label, block]) => (
            <MetricsRow key={label} label={label} block={block} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: readonly BreakdownRow[] }) {
  return (
    <>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">Сделок нет.</p>
      ) : (
        <MetricsTable rows={rows.map((row) => [row.key, row.metrics] as const)} />
      )}
    </>
  );
}

export function ReportView({ id, report }: { id: string; report: Report }) {
  const main = report.afterCosts;
  const finished = new Date(report.finishedAt).toLocaleString("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  });

  return (
    <>
      <h1>
        {report.strategy} на наборе {report.dataset}
      </h1>
      <p className="lead">
        Период {report.days.firstDay} — {report.days.lastDay} ({report.days.days} дн., дни сервера{" "}
        {report.brokerTimeZone}). Прогон {finished}. Капитал {money(report.initialCapitalUsd)} USD,
        риск {report.riskPerTradePct}% на сделку. Издержки: спред не меньше{" "}
        {report.costs.minSpreadPoints} п., комиссия {report.costs.commissionPerLotRoundTrip} USD/лот,
        проскальзывание {report.costs.slippagePips} пипс, лимит по доллару{" "}
        {report.usdExposureLimit ? "включён" : "выключен"}.
      </p>
      <p>
        <Link href={`/data?run=${encodeURIComponent(id)}`}>Сделки на графике</Link> ·{" "}
        <code>reports/{id}/</code>: report.md, trades.csv, run.json
      </p>
      {report.warnings.length > 0 && (
        <ul className="issues">
          {report.warnings.map((warning) => (
            <li key={warning} className="bad">
              {warning}
            </li>
          ))}
        </ul>
      )}

      <h2>
        Вердикт:{" "}
        <span className={`verdict verdict-${report.verdict.code.toLowerCase()}`}>
          {report.verdict.code}
        </span>
      </h2>
      <p className="muted">{report.verdict.note}</p>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>Метрика</th>
              <th>Значение</th>
              <th>Продолжаем</th>
              <th>Отклоняем</th>
              <th>Итог</th>
            </tr>
          </thead>
          <tbody>
            {report.verdict.criteria.map((criterion) => (
              <tr key={criterion.name}>
                <th scope="row">{criterion.name}</th>
                <td>{criterion.value}</td>
                <td>{criterion.continueRule}</td>
                <td>{criterion.rejectRule}</td>
                <td className={`status-${criterion.status}`}>{STATUS_LABELS[criterion.status]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Итог</h2>
      <MetricsTable
        rows={[
          ["После издержек", main],
          ["До издержек", report.beforeCosts],
          [`Стресс-тест (издержки × ${report.stress.costMultiplier})`, report.stress.afterCosts],
        ]}
      />
      <dl className="facts">
        <div>
          <dt>Математическое ожидание</dt>
          <dd>
            {r(main.expectancyR)} R, в среднем {main.meanUsd === null ? "—" : money(main.meanUsd)} USD на
            сделку
          </dd>
        </div>
        <div>
          <dt>Баланс</dt>
          <dd>
            {money(report.initialCapitalUsd)} → {money(main.finalBalance)} USD, просадка{" "}
            {money(main.maxDrawdownUsd)} USD
          </dd>
        </div>
        <div>
          <dt>Издержки, USD</dt>
          <dd>
            спред {money(report.costTotals.spreadUsd)}, проскальзывание{" "}
            {money(report.costTotals.slippageUsd)}, комиссия {money(report.costTotals.commissionUsd)},
            своп {money(report.costTotals.swapUsd)}
          </dd>
        </div>
        <div>
          <dt>95% интервал среднего R</dt>
          <dd>
            {report.bootstrap === null
              ? "нет сделок"
              : `${r(report.bootstrap.lower)} … ${r(report.bootstrap.upper)} (bootstrap, ${report.bootstrap.repeats.toLocaleString("ru-RU")} повторов)`}
          </dd>
        </div>
        {report.skipped.length > 0 && (
          <div>
            <dt>Пропущено сигналов</dt>
            <dd>
              {report.skipped.map((item) => `${SKIP_LABELS[item.reason]} ${item.count}`).join(", ")}
            </dd>
          </div>
        )}
      </dl>

      <h2>Лимит по доллару</h2>
      <MetricsTable
        rows={[
          ["С лимитом", report.exposure.withLimit],
          ["Без лимита", report.exposure.withoutLimit],
        ]}
      />
      <p className="muted">С лимитом пропущено сигналов: {report.exposure.skippedByLimit}.</p>

      <Breakdown title="По парам" rows={report.bySymbol} />
      <Breakdown title="По годам входа (UTC)" rows={report.byYear} />
      <Breakdown title="По часу входа (UTC)" rows={report.byHourUtc} />
      <Breakdown
        title={`По дню недели входа (время сервера ${report.brokerTimeZone})`}
        rows={report.byWeekday}
      />

      <h2>Окно заказчика и фильтры по времени</h2>
      <MetricsTable
        rows={[
          ["Вход 19:00–21:00 Asia/Tashkent", report.customerWindow],
          ["Без понедельника до 12:00 Europe/London", report.withoutMondayMorning],
          ["Без пятницы после 12:00 Europe/London", report.withoutFridayAfternoon],
          ["Без того и другого", report.withoutBoth],
        ]}
      />
      <p className="muted">
        Просадка в строках-подмножествах пересчитана по тем же сделкам от стартового капитала: лоты
        считались на полном прогоне.
      </p>

      <h2>Параметры</h2>
      <div className="card table-wrap">
        <table>
          <tbody>
            {Object.entries(report.params).map(([key, value]) => (
              <tr key={key}>
                <th scope="row">{key}</th>
                <td>{String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
