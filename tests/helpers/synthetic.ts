import { DateTime } from "luxon";
import type { SymbolName, Timeframe } from "../../src/config";
import type { SeriesInput } from "../../src/data/load";
import { parseMt5Csv } from "../../src/data/mt5-csv";
import { createServerTimeConverter } from "../../src/data/time";

/** One CSV row in broker server time. Prices are integer points to keep the maths exact. */
export interface Row {
  date: string; // yyyy.LL.dd
  time: string; // HH:mm:ss
  open: number;
  high: number;
  low: number;
  close: number;
  tickVolume: number;
  spread: number;
}

export interface SyntheticSet {
  m15: Row[];
  h1: Row[];
  d1: Row[];
}

function aggregate(rows: readonly Row[], size: number): Row[] {
  const result: Row[] = [];
  for (let index = 0; index < rows.length; index += size) {
    const chunk = rows.slice(index, index + size);
    const first = chunk[0] as Row;
    const last = chunk[chunk.length - 1] as Row;
    result.push({
      date: first.date,
      time: first.time,
      open: first.open,
      high: Math.max(...chunk.map((row) => row.high)),
      low: Math.min(...chunk.map((row) => row.low)),
      close: last.close,
      tickVolume: chunk.reduce((sum, row) => sum + row.tickVolume, 0),
      spread: Math.min(...chunk.map((row) => row.spread)),
    });
  }
  return result;
}

/**
 * Full trading weeks, Monday 00:00 to Friday 24:00 server time, with M15, H1
 * and D1 that agree with each other. `firstMonday` is a server-time date.
 */
export function makeWeeks(firstMonday: string, weeks: number): SyntheticSet {
  const m15: Row[] = [];
  let price = 110_000;
  let seed = 12_345;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed;
  };
  const start = DateTime.fromISO(firstMonday, { zone: "UTC" });
  for (let week = 0; week < weeks; week++) {
    for (let day = 0; day < 5; day++) {
      const date = start.plus({ days: week * 7 + day });
      for (let slot = 0; slot < 96; slot++) {
        const open = price;
        const close = open + (next() % 41) - 20;
        m15.push({
          date: date.toFormat("yyyy.LL.dd"),
          time: `${String(Math.floor(slot / 4)).padStart(2, "0")}:${String((slot % 4) * 15).padStart(2, "0")}:00`,
          open,
          high: Math.max(open, close) + (next() % 5),
          low: Math.min(open, close) - (next() % 5),
          close,
          tickVolume: 100 + (next() % 50),
          spread: 5,
        });
        price = close;
      }
    }
  }
  return { m15, h1: aggregate(m15, 4), d1: aggregate(m15, 96) };
}

const price = (points: number): string => (points / 100_000).toFixed(5);

export function toCsv(rows: readonly Row[], withTime = true): string {
  const header = withTime
    ? "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>"
    : "<DATE>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>";
  const lines = rows.map((row) =>
    [
      row.date,
      ...(withTime ? [row.time] : []),
      price(row.open),
      price(row.high),
      price(row.low),
      price(row.close),
      row.tickVolume,
      0,
      row.spread,
    ].join("\t"),
  );
  return [header, ...lines, ""].join("\r\n");
}

export function toInput(
  symbol: SymbolName,
  timeframe: Timeframe,
  rows: readonly Row[],
  zone: string,
): SeriesInput {
  return {
    id: { symbol, timeframe },
    file: `${symbol}_${timeframe}.csv`,
    // Daily exports have no <TIME> column, exactly like the real MT5 files.
    parsed: parseMt5Csv(toCsv(rows, timeframe !== "D1"), {
      timeframe,
      toUtc: createServerTimeConverter(zone),
    }),
  };
}

export function toInputs(
  symbol: SymbolName,
  set: SyntheticSet,
  zone: string,
): SeriesInput[] {
  return [
    toInput(symbol, "D1", set.d1, zone),
    toInput(symbol, "H1", set.h1, zone),
    toInput(symbol, "M15", set.m15, zone),
  ];
}
