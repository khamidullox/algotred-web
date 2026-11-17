"use client";

import { useEffect, useState } from "react";
import type { SymbolName, Timeframe } from "../../config";
import type { ApiError, BarsResponse } from "../_lib/api-types";
import type { SeriesFile } from "../_lib/data-store";
import { CandleChart, type TimeMode } from "./candle-chart";

const WINDOW = 1000;

/** Where the window starts: the newest bars, a bar index, or a server-time date. */
type Position =
  | { kind: "latest" }
  | { kind: "offset"; offset: number }
  | { kind: "date"; date: string };

export function ChartSection({
  files,
  brokerTimeZone,
}: {
  files: SeriesFile[];
  brokerTimeZone: string;
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

  useEffect(() => {
    if (symbol === undefined || timeframe === undefined) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ symbol, timeframe, limit: String(WINDOW) });
    if (position.kind === "offset") query.set("offset", String(position.offset));
    if (position.kind === "date") query.set("date", position.date);
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
              setPosition({ kind: "latest" });
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
        />
      )}
      <p className="muted">
        Цены — Bid, как в файле. Сервер брокера живёт по {brokerTimeZone}.
      </p>
    </section>
  );
}
