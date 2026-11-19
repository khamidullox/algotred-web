import { ConfigError, loadConfig, symbolNames, type Config, type Timeframe } from "../../config";
import { listSeriesFiles } from "../_lib/data-store";
import { ChartWorkspace } from "./chart-workspace";
import "./chart.css";

// Files in the data directory change outside the app: read them on every request.
export const dynamic = "force-dynamic";

export default function ChartPage() {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return (
      <>
        <h1>График</h1>
        <div className="card error">{error.message}</div>
      </>
    );
  }
  const timeframes: Record<string, Timeframe[]> = {};
  for (const file of listSeriesFiles(config)) {
    if (!file.present) continue;
    (timeframes[file.symbol] ??= []).push(file.timeframe);
  }
  const symbols = symbolNames(config).filter((symbol) => (timeframes[symbol] ?? []).length > 0);

  if (symbols.length === 0) {
    return (
      <>
        <h1>График</h1>
        <p className="muted">Нет ни одного файла с барами — загрузите их на странице «Данные».</p>
      </>
    );
  }
  return <ChartWorkspace symbols={symbols} timeframes={timeframes} brokerTimeZone={config.brokerTimeZone} />;
}
