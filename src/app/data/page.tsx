import {
  ConfigError,
  loadConfig,
  symbolNames,
  TIMEFRAMES,
  type Config,
} from "../../config";
import { listSeriesFiles } from "../_lib/data-store";
import { DataWorkspace } from "./data-workspace";

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
