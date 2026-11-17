import { DateTime } from "luxon";
import {
  ConfigError,
  loadConfig,
  SYMBOLS,
  TIMEFRAMES,
  type SymbolName,
  type Timeframe,
} from "../../../../config";
import type { Bar } from "../../../../data/types";
import type { BarsResponse, ChartBar } from "../../../_lib/api-types";
import { getSeries } from "../../../_lib/data-store";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

function fail(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const symbol = params.get("symbol") ?? "";
  const timeframe = params.get("timeframe") ?? "";
  if (
    !(SYMBOLS as readonly string[]).includes(symbol) ||
    !(TIMEFRAMES as readonly string[]).includes(timeframe)
  ) {
    return fail(400, "Неизвестная пара или таймфрейм.");
  }
  const id = {
    symbol: symbol as SymbolName,
    timeframe: timeframe as Timeframe,
  };

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) return fail(500, error.message);
    throw error;
  }
  const zone = config.brokerTimeZone;

  const input = getSeries(config, id);
  if (input.parsed === null) {
    return input.formatError === undefined
      ? fail(404, `Нет файла ${input.file}.`)
      : fail(422, `${input.file}: ${input.formatError}.`);
  }
  const all = input.parsed.bars;
  const total = all.length;

  const requested = Number(params.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isInteger(requested)
    ? Math.min(MAX_LIMIT, Math.max(1, requested))
    : DEFAULT_LIMIT;
  const lastOffset = Math.max(0, total - limit);

  let offset = lastOffset;
  const date = params.get("date");
  const rawOffset = params.get("offset");
  if (date !== null) {
    const start = DateTime.fromISO(date, { zone });
    if (!start.isValid) {
      return fail(400, "Дата должна быть в виде ГГГГ-ММ-ДД.");
    }
    const from = start.startOf("day").toMillis();
    const index = all.findIndex((bar) => bar.time >= from);
    offset = index === -1 ? lastOffset : Math.min(index, lastOffset);
  } else if (rawOffset !== null) {
    const parsed = Number(rawOffset);
    if (!Number.isInteger(parsed)) {
      return fail(400, "offset должен быть целым числом.");
    }
    offset = Math.min(lastOffset, Math.max(0, parsed));
  }

  const bars = all.slice(offset, offset + limit).map((bar: Bar): ChartBar => {
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
    symbol: id.symbol,
    timeframe: id.timeframe,
    // Price digits as quoted by MT5: 3 for yen pairs, 5 for the rest.
    digits: id.symbol.endsWith("JPY") ? 3 : 5,
    total,
    offset,
    bars,
  };
  return Response.json(body);
}
