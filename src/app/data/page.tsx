import {
  ConfigError,
  loadConfig,
  symbolNames,
  TIMEFRAMES,
  type Config,
} from "../../config";
import { formatInZone } from "../../data/time";
import { listSeriesFiles } from "../_lib/data-store";
import { defaultLiveDir, getLiveSeries } from "../_lib/live-series";
import { DataWorkspace } from "./data-workspace";

/** What the MT5 indicator has passed on for the charts (TZ 17.52), series by series. */
function LiveStatus({ config }: { config: Config }) {
  const dir = defaultLiveDir();
  const zone = config.brokerTimeZone;
  const rows = symbolNames(config).map((symbol) => ({
    symbol,
    cells: TIMEFRAMES.map((timeframe) => getLiveSeries(dir, symbol, timeframe, zone)),
  }));
  const any = rows.some((row) => row.cells.some((cell) => cell !== null && cell.bars.length > 0));
  return (
    <details className="card" open={any}>
      <summary>Свечи из MetaTrader</summary>
      {any ? (
        <>
          <p className="note">
            Последняя закрытая свеча, которую передал индикатор, по времени сервера. Графики показывают эти свечи после конца
            данных проекта; бэктесты и проверка данных их не используют.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Инструмент</th>
                  {TIMEFRAMES.map((timeframe) => (
                    <th key={timeframe}>{timeframe}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.symbol}>
                    <td>{row.symbol}</td>
                    {row.cells.map((cell, index) => {
                      const last = cell?.bars.at(-1);
                      return (
                        <td key={TIMEFRAMES[index]} className={last === undefined ? "muted" : undefined}>
                          {last === undefined ? "нет" : formatInZone(last.time, zone, TIMEFRAMES[index] === "D1" ? "dd.LL.yyyy" : "dd.LL.yyyy HH:mm")}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="note">
          Пока нет. Их передаёт индикатор <code>Rsi2IndexSignal</code> версии 1.30 и новее, пока MetaTrader 5 открыт и
          индикатор стоит на графике.
        </p>
      )}
    </details>
  );
}

// Files in the data directory change outside the app: read them on every request.
export const dynamic = "force-dynamic";

export default async function DataPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // `/data?run=<id>` opens the page with the trades of that run on the chart.
  const { run } = await props.searchParams;
  const initialRunId = typeof run === "string" ? run : "";
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return (
      <>
        <h1>Данные</h1>
        <div className="card error">{error.message}</div>
      </>
    );
  }

  return (
    <>
      <h1>Данные</h1>
      <p className="lead">
        Экспорт баров из MetaTrader 5 в папке <code>{config.dataDir}</code>.
        Время в файлах — время сервера брокера ({config.brokerTimeZone}),
        внутри программы оно хранится в UTC.
      </p>
      <LiveStatus config={config} />
      <DataWorkspace
        files={listSeriesFiles(config)}
        symbols={symbolNames(config)}
        timeframes={TIMEFRAMES}
        brokerTimeZone={config.brokerTimeZone}
        initialRunId={initialRunId}
      />
    </>
  );
}
