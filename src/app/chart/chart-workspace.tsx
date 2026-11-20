"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnyTimeframe, SymbolName } from "../../config";
import type { ApiError, BarsResponse, ChartBar, ChartOrder, ChartTrade, NewsItem, NewsResponse, RunResponse, RunSummary } from "../_lib/api-types";
import { aggregateH4, atr, barAtOrBefore, channel, rsiWilder, sma, swingLevels } from "../_lib/chart-math";
import { CHANNEL_COLOR, NEWS_COLORS, ProChart, SMA_FAST_COLOR, SMA_SLOW_COLOR, type Focus, type Studies } from "./pro-chart";
import { GUIDES, guideFor, type StrategyGuide, type ViewTimeframe } from "./strategy-guide";

const VIEW_TIMEFRAMES: readonly ViewTimeframe[] = ["M1", "M5", "M15", "H1", "H4", "D1"];
/** Bars of the file timeframe per request; H4 needs four hours per candle. */
const CHUNK: Record<ViewTimeframe, number> = { M1: 3000, M5: 3000, M15: 3000, H1: 3000, H4: 5000, D1: 3000 };
/** Beyond this many loaded bars the chart stops loading more history. */
const MAX_BARS = 60000;
const LINES_KEY = "algotred-chart-lines";

interface Loaded {
  readonly key: string;
  readonly symbol: SymbolName;
  readonly timeframe: ViewTimeframe;
  readonly bars: readonly ChartBar[];
  readonly offset: number;
  readonly total: number;
  readonly digits: number;
  readonly hiddenFrom: number | null;
}

interface Quote {
  readonly last: number;
  readonly change: number;
  readonly digits: number;
}

const fileTimeframe = (view: ViewTimeframe): AnyTimeframe => (view === "H4" ? "H1" : view);

function group(symbol: string): string {
  if (/^XA[UG]/.test(symbol)) return "Металлы";
  if (/^US(?!D)/.test(symbol)) return "Индексы";
  return "Валюты";
}

function formatServer(seconds: number, intraday: boolean): string {
  const iso = new Date(seconds * 1000).toISOString();
  const day = `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  return intraday ? `${day} ${iso.slice(11, 16)}` : day;
}

/** A calendar figure with MetaQuotes' multiplier (K, M, B, T) and the percent sign. */
function newsValue(item: NewsItem, value: number | null): string {
  if (value === null) return "—";
  const suffix = ["", "K", "M", "B", "T"][item.multiplier] ?? "";
  return `${Number(value.toFixed(3))}${suffix}${item.unit === 1 ? "%" : ""}`;
}

function readLines(): Record<string, number[]> {
  try {
    const raw = window.localStorage.getItem(LINES_KEY);
    const parsed = raw === null ? {} : (JSON.parse(raw) as unknown);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, number[]>) : {};
  } catch {
    return {};
  }
}

function saveLines(lines: Record<string, number[]>): void {
  try {
    window.localStorage.setItem(LINES_KEY, JSON.stringify(lines));
  } catch {
    // Private window or blocked storage: the lines live until the page is reloaded.
  }
}

async function fetchBars(query: URLSearchParams): Promise<BarsResponse> {
  const response = await fetch(`/api/data/bars?${query}`, { cache: "no-store" });
  const body = (await response.json()) as BarsResponse | ApiError;
  if ("error" in body) throw new Error(body.error);
  return body;
}

export function ChartWorkspace({
  symbols,
  timeframes,
  brokerTimeZone,
}: {
  symbols: readonly SymbolName[];
  /** File timeframes present per symbol, M1 and M5 included when exported. */
  timeframes: Readonly<Record<string, readonly AnyTimeframe[]>>;
  brokerTimeZone: string;
}) {
  const [symbol, setSymbol] = useState<SymbolName>(symbols.includes("EURUSD") ? "EURUSD" : (symbols[0] as SymbolName));
  const [view, setView] = useState<ViewTimeframe>("H1");
  const [anchor, setAnchor] = useState<{ around: number | null; date: string | null; token: number }>({
    around: null,
    date: null,
    token: 0,
  });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);

  const [smaFast, setSmaFast] = useState(false);
  const [smaSlow, setSmaSlow] = useState(false);
  const [rsiPeriod, setRsiPeriod] = useState(0);
  const [showChannel, setShowChannel] = useState(false);
  const [showSwings, setShowSwings] = useState(false);

  const [allLines, setAllLines] = useState<Record<string, number[]>>({});
  const [drawing, setDrawing] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const focusToken = useRef(0);

  const [newsMode, setNewsMode] = useState<"none" | "HIGH" | "MODERATE">("HIGH");
  const [news, setNews] = useState<readonly NewsItem[]>([]);
  const [newsProblem, setNewsProblem] = useState<string | null>(null);

  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState("");
  const [run, setRun] = useState<RunResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const pendingFirstTrade = useRef(false);

  useEffect(() => setAllLines(readLines()), []);

  // A fresh window: the latest bars, or around a moment, or from a date.
  // A symbol without M1 or M5 exports falls back to H1.
  useEffect(() => {
    if (!(timeframes[symbol] ?? []).includes(fileTimeframe(view))) setView("H1");
  }, [symbol, view, timeframes]);

  useEffect(() => {
    let cancelled = false;
    const tf = fileTimeframe(view);
    if (!(timeframes[symbol] ?? []).includes(tf)) return;
    const query = new URLSearchParams({ symbol, timeframe: tf, limit: String(CHUNK[view]) });
    if (anchor.around !== null) query.set("around", String(anchor.around));
    else if (anchor.date !== null) query.set("date", anchor.date);
    setLoading(true);
    busy.current = true;
    fetchBars(query)
      .then((body) => {
        if (cancelled) return;
        setError(null);
        setLoaded({
          key: `${symbol}|${view}|${anchor.token}`,
          symbol,
          timeframe: view,
          bars: body.bars,
          offset: body.offset,
          total: body.total,
          digits: body.digits,
          hiddenFrom: body.hiddenFrom,
        });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : "Не удалось загрузить свечи.");
        setLoaded(null);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        busy.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, view, anchor, timeframes]);

  // More history when the chart is scrolled to an edge.
  const onEdge = useCallback(
    (side: "older" | "newer") => {
      const current = loaded;
      if (current === null || busy.current || current.bars.length >= MAX_BARS) return;
      const firstBar = current.bars[0];
      const lastBar = current.bars[current.bars.length - 1];
      if (firstBar === undefined || lastBar === undefined) return;
      if (side === "older" && current.offset === 0) return;
      if (side === "newer" && current.offset + current.bars.length >= current.total) return;
      const chunk = CHUNK[current.timeframe];
      const offset = side === "older" ? Math.max(0, current.offset - chunk) : current.offset + current.bars.length;
      const limit = side === "older" ? current.offset - offset : chunk;
      busy.current = true;
      setLoading(true);
      fetchBars(
        new URLSearchParams({
          symbol: current.symbol,
          timeframe: fileTimeframe(current.timeframe),
          offset: String(offset),
          limit: String(limit),
        }),
      )
        .then((body) => {
          setLoaded((now) => {
            if (now === null || now.key !== current.key) return now;
            const first = now.bars[0] as ChartBar;
            const last = now.bars[now.bars.length - 1] as ChartBar;
            if (side === "older") {
              const added = body.bars.filter((bar) => bar.time < first.time);
              return { ...now, bars: [...added, ...now.bars], offset: now.offset - added.length };
            }
            const added = body.bars.filter((bar) => bar.time > last.time);
            return { ...now, bars: [...now.bars, ...added] };
          });
        })
        .catch(() => {
          // The edge stays where it is; scrolling again retries.
        })
        .finally(() => {
          busy.current = false;
          setLoading(false);
        });
    },
    [loaded],
  );

  // Watchlist: last daily close and its change, at the end of the data we show.
  useEffect(() => {
    let cancelled = false;
    for (const name of symbols) {
      if (!(timeframes[name] ?? []).includes("D1")) continue;
      fetchBars(new URLSearchParams({ symbol: name, timeframe: "D1", limit: "2" }))
        .then((body) => {
          const [previous, last] = body.bars;
          if (cancelled || previous === undefined || last === undefined) return;
          setQuotes((now) => ({
            ...now,
            [name]: { last: last.close, change: (last.close / previous.close - 1) * 100, digits: body.digits },
          }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [symbols, timeframes]);

  useEffect(() => {
    fetch("/api/reports", { cache: "no-store" })
      .then(async (response) => (await response.json()) as RunSummary[] | ApiError)
      .then((body) => setRuns(Array.isArray(body) ? body : []))
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    if (runId === "") {
      setRun(null);
      setRunError(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/reports/run?id=${encodeURIComponent(runId)}`, { cache: "no-store" })
      .then(async (response) => (await response.json()) as RunResponse | ApiError)
      .then((body) => {
        if (cancelled) return;
        if ("error" in body) {
          setRunError(body.error);
          setRun(null);
        } else {
          setRunError(null);
          setRun(body);
        }
      })
      .catch(() => {
        if (!cancelled) setRunError("Не удалось загрузить сделки.");
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const bars = useMemo<readonly ChartBar[]>(() => {
    if (loaded === null) return [];
    return loaded.timeframe === "H4" ? aggregateH4(loaded.bars) : loaded.bars;
  }, [loaded]);

  // Calendar releases over the loaded bars, for the flags and the legend.
  const newsFrom = bars[0]?.time;
  const newsTo = bars[bars.length - 1]?.time;
  useEffect(() => {
    if (newsMode === "none" || newsFrom === undefined || newsTo === undefined) {
      setNews([]);
      return;
    }
    let cancelled = false;
    const query = new URLSearchParams({ symbol, from: String(newsFrom), to: String(newsTo + 86_400), importance: newsMode });
    fetch(`/api/news?${query}`, { cache: "no-store" })
      .then(async (response) => (await response.json()) as NewsResponse | ApiError)
      .then((body) => {
        if (cancelled) return;
        if ("error" in body) {
          setNews([]);
          setNewsProblem(body.error);
        } else {
          setNews(body.items);
          setNewsProblem(body.problem);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [symbol, newsMode, newsFrom, newsTo]);

  const newsByBar = useMemo(() => {
    const map = new Map<number, NewsItem[]>();
    for (const item of news) {
      const index = barAtOrBefore(bars, item.time);
      if (index === -1) continue;
      map.set(index, [...(map.get(index) ?? []), item]);
    }
    return map;
  }, [news, bars]);

  const studies = useMemo<Studies>(() => {
    const closes = bars.map((bar) => bar.close);
    return {
      smaFast: smaFast ? sma(closes, 50) : null,
      smaSlow: smaSlow ? sma(closes, 200) : null,
      rsi: rsiPeriod > 0 ? { period: rsiPeriod, values: rsiWilder(closes, rsiPeriod) } : null,
      channel: showChannel ? channel(bars, 20) : null,
      swings: showSwings ? swingLevels(bars, 10, 120) : null,
    };
  }, [bars, smaFast, smaSlow, rsiPeriod, showChannel, showSwings]);
  const atrValues = useMemo(() => atr(bars, 14), [bars]);

  const trades = useMemo<readonly ChartTrade[]>(
    () => run?.trades.filter((trade) => trade.symbol === symbol) ?? [],
    [run, symbol],
  );
  // Runs saved before unfilled orders were recorded have no such list.
  const orders = useMemo<readonly ChartOrder[]>(
    () => (run?.orders ?? []).filter((order) => order.symbol === symbol),
    [run, symbol],
  );
  const guide = run === null ? undefined : guideFor(run.summary.strategy);

  const focusOn = useCallback(
    (time: number) => {
      focusToken.current += 1;
      setFocus({ time, token: focusToken.current });
      const inside = bars.length > 0 && time >= (bars[0] as ChartBar).time && time <= (bars[bars.length - 1] as ChartBar).time;
      if (!inside) setAnchor((now) => ({ around: time, date: null, token: now.token + 1 }));
    },
    [bars],
  );

  // «Показать на графике» from a guide card: once the run's trades are here, go to the first one.
  useEffect(() => {
    if (!pendingFirstTrade.current || run === null) return;
    const first = trades[0];
    if (first === undefined) return;
    pendingFirstTrade.current = false;
    focusOn(first.entryTime);
  }, [run, trades, focusOn]);

  const applyGuide = (next: StrategyGuide): void => {
    setView(next.timeframe);
    setShowChannel(next.overlay === "channel");
    setShowSwings(next.overlay === "swings");
    if (next.name === "BreakoutRetestV1-B") setSmaSlow(true);
    if (next.name === "Rsi2ReversionD1") setRsiPeriod(2);
  };

  const showExample = (next: StrategyGuide): void => {
    const candidates = runs.filter((item) => item.strategy === next.name);
    const chosen = candidates.find((item) => item.dataset === "dev") ?? candidates[0];
    if (chosen === undefined) return;
    if (symbol !== "EURUSD" && symbols.includes("EURUSD")) setSymbol("EURUSD");
    applyGuide(next);
    pendingFirstTrade.current = true;
    setRunId(chosen.id);
  };

  const lines = allLines[symbol] ?? [];
  const setLines = (next: number[]): void => {
    const all = { ...allLines, [symbol]: next };
    setAllLines(all);
    saveLines(all);
  };
  const addLine = useCallback(
    (price: number) => {
      const digits = loaded?.digits ?? 5;
      const rounded = Number(price.toFixed(digits));
      setAllLines((now) => {
        const all = { ...now, [symbol]: [...(now[symbol] ?? []), rounded] };
        saveLines(all);
        return all;
      });
    },
    [loaded, symbol],
  );

  const digits = loaded?.digits ?? 5;
  const intraday = view !== "D1";
  const shownIndex = hover ?? (bars.length > 0 ? bars.length - 1 : null);
  const shownBar = shownIndex === null ? undefined : bars[shownIndex];
  const value = (series: readonly number[] | null | undefined): string | null => {
    if (series === null || series === undefined || shownIndex === null) return null;
    const v = series[shownIndex];
    return v === undefined || Number.isNaN(v) ? "—" : v.toFixed(digits);
  };
  const groups = [...new Set(symbols.map(group))];
  const strategyNames = [...new Set(runs.map((item) => item.strategy))];

  return (
    <div className="terminal">
      <div className="terminal-main">
        <div className="toolbar terminal-toolbar">
          <label>
            Инструмент
            <select value={symbol} onChange={(event) => setSymbol(event.target.value as SymbolName)}>
              {symbols.map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <div className="segmented" role="group" aria-label="Таймфрейм">
            {VIEW_TIMEFRAMES.map((item) => {
              const available = (timeframes[symbol] ?? []).includes(fileTimeframe(item));
              return (
                <button
                  key={item}
                  type="button"
                  className={item === view ? "active" : undefined}
                  disabled={!available}
                  title={
                    item === "H4"
                      ? "H4 собирается из H1 по времени сервера, как в MT5"
                      : !available
                        ? `Нет выгрузки ${item} для ${symbol}: сохраните её из MT5 в папку данных`
                        : undefined
                  }
                  onClick={() => setView(item)}
                >
                  {item}
                </button>
              );
            })}
          </div>
          <label>
            С даты
            <input
              type="date"
              value={anchor.date ?? ""}
              onChange={(event) =>
                setAnchor((now) => ({ around: null, date: event.target.value === "" ? null : event.target.value, token: now.token + 1 }))
              }
            />
          </label>
          <button
            type="button"
            className="button secondary small"
            onClick={() => setAnchor((now) => ({ around: null, date: null, token: now.token + 1 }))}
          >
            К последним
          </button>
          <span className="muted small-text">{loading ? "Загружаю…" : ""}</span>
        </div>

        <div className="toolbar terminal-toolbar">
          <span className="toolbar-title">Индикаторы</span>
          <label className="chip">
            <input type="checkbox" checked={smaFast} onChange={(event) => setSmaFast(event.target.checked)} />
            <span className="swatch" style={{ background: SMA_FAST_COLOR }} /> SMA 50
          </label>
          <label className="chip">
            <input type="checkbox" checked={smaSlow} onChange={(event) => setSmaSlow(event.target.checked)} />
            <span className="swatch" style={{ background: SMA_SLOW_COLOR }} /> SMA 200
          </label>
          <label>
            RSI
            <select value={rsiPeriod} onChange={(event) => setRsiPeriod(Number(event.target.value))}>
              <option value={0}>нет</option>
              <option value={14}>RSI 14</option>
              <option value={2}>RSI 2</option>
            </select>
          </label>
          <span className="toolbar-title">Уровни</span>
          <label className="chip" title="Максимум и минимум 20 предыдущих свечей — уровень пробоя для BreakoutRetest и FailedBreakout">
            <input type="checkbox" checked={showChannel} onChange={(event) => setShowChannel(event.target.checked)} />
            <span className="swatch" style={{ background: CHANNEL_COLOR }} /> Экстремум 20 свечей
          </label>
          <label className="chip" title="Развороты выше (ниже) 10 свечей с каждой стороны — уровни StrongLevelD1 и точки ThreeTouch">
            <input type="checkbox" checked={showSwings} onChange={(event) => setShowSwings(event.target.checked)} />
            <span className="swatch split" /> Развороты ±10
          </label>
          <label title="События экономического календаря MT5 по валютам инструмента (у золота и индексов — USD)">
            Новости
            <select value={newsMode} onChange={(event) => setNewsMode(event.target.value as typeof newsMode)}>
              <option value="none">не показывать</option>
              <option value="HIGH">важные</option>
              <option value="MODERATE">важные и средние</option>
            </select>
          </label>
          <span className="toolbar-title">Линии</span>
          <button
            type="button"
            className={drawing ? "button small" : "button secondary small"}
            aria-pressed={drawing}
            onClick={() => setDrawing(!drawing)}
          >
            {drawing ? "Кликните по графику…" : "＋ Горизонтальная линия"}
          </button>
          <button type="button" className="button secondary small" disabled={lines.length === 0} onClick={() => setLines(lines.slice(0, -1))}>
            Убрать последнюю
          </button>
          <button type="button" className="button secondary small" disabled={lines.length === 0} onClick={() => setLines([])}>
            Убрать все
          </button>
        </div>

        <div className="toolbar terminal-toolbar">
          <label>
            Сделки стратегии
            <select
              value={runId}
              onChange={(event) => {
                const id = event.target.value;
                setRunId(id);
                const chosen = runs.find((item) => item.id === id);
                const next = chosen === undefined ? undefined : guideFor(chosen.strategy);
                if (next !== undefined) applyGuide(next);
              }}
            >
              <option value="">не показывать</option>
              {strategyNames.map((name) => (
                <optgroup key={name} label={guideFor(name)?.title ?? name}>
                  {runs
                    .filter((item) => item.strategy === name)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.strategy} · {item.dataset} · {item.trades} сд. · {item.id.slice(item.dataset.length + 1, item.dataset.length + 17).replace("_", " ")}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>

        <div className="chart-legend terminal-legend" aria-live="off">
          <strong>
            {symbol} · {view}
          </strong>
          {shownBar !== undefined && (
            <>
              <span>{formatServer(shownBar.serverTime, intraday)}</span>
              <span>O {shownBar.open.toFixed(digits)}</span>
              <span>H {shownBar.high.toFixed(digits)}</span>
              <span>L {shownBar.low.toFixed(digits)}</span>
              <span>C {shownBar.close.toFixed(digits)}</span>
              {value(studies.smaFast) !== null && <span style={{ color: SMA_FAST_COLOR }}>SMA50 {value(studies.smaFast)}</span>}
              {value(studies.smaSlow) !== null && <span style={{ color: SMA_SLOW_COLOR }}>SMA200 {value(studies.smaSlow)}</span>}
              {studies.rsi !== null && shownIndex !== null && (
                <span>
                  RSI{studies.rsi.period} {Number.isNaN(studies.rsi.values[shownIndex] ?? Number.NaN) ? "—" : (studies.rsi.values[shownIndex] as number).toFixed(1)}
                </span>
              )}
              {studies.channel !== null && shownIndex !== null && studies.channel[shownIndex] != null && (
                <span style={{ color: CHANNEL_COLOR }}>
                  20 свечей: {studies.channel[shownIndex]?.high.toFixed(digits)} / {studies.channel[shownIndex]?.low.toFixed(digits)}
                </span>
              )}
              <span className="muted">ATR14 {value(atrValues)}</span>
            </>
          )}
        </div>
        {shownIndex !== null && (newsByBar.get(shownIndex) ?? []).length > 0 && (
          <ul className="news-legend">
            {(newsByBar.get(shownIndex) ?? []).map((item) => (
              <li key={`${item.time}-${item.code}-${item.currency}`}>
                <span className="news-dot" style={{ background: NEWS_COLORS[item.importance] }} />
                <strong>{item.currency}</strong> {formatServer(item.time + ((shownBar?.serverTime ?? 0) - (shownBar?.time ?? 0)), true).slice(11)} {item.name}
                {": "}
                факт {newsValue(item, item.actual)}, прогноз {newsValue(item, item.forecast)}, пред. {newsValue(item, item.previous)}
              </li>
            ))}
          </ul>
        )}
        {newsMode !== "none" && newsProblem !== null && <p className="note bad small-text">Новостей нет: {newsProblem}.</p>}

        {error !== null && <div className="card error">{error}</div>}
        <ProChart
          bars={bars}
          dataKey={loaded?.key ?? ""}
          digits={digits}
          intraday={intraday}
          studies={studies}
          trades={trades}
          orders={orders}
          news={news}
          lines={lines}
          drawing={drawing}
          focus={focus}
          onAddLine={(price) => {
            addLine(price);
            setDrawing(false);
          }}
          onHover={setHover}
          onEdge={onEdge}
        />
        <p className="muted small-text">
          Время на оси — сервера брокера ({brokerTimeZone}), как в MT5. Цены — Bid. Тяните график влево — подгрузится более ранняя
          история. Колёсико — масштаб.
          {loaded?.hiddenFrom != null &&
            ` Свечи с ${formatServer(loaded.hiddenFrom, false)} не показываются: это набор holdout, его не смотрим до финальной проверки.`}
          {trades.length > 0 &&
            " Сделки: стрелка — вход, кружок — выход, красный и зелёный пунктир — стоп и тейк, синие точки — уровень сделки, серые квадраты — моменты, которые назвала стратегия."}
          {orders.length > 0 && " Серая линия с квадратом на конце — ордер, который снят без сделки."}
        </p>

        {runError !== null && <div className="card error">{runError}</div>}
        {run !== null ? (
          <RunPanel run={run} guide={guide} trades={trades} symbol={symbol} digits={digits} brokerTimeZone={brokerTimeZone} onFocus={focusOn} />
        ) : (
          <LevelsGuide runs={runs} onShow={showExample} />
        )}
      </div>

      <aside className="watchlist card" aria-label="Список инструментов">
        {groups.map((name) => (
          <div key={name}>
            <div className="watch-group">{name}</div>
            {symbols
              .filter((item) => group(item) === name)
              .map((item) => {
                const quote = quotes[item];
                return (
                  <button
                    key={item}
                    type="button"
                    className={item === symbol ? "watch-row active" : "watch-row"}
                    onClick={() => setSymbol(item)}
                  >
                    <span className="watch-symbol">{item}</span>
                    <span className="watch-last">{quote === undefined ? "…" : quote.last.toFixed(quote.digits)}</span>
                    <span className={quote === undefined ? "watch-change" : quote.change >= 0 ? "watch-change ok" : "watch-change bad"}>
                      {quote === undefined ? "" : `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%`}
                    </span>
                  </button>
                );
              })}
          </div>
        ))}
        <p className="muted small-text">Последнее дневное закрытие перед набором holdout и изменение за день.</p>
      </aside>
    </div>
  );
}

const EXIT_LABELS: Record<ChartTrade["exitReason"], string> = {
  stop: "стоп",
  take: "тейк",
  strategy: "правило",
  "end-of-data": "конец данных",
  breakeven: "безубыток",
};

function formatInZone(seconds: number, zone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: zone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1000));
}

function RunPanel({
  run,
  guide,
  trades,
  symbol,
  digits,
  brokerTimeZone,
  onFocus,
}: {
  run: RunResponse;
  guide: StrategyGuide | undefined;
  trades: readonly ChartTrade[];
  symbol: string;
  digits: number;
  brokerTimeZone: string;
  onFocus: (time: number) => void;
}) {
  return (
    <section className="run-panel">
      <h2>
        {guide?.title ?? run.summary.strategy} <span className="muted">({run.summary.strategy}, набор {run.summary.dataset})</span>
      </h2>
      {guide !== undefined && (
        <div className="card guide-card">
          <p>{guide.idea}</p>
          <ol>
            {guide.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ol>
          <p className="muted">{guide.result}</p>
        </div>
      )}
      <h3>
        Сделки по {symbol}: {trades.length}
      </h3>
      {trades.length === 0 ? (
        <p className="muted">По этому инструменту сделок в прогоне нет — выберите другой справа.</p>
      ) : (
        <div className="card table-wrap trades-wrap">
          <table className="trades">
            <thead>
              <tr>
                <th>№</th>
                <th>Напр.</th>
                <th>Вход (сервер)</th>
                <th>Цена входа</th>
                <th>Стоп</th>
                <th>Тейк</th>
                <th>Выход (сервер)</th>
                <th>Цена выхода</th>
                <th>Как</th>
                <th>R</th>
                <th>Почему вошла</th>
                <th>Показать</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((trade) => (
                <tr key={trade.n}>
                  <td>{trade.n}</td>
                  <td>{trade.direction}</td>
                  <td>{formatInZone(trade.entryTime, brokerTimeZone)}</td>
                  <td>{trade.entryPrice.toFixed(digits)}</td>
                  <td>{trade.stopLoss.toFixed(digits)}</td>
                  <td>{trade.takeProfit === null ? "—" : trade.takeProfit.toFixed(digits)}</td>
                  <td>{formatInZone(trade.exitTime, brokerTimeZone)}</td>
                  <td>{trade.exitPrice.toFixed(digits)}</td>
                  <td>{EXIT_LABELS[trade.exitReason]}</td>
                  <td className={trade.netPnlUsd >= 0 ? "ok" : "bad"}>
                    {trade.rMultiple >= 0 ? "+" : ""}
                    {trade.rMultiple.toFixed(2)}
                  </td>
                  <td className="reason-cell">{trade.reason}</td>
                  <td className="nowrap">
                    <button type="button" className="button secondary small" onClick={() => onFocus(trade.entryTime)}>
                      Вход
                    </button>{" "}
                    <button type="button" className="button secondary small" onClick={() => onFocus(trade.exitTime)}>
                      Выход
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LevelsGuide({ runs, onShow }: { runs: readonly RunSummary[]; onShow: (guide: StrategyGuide) => void }) {
  const levelGuides = GUIDES.filter((guide) => guide.levels);
  return (
    <section className="run-panel">
      <h2>Как наши стратегии работают от уровней</h2>
      <dl className="concepts card">
        <dt>Уровень поддержки и сопротивления</dt>
        <dd>
          Цена, от которой рынок уже разворачивался. У нас два вида: экстремум 20 свечей (самый высокий максимум и самый низкий
          минимум за 20 предыдущих свечей — включите «Экстремум 20 свечей») и разворот ±10 (свеча, чей максимум выше 10 свечей слева и
          справа, — включите «Развороты ±10»). Над ценой — сопротивление, под ценой — поддержка.
        </dd>
        <dt>Пробой</dt>
        <dd>Свеча закрылась за уровнем, а не просто проколола его тенью. У нас — дальше чем на 0,1 ATR.</dd>
        <dt>Откат (ретест)</dt>
        <dd>
          После пробоя цена возвращается к уровню, касается его и закрывается по сторону пробоя: бывшее сопротивление стало поддержкой.
          На откате входят стратегии «пробой с откатом».
        </dd>
        <dt>Ложный пробой</dt>
        <dd>После пробоя свеча быстро закрылась обратно за уровень. На этом входит FailedBreakoutV1 — в обратную сторону.</dd>
        <dt>ATR</dt>
        <dd>Средний размер свечи за 14 свечей; его значение видно в строке над графиком.</dd>
      </dl>
      <p className="muted">
        Ни одна из этих стратегий не прошла проверку: на истории 2015–2021 годов ни пробой, ни откат, ни ложный пробой не дали
        преимущества после издержек. График нужен, чтобы понять, как они входили, а не чтобы подобрать правила «на глаз».
      </p>
      <div className="guide-grid">
        {levelGuides.map((guide) => {
          const has = runs.some((item) => item.strategy === guide.name);
          return (
            <article key={guide.name} className="card guide-card">
              <h3>{guide.title}</h3>
              <p className="muted small-text">{guide.name}</p>
              <p>{guide.idea}</p>
              <p className="small-text">{guide.result}</p>
              <button type="button" className="button small" disabled={!has || guide.name === "RectangleV1"} onClick={() => onShow(guide)}>
                Показать на графике
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
