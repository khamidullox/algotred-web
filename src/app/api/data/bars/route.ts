import { DateTime } from "luxon";
import {
  CHART_ONLY_TIMEFRAMES,
  ConfigError,
  loadConfig,
  TIMEFRAMES,
  type AnyTimeframe,
  type ChartOnlyTimeframe,
  type Timeframe,
} from "../../../../config";
import { symbolSpec } from "../../../../engine/symbols";
import { splitCommonRange, SplitError } from "../../../../data/split";
import { createServerTimeConverter } from "../../../../data/time";
import type { Bar } from "../../../../data/types";
import type { BarsResponse, ChartBar } from "../../../_lib/api-types";
import { findExport, getLineIndex, readBars } from "../../../_lib/big-series";
import { getSeries, getValidationReport } from "../../../_lib/data-store";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Bars by index, whether they sit in memory or are read from disk window by window. */
interface BarSource {
  readonly count: number;
  timeAt(index: number): number;
  slice(from: number, to: number): Bar[];
}

/** First index whose bar opens at or after `time`; `count` when none. */
function lowerBound(source: BarSource, time: number): number {
  let low = 0;
  let high = source.count;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (source.timeAt(middle) < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const symbol = params.get("symbol") ?? "";
  const timeframe = params.get("timeframe") ?? "";

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) return fail(500, error.message);
    throw error;
  }
  const chartOnly = (CHART_ONLY_TIMEFRAMES as readonly string[]).includes(timeframe);
  if (config.symbols[symbol] === undefined || !(chartOnly || (TIMEFRAMES as readonly string[]).includes(timeframe))) {
    return fail(400, "Неизвестный инструмент или таймфрейм.");
  }
  const zone = config.brokerTimeZone;

  let source: BarSource;
  if (chartOnly) {
    // M1 and M5 exports are too large to parse whole: read windows from disk.
    const file = findExport(config.dataDir, symbol, timeframe as ChartOnlyTimeframe);
    if (file === null) return fail(404, `Нет файла ${symbol}_${timeframe}.csv в папке данных.`);
    const index = getLineIndex(file);
    const options = { timeframe: timeframe as AnyTimeframe, toUtc: createServerTimeConverter(zone) };
    source = {
      count: index.count,
      // A badly written line has no bar: look at the next one.
      timeAt: (at) => {
        for (let probe = at; probe < Math.min(index.count, at + 10); probe++) {
          const bar = readBars(index, probe, probe + 1, options)[0];
          if (bar !== undefined) return bar.time;
        }
        return Number.POSITIVE_INFINITY;
      },
      slice: (from, to) => readBars(index, from, to, options),
    };
  } else {
    const input = getSeries(config, { symbol, timeframe: timeframe as Timeframe });
    if (input.parsed === null) {
      return input.formatError === undefined
        ? fail(404, `Нет файла ${input.file}.`)
        : fail(422, `${input.file}: ${input.formatError}.`);
    }
    const bars = input.parsed.bars;
    source = {
      count: bars.length,
      timeAt: (at) => (bars[at] as Bar).time,
      slice: (from, to) => bars.slice(from, to),
    };
  }

  // The holdout set is not shown at all (TZ section 6, decision of 2026-11-17):
  // the chart ends where the holdout begins. The boundary comes from the
  // validated D1/H1/M15 files only.
  let total = source.count;
  let hiddenFrom: number | null = null;
  const report = getValidationReport(config);
  if (report.commonRange !== null) {
    try {
      const holdoutStart = splitCommonRange(report.commonRange, zone, config.datasets).holdout.start;
      total = lowerBound(source, holdoutStart);
      hiddenFrom = holdoutStart / 1000;
    } catch (error) {
      if (!(error instanceof SplitError)) throw error;
    }
  }

  const requested = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(requested) ? Math.min(MAX_LIMIT, Math.max(1, requested)) : DEFAULT_LIMIT;
  const lastOffset = Math.max(0, total - limit);
  const visible: BarSource = { ...source, count: total };

  let offset = lastOffset;
  const date = params.get("date");
  const rawOffset = params.get("offset");
  const around = params.get("around");
  if (around !== null) {
    // Centre the window on an instant (UTC seconds), e.g. the entry of a trade.
    const seconds = Number(around);
    if (!Number.isFinite(seconds)) {
      return fail(400, "around должен быть временем в секундах UTC.");
    }
    const index = lowerBound(visible, seconds * 1000);
    offset = Math.min(lastOffset, Math.max(0, index - Math.floor(limit / 2)));
  } else if (date !== null) {
    const start = DateTime.fromISO(date, { zone });
    if (!start.isValid) {
      return fail(400, "Дата должна быть в виде ГГГГ-ММ-ДД.");
    }
    const index = lowerBound(visible, start.startOf("day").toMillis());
    offset = index >= total ? lastOffset : Math.min(index, lastOffset);
  } else if (rawOffset !== null) {
    const parsed = Number(rawOffset);
    if (!Number.isInteger(parsed)) {
      return fail(400, "offset должен быть целым числом.");
    }
    offset = Math.min(lastOffset, Math.max(0, parsed));
  }

  const bars = source.slice(offset, Math.min(total, offset + limit)).map((bar: Bar): ChartBar => {
    const offsetMinutes = DateTime.fromMillis(bar.time, { zone }).offset;
    return {
      time: bar.time / 1000,
      serverTime: bar.time / 1000 + offsetMinutes * 60,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      spreadPoints: bar.spreadPoints,
    };
  });

  const body: BarsResponse = {
    symbol,
    timeframe: timeframe as AnyTimeframe,
    digits: symbolSpec(config, symbol).digits,
    total,
    offset,
    bars,
    hiddenFrom,
  };
  return Response.json(body);
}
