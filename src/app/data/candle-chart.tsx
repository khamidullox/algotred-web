"use client";

import { useEffect, useRef, useState } from "react";
import type { ChartBar, ChartTrade } from "../_lib/api-types";

export type TimeMode = "server" | "utc";

const EXIT_LABELS: Record<ChartTrade["exitReason"], string> = {
  stop: "стоп",
  take: "тейк",
  strategy: "выход",
  "end-of-data": "конец данных",
};

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

/** Index of the last bar that opens at or before `time` (UTC seconds), or -1. */
function barAtOrBefore(bars: ChartBar[], time: number): number {
  let low = 0;
  let high = bars.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((bars[middle] as ChartBar).time <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * Candlestick chart with the trades of a run drawn over it: an arrow at the
 * entry, a dot at the exit, dashed lines for the stop and the take while the
 * position was open. The library draws its time axis in UTC, so to show broker
 * server time the bars are passed with a pre-shifted timestamp.
 */
export function CandleChart({
  bars,
  digits,
  intraday,
  timeMode,
  trades,
}: {
  bars: ChartBar[];
  digits: number;
  intraday: boolean;
  timeMode: TimeMode;
  trades: ChartTrade[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const scheme = useColorScheme();
  const [hover, setHover] = useState<ChartBar | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const element = container.current;
    if (element === null || bars.length === 0) return;
    let disposed = false;
    let remove: (() => void) | undefined;
    setProblem(null);
    setHover(null);

    void import("lightweight-charts").then((library) => {
      if (disposed) return;
      type Time = import("lightweight-charts").UTCTimestamp;
      const border = cssVar("--border");
      const chart = library.createChart(element, {
        width: element.clientWidth,
        height: element.clientHeight,
        layout: {
          background: { type: library.ColorType.Solid, color: cssVar("--surface") },
          textColor: cssVar("--text"),
        },
        grid: { vertLines: { color: border }, horzLines: { color: border } },
        rightPriceScale: { borderColor: border },
        timeScale: { borderColor: border, timeVisible: intraday, secondsVisible: false },
        localization: { locale: "ru-RU" },
      });
      // The library keeps the bar spacing when the chart is resized, so a chart
      // fitted while the page was narrower would leave empty space on the left.
      // Resize it by hand and fit all loaded bars again every time.
      const observer = new ResizeObserver(() => {
        const { clientWidth, clientHeight } = element;
        if (clientWidth === 0 || clientHeight === 0) return;
        chart.resize(clientWidth, clientHeight);
        chart.timeScale().fitContent();
      });
      observer.observe(element);
      remove = () => {
        observer.disconnect();
        chart.remove();
      };

      const series = chart.addSeries(library.CandlestickSeries, {
        priceFormat: { type: "price", precision: digits, minMove: 10 ** -digits },
      });
      const byTime = new Map<number, ChartBar>();
      const shown = (bar: ChartBar): Time =>
        (timeMode === "server" ? bar.serverTime : bar.time) as Time;
      try {
        series.setData(
          bars.map((bar) => {
            byTime.set(shown(bar), bar);
            return {
              time: shown(bar),
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: bar.close,
            };
          }),
        );
      } catch {
        // The library refuses data that is not strictly ascending in time.
        setProblem(
          "График не построен: свечи идут не по порядку или повторяются. Подробности — в проверке.",
        );
        return;
      }

      // Trades. Times are snapped to the loaded bar they fall into; a trade
      // that starts or ends outside the window is drawn up to the edge.
      const first = bars[0] as ChartBar;
      const last = bars[bars.length - 1] as ChartBar;
      const good = cssVar("--good");
      const bad = cssVar("--danger");
      const accent = cssVar("--accent");
      const markers: import("lightweight-charts").SeriesMarker<Time>[] = [];
      const segment = (from: Time, to: Time, price: number, color: string): void => {
        const line = chart.addSeries(library.LineSeries, {
          color,
          lineWidth: 1,
          lineStyle: library.LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        line.setData(
          from === to
            ? [{ time: from, value: price }]
            : [
                { time: from, value: price },
                { time: to, value: price },
              ],
        );
      };
      for (const trade of trades) {
        if (trade.exitTime < first.time || trade.entryTime > last.time) continue;
        const entryIndex = trade.entryTime >= first.time ? barAtOrBefore(bars, trade.entryTime) : -1;
        const exitIndex = trade.exitTime <= last.time ? barAtOrBefore(bars, trade.exitTime) : -1;
        const entryBar = entryIndex === -1 ? null : (bars[entryIndex] as ChartBar);
        const exitBar = exitIndex === -1 ? null : (bars[exitIndex] as ChartBar);
        const buy = trade.direction === "BUY";
        if (entryBar !== null) {
          markers.push({
            time: shown(entryBar),
            position: buy ? "belowBar" : "aboveBar",
            shape: buy ? "arrowUp" : "arrowDown",
            color: accent,
            text: `#${trade.n} ${buy ? "BUY" : "SELL"} ${trade.lots.toFixed(2)}`,
          });
        }
        if (exitBar !== null) {
          markers.push({
            time: shown(exitBar),
            position: buy ? "aboveBar" : "belowBar",
            shape: "circle",
            color: trade.netPnlUsd >= 0 ? good : bad,
            text: `#${trade.n} ${EXIT_LABELS[trade.exitReason]} ${trade.rMultiple >= 0 ? "+" : ""}${trade.rMultiple.toFixed(2)}R`,
          });
        }
        const from = shown(entryBar ?? first);
        const to = shown(exitBar ?? last);
        segment(from, to, trade.stopLoss, bad);
        if (trade.takeProfit !== null) segment(from, to, trade.takeProfit, good);
      }
      if (markers.length > 0) {
        markers.sort((a, b) => (a.time as number) - (b.time as number));
        library.createSeriesMarkers(series, markers);
      }

      chart.timeScale().fitContent();
      chart.subscribeCrosshairMove((param) => {
        setHover(typeof param.time === "number" ? (byTime.get(param.time) ?? null) : null);
      });
    });

    return () => {
      disposed = true;
      remove?.();
    };
  }, [bars, digits, intraday, timeMode, trades, scheme]);

  const formatTime = (bar: ChartBar): string =>
    new Date((timeMode === "server" ? bar.serverTime : bar.time) * 1000)
      .toISOString()
      .slice(0, 16)
      .replace("T", " ");

  return (
    <div className="chart-box card">
      <div className="chart-legend" aria-live="off">
        {hover === null ? (
          <span className="muted">Наведите на свечу, чтобы увидеть цены.</span>
        ) : (
          <>
            <span>{formatTime(hover)}</span>
            <span>O {hover.open.toFixed(digits)}</span>
            <span>H {hover.high.toFixed(digits)}</span>
            <span>L {hover.low.toFixed(digits)}</span>
            <span>C {hover.close.toFixed(digits)}</span>
            <span>спред {hover.spreadPoints} п.</span>
          </>
        )}
      </div>
      {problem !== null && <p className="note bad">{problem}</p>}
      <div ref={container} className="chart" />
    </div>
  );
}
