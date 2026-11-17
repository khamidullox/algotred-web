"use client";

import { useEffect, useRef, useState } from "react";
import type { ChartBar } from "../_lib/api-types";

export type TimeMode = "server" | "utc";

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

/**
 * Candlestick chart. The library draws its time axis in UTC, so to show broker
 * server time the bars are passed with a pre-shifted timestamp.
 */
export function CandleChart({
  bars,
  digits,
  intraday,
  timeMode,
}: {
  bars: ChartBar[];
  digits: number;
  intraday: boolean;
  timeMode: TimeMode;
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
      const shown = (bar: ChartBar): number =>
        timeMode === "server" ? bar.serverTime : bar.time;
      try {
        series.setData(
          bars.map((bar) => {
            byTime.set(shown(bar), bar);
            return {
              time: shown(bar) as import("lightweight-charts").UTCTimestamp,
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
      chart.timeScale().fitContent();
      chart.subscribeCrosshairMove((param) => {
        setHover(typeof param.time === "number" ? (byTime.get(param.time) ?? null) : null);
      });
    });

    return () => {
      disposed = true;
      remove?.();
    };
  }, [bars, digits, intraday, timeMode, scheme]);

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
