"use client";

import { useEffect, useRef, useState } from "react";
import type * as LW from "lightweight-charts";
import type { ChartBar, ChartOrder, ChartTrade, NewsItem } from "../_lib/api-types";
import {
  barAtOrBefore,
  exitBarIndex,
  lanes,
  withGaps,
  type ChannelPoint,
  type Segment,
  type SwingLevel,
} from "../_lib/chart-math";

/** Indicator values per displayed bar; null when switched off. */
export interface Studies {
  readonly smaFast: readonly number[] | null;
  readonly smaSlow: readonly number[] | null;
  readonly rsi: { readonly period: number; readonly values: readonly number[] } | null;
  readonly channel: readonly (ChannelPoint | null)[] | null;
  readonly swings: readonly SwingLevel[] | null;
}

export interface Focus {
  /** UTC seconds to centre the view on. */
  readonly time: number;
  /** Changes on every request, so the same trade can be focused twice. */
  readonly token: number;
}

type Time = LW.UTCTimestamp;

export const SMA_FAST_COLOR = "#e8a33d";
export const SMA_SLOW_COLOR = "#b36bd6";
export const CHANNEL_COLOR = "#2a9db5";
const RSI_COLOR = "#7e57c2";
export const NEWS_COLORS: Readonly<Record<NewsItem["importance"], string>> = {
  HIGH: "#e0544f",
  MODERATE: "#e8a33d",
  LOW: "#8a8f98",
  NONE: "#8a8f98",
};
const MOMENT_COLOR = "#8a8f98";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function useColorScheme(): string {
  const [scheme, setScheme] = useState("light");
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = (): void => setScheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return scheme;
}

/** Why an unfilled order went, in a few words: the engine's own sentence is too long for a chart label. */
function shortEnd(detail: string): string {
  if (/^цена дошла до \d/.test(detail)) return "уровень отмены";
  if (detail.includes("не работал")) return "ночь или новость";
  if (detail.startsWith("не исполнен")) return "срок вышел";
  if (detail.startsWith("заменён")) return "заменён новым";
  if (detail.startsWith("набор закончился")) return "конец данных";
  return detail;
}

const EXIT_LABELS: Record<ChartTrade["exitReason"], string> = {
  stop: "стоп",
  take: "тейк",
  strategy: "выход",
  "end-of-data": "конец данных",
  breakeven: "безубыток",
};

/**
 * TradingView-like chart on lightweight-charts: candles, moving averages,
 * the levels our strategies trade, RSI in its own pane, horizontal lines the
 * user draws, and a run's trades with their level and key moments. The time
 * axis shows broker server time, as MT5 does. Scrolling to an edge asks the
 * parent for more bars; the view stays where it was when they arrive.
 */
export function ProChart(props: {
  bars: readonly ChartBar[];
  /** Changes with the symbol, timeframe or a fresh load: the view is reset then. */
  dataKey: string;
  digits: number;
  intraday: boolean;
  studies: Studies;
  trades: readonly ChartTrade[];
  /** Resting orders of the run that were never filled (TZ 17.15). */
  orders: readonly ChartOrder[];
  /** Economic calendar releases to flag above the candles. */
  news: readonly NewsItem[];
  lines: readonly number[];
  drawing: boolean;
  focus: Focus | null;
  onAddLine: (price: number) => void;
  onHover: (index: number | null) => void;
  onEdge: (side: "older" | "newer") => void;
}) {
  const { bars, dataKey, digits, intraday, studies, trades, orders, news, lines, focus } = props;
  const container = useRef<HTMLDivElement>(null);
  const library = useRef<typeof LW | null>(null);
  const chartRef = useRef<LW.IChartApi | null>(null);
  const candlesRef = useRef<LW.ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<LW.ISeriesMarkersPluginApi<LW.Time> | null>(null);
  const extras = useRef<LW.ISeriesApi<LW.SeriesType>[]>([]);
  const priceLines = useRef<LW.IPriceLine[]>([]);
  const indexByTime = useRef(new Map<number, number>());
  const shown = useRef<{ key: string; firstServerTime: number } | null>(null);
  const appliedFocus = useRef<number | null>(null);
  const quiet = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const scheme = useColorScheme();

  // The chart lives as long as the component; data changes update it in place.
  useEffect(() => {
    const element = container.current;
    if (element === null) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void import("lightweight-charts").then((lw) => {
      if (disposed) return;
      library.current = lw;
      const chart = lw.createChart(element, {
        width: element.clientWidth,
        height: element.clientHeight,
        crosshair: { mode: lw.CrosshairMode.Normal },
        timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6 },
        localization: { locale: "ru-RU" },
      });
      const candles = chart.addSeries(lw.CandlestickSeries, { borderVisible: false });
      markersRef.current = lw.createSeriesMarkers(candles, []);
      const observer = new ResizeObserver(() => {
        const { clientWidth, clientHeight } = element;
        if (clientWidth > 0 && clientHeight > 0) chart.resize(clientWidth, clientHeight);
      });
      observer.observe(element);
      chart.subscribeCrosshairMove((param) => {
        const index = typeof param.time === "number" ? indexByTime.current.get(param.time) : undefined;
        latest.current.onHover(index ?? null);
      });
      chart.subscribeClick((param) => {
        if (!latest.current.drawing || param.point === undefined || (param.paneIndex ?? 0) !== 0) return;
        const price = candles.coordinateToPrice(param.point.y);
        if (price !== null) latest.current.onAddLine(price);
      });
      chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range === null || quiet.current) return;
        const count = latest.current.bars.length;
        if (count === 0) return;
        if (range.from < 15) latest.current.onEdge("older");
        if (range.to > count - 15) latest.current.onEdge("newer");
      });
      chartRef.current = chart;
      candlesRef.current = candles;
      setReady(true);
      cleanup = () => {
        observer.disconnect();
        chart.remove();
        chartRef.current = null;
        candlesRef.current = null;
        markersRef.current = null;
        extras.current = [];
        priceLines.current = [];
      };
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  // Colours follow the light or dark theme of the page.
  useEffect(() => {
    const chart = chartRef.current;
    const lw = library.current;
    if (!ready || chart === null || lw === null) return;
    const border = cssVar("--border");
    chart.applyOptions({
      layout: {
        background: { type: lw.ColorType.Solid, color: cssVar("--surface") },
        textColor: cssVar("--text"),
        panes: { separatorColor: border },
      },
      grid: { vertLines: { color: border }, horzLines: { color: border } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border },
    });
    const up = cssVar("--good");
    const down = cssVar("--danger");
    candlesRef.current?.applyOptions({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down });
  }, [ready, scheme]);

  // Bars, indicators, levels and trades.
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candlesRef.current;
    const lw = library.current;
    if (!ready || chart === null || candles === null || lw === null) return;
    quiet.current = true;
    const range = chart.timeScale().getVisibleLogicalRange();
    for (const series of extras.current) chart.removeSeries(series);
    extras.current = [];
    while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
    setProblem(null);

    candles.applyOptions({ priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits } });
    chart.applyOptions({ timeScale: { timeVisible: intraday } });
    const at = (index: number): Time => (bars[index] as ChartBar).serverTime as Time;
    indexByTime.current = new Map(bars.map((bar, index) => [bar.serverTime, index]));
    try {
      candles.setData(
        bars.map((bar) => ({ time: bar.serverTime as Time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })),
      );
    } catch {
      setProblem("График не построен: свечи идут не по порядку или повторяются.");
      quiet.current = false;
      return;
    }

    const good = cssVar("--good");
    const bad = cssVar("--danger");
    const accent = cssVar("--accent");
    const line = (
      values: readonly (number | null | undefined)[],
      options: LW.LineSeriesPartialOptions,
      pane = 0,
    ): LW.ISeriesApi<"Line"> => {
      const series = chart.addSeries(
        lw.LineSeries,
        { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...options },
        pane,
      );
      series.setData(
        values.map((value, index) =>
          value === null || value === undefined || Number.isNaN(value) ? { time: at(index) } : { time: at(index), value },
        ),
      );
      extras.current.push(series);
      return series;
    };
    const segments = (list: Segment[], options: LW.LineSeriesPartialOptions): void => {
      for (const row of lanes(list, bars.length)) {
        const points = withGaps(row);
        if (points === null) continue;
        const series = chart.addSeries(lw.LineSeries, {
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          ...options,
        });
        series.setData(
          points.map((point, index) =>
            point.gap ? { time: at(index), value: point.value, color: "transparent" } : { time: at(index), value: point.value },
          ),
        );
        extras.current.push(series);
      }
    };

    if (bars.length > 0) {
      if (studies.smaFast !== null) line(studies.smaFast, { color: SMA_FAST_COLOR, lineWidth: 2 });
      if (studies.smaSlow !== null) line(studies.smaSlow, { color: SMA_SLOW_COLOR, lineWidth: 2 });
      if (studies.channel !== null) {
        const options = { color: CHANNEL_COLOR, lineType: lw.LineType.WithSteps };
        line(studies.channel.map((point) => point?.high), options);
        line(studies.channel.map((point) => point?.low), options);
      }
      if (studies.swings !== null) {
        const dashed = { lineStyle: lw.LineStyle.Dashed, lineWidth: 2 as const };
        const of = (kind: SwingLevel["kind"]): Segment[] =>
          (studies.swings ?? [])
            .filter((level) => level.kind === kind)
            .map((level) => ({ from: level.index, to: level.endIndex, value: level.price }));
        segments(of("high"), { ...dashed, color: bad });
        segments(of("low"), { ...dashed, color: good });
      }

      // Trades: entry arrow, exit dot, stop and take while open, the level and
      // the moments the strategy named, and the trend line of ThreeTouch.
      const first = bars[0] as ChartBar;
      const last = bars[bars.length - 1] as ChartBar;
      const markers: LW.SeriesMarker<Time>[] = [];
      const stops: Segment[] = [];
      const takes: Segment[] = [];
      const levels: Segment[] = [];
      const wins: Segment[] = [];
      const losses: Segment[] = [];
      const price = (value: number): string => value.toFixed(digits);
      const indexOf = (time: number): number => (time < first.time ? -1 : barAtOrBefore(bars, time));
      for (const trade of trades) {
        if (trade.exitTime < first.time || trade.entryTime > last.time) continue;
        const buy = trade.direction === "BUY";
        const entry = indexOf(trade.entryTime);
        const exit = trade.exitTime > last.time ? -1 : exitBarIndex(bars, indexOf(trade.exitTime), trade, digits);
        const from = entry === -1 ? 0 : entry;
        const to = exit === -1 ? bars.length - 1 : exit;
        // Entry and exit sit exactly at their prices, joined by a line in the
        // colour of the result, so the exit point is easy to find.
        const won = trade.netPnlUsd >= 0;
        if (entry !== -1) {
          markers.push({
            time: at(entry),
            position: buy ? "atPriceBottom" : "atPriceTop",
            price: trade.entryPrice,
            shape: buy ? "arrowUp" : "arrowDown",
            color: accent,
            text: `#${trade.n} ${buy ? "BUY" : "SELL"} ${price(trade.entryPrice)}`,
          });
        }
        if (exit !== -1) {
          markers.push({
            time: at(exit),
            position: "atPriceMiddle",
            price: trade.exitPrice,
            shape: "circle",
            color: won ? good : bad,
            text: `выход: ${EXIT_LABELS[trade.exitReason]} ${price(trade.exitPrice)} (${trade.rMultiple >= 0 ? "+" : ""}${trade.rMultiple.toFixed(2)}R)`,
          });
        }
        if (to > from) {
          // A trade cut by the edge of the loaded bars is drawn up to the edge,
          // at the price its line would have there.
          const total = trade.exitTime - trade.entryTime;
          const priceAt = (time: number): number =>
            total > 0 ? trade.entryPrice + ((trade.exitPrice - trade.entryPrice) * (time - trade.entryTime)) / total : trade.entryPrice;
          const startValue = entry === -1 ? priceAt((bars[from] as ChartBar).time) : trade.entryPrice;
          const endValue = exit === -1 ? priceAt((bars[to] as ChartBar).time) : trade.exitPrice;
          (won ? wins : losses).push({ from, to, value: startValue, valueTo: endValue });
        }
        stops.push({ from, to, value: trade.stopLoss });
        if (trade.takeProfit !== null) takes.push({ from, to, value: trade.takeProfit });
        // The part closed on the way to the take (TZ 17.10): a dot at its price.
        if (trade.partialTime !== null && trade.partialPrice !== null && trade.partialTime <= last.time) {
          const partial = indexOf(trade.partialTime);
          if (partial !== -1) {
            markers.push({
              time: at(partial),
              position: "atPriceMiddle",
              price: trade.partialPrice,
              shape: "circle",
              color: good,
              text: `часть закрыта ${price(trade.partialPrice)}`,
            });
          }
        }
        for (const moment of trade.marks.moments) {
          const index = indexOf(moment.time);
          if (index === -1 || moment.time > last.time) continue;
          markers.push({
            time: at(index),
            position: buy ? "aboveBar" : "belowBar",
            shape: "square",
            color: MOMENT_COLOR,
            text: moment.label,
          });
        }
        if (trade.marks.level !== null) {
          const starts = [trade.marks.levelFrom, ...trade.marks.moments.map((moment) => moment.time)]
            .filter((time): time is number => time !== null)
            .map(indexOf)
            .filter((index) => index !== -1);
          const start = Math.min(from, ...starts);
          levels.push({ from: Math.min(start, to - 1), to, value: trade.marks.level });
        }
        const points = (trade.marks.trendLine ?? [])
          .map((point) => ({ index: indexOf(point.time), price: point.price }))
          .filter((point) => point.index !== -1);
        if (points.length >= 2) {
          const trend = chart.addSeries(lw.LineSeries, {
            color: accent,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          const unique = points.filter((point, k) => k === 0 || point.index > (points[k - 1] as { index: number }).index);
          trend.setData(unique.map((point) => ({ time: at(point.index), value: point.price })));
          extras.current.push(trend);
        }
      }
      // Orders that were never filled (TZ 17.15): the order price from the bar
      // its level comes from to the bar where the order went, and a square there.
      const unfilled: Segment[] = [];
      for (const order of orders) {
        if (order.endTime < first.time || order.placedTime > last.time) continue;
        const placed = indexOf(order.placedTime);
        const end = order.endTime > last.time ? bars.length - 1 : indexOf(order.endTime);
        const origin = order.marks.levelFrom === null ? -1 : indexOf(order.marks.levelFrom);
        const from = Math.max(0, Math.min(...[placed, origin].filter((index) => index !== -1), end));
        if (end > from) unfilled.push({ from, to: end, value: order.price });
        if (order.endTime <= last.time && end !== -1) {
          markers.push({
            time: at(end),
            position: "atPriceMiddle",
            price: order.price,
            shape: "square",
            color: MOMENT_COLOR,
            text: `${order.direction === "BUY" ? "buy" : "sell"} ${order.kind} снят: ${shortEnd(order.detail)}`,
          });
        }
      }
      // Calendar releases: one flag per bar and currency, coloured by importance.
      const flagged = new Set<string>();
      for (const item of news) {
        if (item.time > last.time + (bars.length > 1 ? last.time - (bars[bars.length - 2] as ChartBar).time : 0)) continue;
        const index = indexOf(item.time);
        if (index === -1) continue;
        const key = `${index}|${item.currency}`;
        if (flagged.has(key)) continue;
        flagged.add(key);
        markers.push({
          time: at(index),
          position: "aboveBar",
          shape: "circle",
          color: NEWS_COLORS[item.importance],
          text: item.currency,
          size: 0.7,
        });
      }
      segments(stops, { color: bad, lineStyle: lw.LineStyle.Dashed });
      segments(takes, { color: good, lineStyle: lw.LineStyle.Dashed });
      segments(levels, { color: accent, lineStyle: lw.LineStyle.Dotted, lineWidth: 2 });
      segments(unfilled, { color: MOMENT_COLOR, lineStyle: lw.LineStyle.Dotted, lineWidth: 2 });
      segments(wins, { color: good, lineStyle: lw.LineStyle.SparseDotted, lineWidth: 2 });
      segments(losses, { color: bad, lineStyle: lw.LineStyle.SparseDotted, lineWidth: 2 });
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      markersRef.current?.setMarkers(markers);

      if (studies.rsi !== null) {
        const rsi = line(studies.rsi.values, { color: RSI_COLOR, lineWidth: 2, lastValueVisible: true }, 1);
        const edge = studies.rsi.period <= 2 ? 5 : 30;
        const muted = cssVar("--muted");
        for (const price of [edge, 100 - edge]) {
          rsi.createPriceLine({ price, color: muted, lineWidth: 1, lineStyle: lw.LineStyle.Dashed, axisLabelVisible: true, title: "" });
        }
        chart.panes()[1]?.setHeight(130);
      }
    } else {
      markersRef.current?.setMarkers([]);
    }

    // Keep the view: a fresh load shows the latest bars; bars added on the
    // left shift the view by their number so nothing jumps.
    const previous = shown.current;
    const timeScale = chart.timeScale();
    if (bars.length > 0) {
      if (previous === null || previous.key !== dataKey || range === null) {
        timeScale.setVisibleLogicalRange({ from: Math.max(0, bars.length - 160), to: bars.length + 4 });
      } else {
        const shift = bars.findIndex((bar) => bar.serverTime >= previous.firstServerTime);
        if (shift > 0) timeScale.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift });
      }
      shown.current = { key: dataKey, firstServerTime: (bars[0] as ChartBar).serverTime };
    }
    const release = window.setTimeout(() => {
      quiet.current = false;
    }, 150);
    return () => window.clearTimeout(release);
  }, [ready, bars, dataKey, digits, intraday, studies, trades, orders, news]);

  // Centre on a requested moment once its bar is loaded.
  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || chart === null || focus === null || appliedFocus.current === focus.token || bars.length === 0) return;
    const first = bars[0] as ChartBar;
    const last = bars[bars.length - 1] as ChartBar;
    if (focus.time < first.time || focus.time > last.time) return;
    appliedFocus.current = focus.token;
    const index = barAtOrBefore(bars, focus.time);
    quiet.current = true;
    chart.timeScale().setVisibleLogicalRange({ from: index - 70, to: index + 50 });
    const release = window.setTimeout(() => {
      quiet.current = false;
    }, 150);
    return () => window.clearTimeout(release);
  }, [ready, focus, bars]);

  // Horizontal lines drawn by the user.
  useEffect(() => {
    const candles = candlesRef.current;
    const lw = library.current;
    if (!ready || candles === null || lw === null) return;
    for (const priceLine of priceLines.current) candles.removePriceLine(priceLine);
    const color = cssVar("--accent");
    priceLines.current = lines.map((price) =>
      candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: lw.LineStyle.Solid, axisLabelVisible: true, title: "" }),
    );
  }, [ready, lines, scheme]);

  return (
    <div className={props.drawing ? "pro-chart-wrap drawing" : "pro-chart-wrap"}>
      {problem !== null && <p className="note bad">{problem}</p>}
      <div ref={container} className="pro-chart" />
    </div>
  );
}
