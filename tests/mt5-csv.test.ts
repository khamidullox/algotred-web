import { describe, expect, it } from "vitest";
import { detectSeriesFromFileName } from "../src/data/files";
import {
  decodeMt5File,
  Mt5CsvFormatError,
  parseMt5Csv,
} from "../src/data/mt5-csv";
import { createServerTimeConverter } from "../src/data/time";

const toUtc = createServerTimeConverter("Europe/Athens");
const HEADER =
  "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>";
const DAILY_HEADER =
  "<DATE>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>";

const utc = (iso: string): number => Date.parse(`${iso}Z`);

describe("parseMt5Csv", () => {
  it("reads an intraday export and converts server time to UTC", () => {
    // Two lines copied from a real MT5 export.
    const text = [
      HEADER,
      "2015.01.05\t00:00:00\t1.19454\t1.19534\t1.18642\t1.19449\t5392\t0\t13",
      "2015.01.05\t01:00:00\t1.19451\t1.19488\t1.19300\t1.19463\t3933\t0\t13",
      "",
    ].join("\r\n");
    const parsed = parseMt5Csv(text, { timeframe: "H1", toUtc });
    expect(parsed.rowCount).toBe(2);
    expect(parsed.rowErrorCount).toBe(0);
    expect(parsed.bars[0]).toEqual({
      time: utc("2015-01-04T22:00:00"),
      open: 1.19454,
      high: 1.19534,
      low: 1.18642,
      close: 1.19449,
      tickVolume: 5392,
      spreadPoints: 13,
    });
    expect(parsed.bars[1]?.time).toBe(utc("2015-01-04T23:00:00"));
  });

  it("reads a daily export, which has no <TIME> column", () => {
    const text = [
      DAILY_HEADER,
      "2015.01.02\t1.20538\t1.20690\t1.19997\t1.20014\t53082\t0\t9",
      "2015.07.01\t1.11410\t1.11710\t1.10430\t1.10530\t90000\t0\t7",
    ].join("\n");
    const parsed = parseMt5Csv(text, { timeframe: "D1", toUtc });
    expect(parsed.bars.map((bar) => bar.time)).toEqual([
      utc("2015-01-01T22:00:00"),
      utc("2015-06-30T21:00:00"),
    ]);
    expect(parsed.bars[0]?.spreadPoints).toBe(9);
  });

  it("reads USDJPY prices and ignores the real-volume column", () => {
    const text = [
      HEADER,
      "2015.01.02\t09:00:00\t120.401\t120.498\t120.390\t120.424\t682\t814222000\t0",
    ].join("\n");
    const [bar] = parseMt5Csv(text, { timeframe: "M15", toUtc }).bars;
    expect(bar).toMatchObject({ open: 120.401, tickVolume: 682, spreadPoints: 0 });
  });

  it("rejects a file that is not an MT5 export", () => {
    expect(() =>
      parseMt5Csv("date,open,high,low,close\n2015-01-02,1,2,0,1", {
        timeframe: "H1",
        toUtc,
      }),
    ).toThrow(Mt5CsvFormatError);
  });

  it("rejects a daily export offered as an intraday timeframe", () => {
    expect(() =>
      parseMt5Csv(
        `${DAILY_HEADER}\n2015.01.02\t1.2\t1.3\t1.1\t1.2\t10\t0\t9`,
        { timeframe: "H1", toUtc },
      ),
    ).toThrow(Mt5CsvFormatError);
  });

  it("reports unreadable rows with their line numbers instead of guessing", () => {
    const text = [
      HEADER,
      "2015.01.05\t00:00:00\t1.1\t1.2\t1.0\t1.1\t10\t0\t5", // ok
      "2015.01.05\t01:00:00\t1.1\t1.2\t1.0\t1.1\t10\t0", // 8 columns
      "05.01.2015\t02:00:00\t1.1\t1.2\t1.0\t1.1\t10\t0\t5", // wrong date format
      "2015.01.05\t03:00:00\t1.1\tabc\t1.0\t1.1\t10\t0\t5", // not a number
      "2015.01.05\t04:07:00\t1.1\t1.2\t1.0\t1.1\t10\t0\t5", // off the H1 grid
      "2015.02.30\t05:00:00\t1.1\t1.2\t1.0\t1.1\t10\t0\t5", // no such date
      "2024.03.31\t03:00:00\t1.1\t1.2\t1.0\t1.1\t10\t0\t5", // skipped by DST
    ].join("\n");
    const parsed = parseMt5Csv(text, { timeframe: "H1", toUtc });
    expect(parsed.rowCount).toBe(7);
    expect(parsed.bars).toHaveLength(1);
    expect(parsed.rowErrorCount).toBe(6);
    expect(parsed.rowErrors.map((row) => row.line)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("keeps file order so that validate can report sorting problems", () => {
    const text = [
      HEADER,
      "2015.01.05\t02:00:00\t1.1\t1.2\t1.0\t1.1\t10\t0\t5",
      "2015.01.05\t01:00:00\t1.1\t1.2\t1.0\t1.1\t10\t0\t5",
    ].join("\n");
    const { bars } = parseMt5Csv(text, { timeframe: "H1", toUtc });
    expect((bars[0]?.time ?? 0) > (bars[1]?.time ?? 0)).toBe(true);
  });
});

describe("decodeMt5File", () => {
  it("decodes UTF-8 and UTF-16LE with a byte order mark", () => {
    const utf8 = new TextEncoder().encode("<DATE>\t<TIME>");
    expect(decodeMt5File(utf8)).toBe("<DATE>\t<TIME>");
    const utf16 = new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x44, 0x00, 0x3e, 0x00]);
    expect(decodeMt5File(utf16).replace(/^\uFEFF/, "")).toBe("<D>");
  });
});

describe("detectSeriesFromFileName", () => {
  const THREE = ["EURUSD", "GBPUSD", "USDJPY"];
  it.each([
    ["EURUSD_H1.csv", "EURUSD", "H1"],
    ["EURUSD_H1_201501050000_202611160000.csv", "EURUSD", "H1"],
    ["GBPUSD_Daily_201502020000_202611160000.csv", "GBPUSD", "D1"],
    ["usdjpy_m15_201501020900_202611160000.CSV", "USDJPY", "M15"],
    ["C:\\exports\\USDJPY_D1.csv", "USDJPY", "D1"],
  ])("recognises %s", (name, symbol, timeframe) => {
    expect(detectSeriesFromFileName(name, THREE)).toEqual({ symbol, timeframe });
  });

  it("accepts an instrument once it is in the configured list", () => {
    expect(detectSeriesFromFileName("XAUUSD_H1.csv", THREE)).toBeNull();
    expect(detectSeriesFromFileName("XAUUSD_H1.csv", [...THREE, "XAUUSD"])).toEqual({
      symbol: "XAUUSD",
      timeframe: "H1",
    });
  });

  it.each([
    "EURUSD_M1_201501050000_202611132359.csv",
    "EURUSD_M30.csv",
    "AUDUSD_H1.csv",
    "EURUSD.csv",
    "EURUSD_H1.txt",
    "../EURUSD_H1_extra.csv",
  ])("rejects %s", (name) => {
    expect(detectSeriesFromFileName(name, THREE)).toBeNull();
  });
});
