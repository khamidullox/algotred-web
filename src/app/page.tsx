import { ConfigError, loadConfig, type Config } from "../config";

// The config is a local file the user edits by hand: read it on every request.
export const dynamic = "force-dynamic";

function readConfig(): { config: Config } | { error: string } {
  try {
    return { config: loadConfig() };
  } catch (error) {
    if (error instanceof ConfigError) {
      return { error: error.message };
    }
    throw error;
  }
}

function ConfigTable({ config }: { config: Config }) {
  const rows: Array<[label: string, value: string]> = [
    ["Часовой пояс сервера брокера", config.brokerTimeZone],
    ["Папка с CSV", config.dataDir],
    ["Стартовый капитал, USD", String(config.initialCapitalUsd)],
    ["Риск на сделку, %", String(config.riskPerTradePct)],
    ["Минимальный спред, пункты", String(config.costs.minSpreadPoints)],
    [
      "Комиссия за лот (круг), USD",
      String(config.costs.commissionPerLotRoundTrip),
    ],
    ["Проскальзывание, пипсы", String(config.costs.slippagePips)],
    ...Object.entries(config.symbols).map(([symbol, own]): [string, string] => [
      `${symbol}: знаков ${own.digits}, контракт ${own.contractSize}, доллар — ${own.usdSide === "quote" ? "котировка" : "база"}; своп long / short, пипсы`,
      `${own.swapLongPips} / ${own.swapShortPips}` +
        (own.minSpreadPoints !== undefined ? `; спред не ниже ${own.minSpreadPoints} п.` : "") +
        (own.commissionPerLotRoundTrip !== undefined ? `; комиссия ${own.commissionPerLotRoundTrip} USD/лот` : ""),
    ]),
    ["usdExposureLimit", config.usdExposureLimit ? "включён" : "выключен"],
  ];

  return (
    <div className="card table-wrap">
      <table>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function HomePage() {
  const result = readConfig();

  return (
    <>
      <h1>Движок бэктеста — этап 1</h1>
      <p className="lead">
        Готовы чтение и проверка данных. Бэктест и отчёты появятся на
        следующих шагах ТЗ.
      </p>

      <h2>
        Конфигурация (<code>config/default.json</code>)
      </h2>
      {"config" in result ? (
        <ConfigTable config={result.config} />
      ) : (
        <div className="card error">{result.error}</div>
      )}
    </>
  );
}
