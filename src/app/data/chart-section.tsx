"use client";

import { useEffect, useState } from "react";
import type { SymbolName, Timeframe } from "../../config";
import type {
  ApiError,
  BarsResponse,
  ChartTrade,
  RunResponse,
  RunSummary,
} from "../_lib/api-types";
import type { SeriesFile } from "../_lib/data-store";
import { CandleChart, type TimeMode } from "./candle-chart";

const WINDOW = 1000;

/** Where the window starts: the newest bars, a bar index, a server-time date, or centred on an instant. */
type Position =
  | { kind: "latest" }
  | { kind: "offset"; offset: number }
  | { kind: "date"; date: string }
  | { kind: "around"; time: number; trade: number };

const EXIT_LABELS: Record<ChartTrade["exitReason"], string> = {
  stop: "стоп",
  take: "тейк",
  strategy: "правило",
  "end-of-data": "конец данных",
};

/** `dd.MM.yyyy HH:mm` in the given IANA zone, like MT5 shows it. */
function formatInZone(seconds: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(seconds * 1000));
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}.${get("month")}.${get("year")} ${get("hour")}:${get("minute")}`;
}

function runLabel(run: RunSummary): string {
  const when = new Date(run.finishedAt).toLocaleString("ru-RU", {
    dateStyle: "short",
    timeStyle: "short",
  });
  return `${run.strategy} · ${run.dataset} · ${run.trades} сд. · ${when}`;
}

export function ChartSection({
  files,
  brokerTimeZone,
  initialRunId = "",
}: {
  files: SeriesFile[];
  brokerTimeZone: string;
  /** A run to show from the start, e.g. when coming from its report. */
  initialRunId?: string;
}) {
  const available = files.filter((file) => file.present);
  const first = available.find((file) => file.timeframe === "H1") ?? available[0];
  const [symbol, setSymbol] = useState<SymbolName | undefined>(first?.symbol);
  const [timeframe, setTimeframe] = useState<Timeframe | undefined>(first?.timeframe);
  const [position, setPosition] = useState<Position>({ kind: "latest" });
  const [timeMode, setTimeMode] = useState<TimeMode>("server");
  const [data, setData] = useState<BarsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState(initialRunId);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  useEffect(() => {
    if (symbol === undefined || timeframe === undefined) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ symbol, timeframe, limit: String(WINDOW) });
    if (position.kind === "offset") query.set("offset", String(position.offset));
    if (position.kind === "date") query.set("date", position.date);
    if (position.kind === "around") query.set("around", String(position.time));
    setLoading(true);
    fetch(`/api/data/bars?${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => (await response.json()) as BarsResponse | ApiError)
      .then((body) => {
        if ("error" in body) {
          setError(body.error);
          setData(null);
        } else {
          setError(null);
          setData(body);
        }
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError("Не удалось загрузить свечи.");
        setData(null);
        setLoading(false);
      });
    return () => controller.abort();
  }, [symbol, timeframe, position]);

  // Saved runs, for the trade overlay. The list is read once per page load:
  // reload the page after a new `npm run backtest`.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/reports", { cache: "no-store", signal: controller.signal })
      .then(async (response) => (await response.json()) as RunSummary[] | ApiError)
      .then((body) => setRuns(Array.isArray(body) ? body : []))
      .catch(() => setRuns([]));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (runId === "") {
      setRun(null);
      setRunError(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/reports/run?id=${encodeURIComponent(runId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => (await response.json()) as RunResponse | ApiError)
      .then((body) => {
        if ("error" in body) {
          setRunError(body.error);
          setRun(null);
        } else {
          setRunError(null);
          setRun(body);
        }
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setRunError("Не удалось загрузить сделки.");
        setRun(null);
      });
    return () => controller.abort();
  }, [runId]);

  if (first === undefined) {
    return (
      <section>
        <h2>График</h2>
        <p className="muted">Загрузите хотя бы один файл, чтобы увидеть свечи.</p>
      </section>
    );
  }

  const symbols = [...new Set(available.map((file) => file.symbol))];
  const timeframes = available
    .filter((file) => file.symbol === symbol)
    .map((file) => file.timeframe);
  const step = Math.floor(WINDOW / 2);
  const offset = data?.offset ?? 0;
  const total = data?.total ?? 0;
  const trades = run?.trades.filter((trade) => trade.symbol === symbol) ?? [];
  const focusedTrade = position.kind === "around" ? position.trade : null;
  const digits = data?.digits ?? 5;

  return (
    <section>
      <h2>График</h2>
      <div className="toolbar">
        <label>
          Пара
          <select
            value={symbol}
            onChange={(event) => {
              const next = event.target.value as SymbolName;
              setSymbol(next);
              const options = available.filter((file) => file.symbol === next);
              if (!options.some((file) => file.timeframe === timeframe)) {
                setTimeframe(options[0]?.timeframe);
              }
              setPosition({ kind: "latest" });
            }}
          >
            {symbols.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Таймфрейм
          <select
            value={timeframe}
            onChange={(event) => {
              setTimeframe(event.target.value as Timeframe);
              setPosition(
                position.kind === "around" ? position : { kind: "latest" },
              );
            }}
          >
            {timeframes.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Показать с даты
          <input
            type="date"
            value={position.kind === "date" ? position.date : ""}
            onChange={(event) =>
              setPosition(
                event.target.value === ""
                  ? { kind: "latest" }
                  : { kind: "date", date: event.target.value },
              )
            }
          />
        </label>
        <label>
          Время на оси
          <select
            value={timeMode}
            onChange={(event) => setTimeMode(event.target.value as TimeMode)}
          >
            <option value="server">сервер, как в MT5</option>
            <option value="utc">UTC</option>
          </select>
        </label>
        <label>
          Сделки прогона
          <select value={runId} onChange={(event) => setRunId(event.target.value)}>
            <option value="">не показывать</option>
            {runs.map((item) => (
              <option key={item.id} value={item.id}>
                {runLabel(item)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="toolbar">
        <button
          type="button"
          className="button secondary"
          disabled={loading || offset === 0}
          onClick={() => setPosition({ kind: "offset", offset: Math.max(0, offset - step) })}
        >
          ← Раньше
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={loading || offset + WINDOW >= total}
          onClick={() => setPosition({ kind: "offset", offset: offset + step })}
        >
          Позже →
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={loading || offset + WINDOW >= total}
          onClick={() => setPosition({ kind: "latest" })}
        >
          К последним
        </button>
        <span className="muted">
          {data === null
            ? loading
              ? "Загружаю…"
              : ""
            : `Свечи ${(offset + 1).toLocaleString("ru-RU")}–${(offset + data.bars.length).toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")}`}
        </span>
      </div>

      {error !== null && <div className="card error">{error}</div>}
      {data !== null && (
        <CandleChart
          bars={data.bars}
          digits={data.digits}
          intraday={data.timeframe !== "D1"}
          timeMode={timeMode}
          trades={trades}
        />
      )}
      <p className="muted">
        Цены — Bid, как в файле. Сервер брокера живёт по {brokerTimeZone}.
        {data?.hiddenFrom != null &&
          ` Свечи с ${formatInZone(data.hiddenFrom, brokerTimeZone).slice(0, 10)} не показываются: это набор holdout (раздел 6 ТЗ).`}
        {run !== null &&
          " На графике: стрелка — вход, точка — выход, пунктир — стоп (красный) и тейк (зелёный), пока позиция открыта."}
      </p>

      {runError !== null && <div className="card error">{runError}</div>}
      {run !== null && (
        <>
          <h3>
            Сделки {run.summary.strategy} на {run.summary.dataset}, {symbol}: {trades.length}
          </h3>
          {trades.length === 0 ? (
            <p className="muted">По этой паре сделок в прогоне нет.</p>
          ) : (
            <div className="card table-wrap trades-wrap">
              <table className="trades">
                <thead>
                  <tr>
                    <th>№</th>
                    <th>Напр.</th>
                    <th>Вход (сервер)</th>
                    <th>Цена</th>
                    <th>Стоп</th>
                    <th>Тейк</th>
                    <th>Лот</th>
                    <th>Выход (сервер)</th>
                    <th>Цена</th>
                    <th>Как</th>
                    <th>R</th>
                    <th>USD</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => (
                    <tr key={trade.n} className={trade.n === focusedTrade ? "focused" : undefined}>
                      <td>{trade.n}</td>
                      <td>{trade.direction}</td>
                      <td>{formatInZone(trade.entryTime, brokerTimeZone)}</td>
                      <td>{trade.entryPrice.toFixed(digits)}</td>
                      <td>{trade.stopLoss.toFixed(digits)}</td>
                      <td>{trade.takeProfit === null ? "—" : trade.takeProfit.toFixed(digits)}</td>
                      <td>{trade.lots.toFixed(2)}</td>
                      <td>{formatInZone(trade.exitTime, brokerTimeZone)}</td>
                      <td>{trade.exitPrice.toFixed(digits)}</td>
                      <td>{EXIT_LABELS[trade.exitReason]}</td>
                      <td className={trade.netPnlUsd >= 0 ? "ok" : "bad"}>
                        {trade.rMultiple >= 0 ? "+" : ""}
                        {trade.rMultiple.toFixed(2)}
                      </td>
                      <td className={trade.netPnlUsd >= 0 ? "ok" : "bad"}>
                        {trade.netPnlUsd.toFixed(2)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="button secondary small"
                          title={trade.reason}
                          onClick={() =>
                            setPosition({ kind: "around", time: trade.entryTime, trade: trade.n })
                          }
                        >
                          На графике
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">
            Наведите на кнопку «На графике», чтобы увидеть, почему стратегия вошла. Полный список со всеми
            колонками — в <code>reports/{run.summary.id}/trades.csv</code>.
          </p>
        </>
      )}
    </section>
  );
}
