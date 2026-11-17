import Link from "next/link";
import { ConfigError, loadConfig, type Config } from "../../config";
import { money, pct, pf, r } from "../../report/format-report";
import { listReports } from "../_lib/reports-store";

// Runs are written by the CLI outside the app: read the directory on every request.
export const dynamic = "force-dynamic";

export default function ReportsPage() {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return (
      <>
        <h1>Отчёты</h1>
        <div className="card error">{error.message}</div>
      </>
    );
  }

  const items = listReports(config);

  return (
    <>
      <h1>Отчёты</h1>
      <p className="lead">
        Прогоны из папки <code>{config.reportsDir}</code>, новые сверху. Каждый прогон запускается
        командой <code>npm run backtest</code>; сайт только показывает результат.
      </p>

      <h2>Прогоны</h2>
      {items.length === 0 ? (
        <div className="card">
          Прогонов пока нет. Запустите, например:{" "}
          <code>npm run backtest -- --strategy TrendD1 --dataset dev</code>
        </div>
      ) : (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Когда</th>
                <th>Стратегия</th>
                <th>Набор</th>
                <th>Сделок</th>
                <th>Прибыльных</th>
                <th>Средний R</th>
                <th>PF</th>
                <th>Просадка</th>
                <th>Итог, USD</th>
                <th>Вердикт</th>
              </tr>
            </thead>
            <tbody>
              {items.map(({ summary, report }) => (
                <tr key={summary.id}>
                  <td>
                    <Link href={`/reports/${summary.id}`}>
                      {new Date(summary.finishedAt).toLocaleString("ru-RU", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </Link>
                  </td>
                  <td>{summary.strategy}</td>
                  <td>{summary.dataset}</td>
                  <td>{summary.trades}</td>
                  {report === null ? (
                    <td colSpan={6} className="muted">
                      отчёта нет — прогон сделан до шага 6
                    </td>
                  ) : (
                    <>
                      <td>{pct(report.afterCosts.winRate)}</td>
                      <td>{r(report.afterCosts.meanR)}</td>
                      <td>{pf(report.afterCosts.profitFactor)}</td>
                      <td>{pct(report.afterCosts.maxDrawdownPct)}</td>
                      <td className={report.afterCosts.totalUsd >= 0 ? "ok" : "bad"}>
                        {money(report.afterCosts.totalUsd)}
                      </td>
                      <td>
                        <span className={`verdict verdict-${report.verdict.code.toLowerCase()}`}>
                          {report.verdict.code}
                        </span>
                        {!report.verdict.applies && <span className="muted"> справочно</span>}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">
        Прогоны на <code>dev</code> в git не хранятся; прогоны на <code>test</code> и{" "}
        <code>holdout</code> записаны и в <code>EXPERIMENTS.md</code>.
      </p>
    </>
  );
}
