import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { afterAll, describe, expect, it } from "vitest";
import { getLiveSeries } from "../src/app/_lib/live-series";
import { ZONE } from "./helpers/bars";

const dir = mkdtempSync(path.join(tmpdir(), "live-series-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const at = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis();

const INTRADAY = "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>";
const DAILY = "<DATE>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>";
const row = (date: string, time: string | null, close: number): string =>
  [date, ...(time === null ? [] : [time]), close.toFixed(2), (close + 1).toFixed(2), (close - 1).toFixed(2), close.toFixed(2), "10", "0", "5"].join("\t");

describe("getLiveSeries", () => {
  it("reads the indicator's file the way the project reads MT5's export", () => {
    writeFileSync(path.join(dir, "US500_H1.csv"), [INTRADAY, row("2026.11.27", "09:00:00", 7200), row("2026.11.27", "10:00:00", 7210), ""].join("\r\n"));
    writeFileSync(path.join(dir, "US500_D1.csv"), [DAILY, row("2026.11.26", null, 7190), row("2026.11.27", null, 7270), ""].join("\r\n"));
    const hourly = getLiveSeries(dir, "US500", "H1", ZONE);
    expect(hourly?.bars.map((bar) => bar.time)).toEqual([at("2026-11-27T09:00"), at("2026-11-27T10:00")]);
    expect(hourly?.bars[1]).toMatchObject({ open: 7210, high: 7211, low: 7209, close: 7210, spreadPoints: 5 });
    expect(getLiveSeries(dir, "US500", "D1", ZONE)?.bars.map((bar) => bar.time)).toEqual([at("2026-11-26T00:00"), at("2026-11-27T00:00")]);
  });

  it("is null without a folder, without a file, or for a name that is not a symbol", () => {
    expect(getLiveSeries(null, "US500", "H1", ZONE)).toBeNull();
    expect(getLiveSeries(dir, "US30", "H1", ZONE)).toBeNull();
    expect(getLiveSeries(path.join(dir, "missing"), "US500", "H1", ZONE)).toBeNull();
    expect(getLiveSeries(dir, "../US500", "H1", ZONE)).toBeNull();
  });

  it("reads the file again when it grows, and keeps only increasing times", () => {
    const file = path.join(dir, "EURUSD_M15.csv");
    writeFileSync(file, [INTRADAY, row("2026.11.27", "09:00:00", 1.1), ""].join("\r\n"));
    expect(getLiveSeries(dir, "EURUSD", "M15", ZONE)?.bars).toHaveLength(1);
    // Appended: a new bar, a repeat of it, and one out of order.
    writeFileSync(file, [INTRADAY, row("2026.11.27", "09:00:00", 1.1), row("2026.11.27", "09:15:00", 1.2), row("2026.11.27", "09:15:00", 1.3), row("2026.11.27", "09:00:00", 1.4), ""].join("\r\n"));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    const series = getLiveSeries(dir, "EURUSD", "M15", ZONE);
    expect(series?.bars.map((bar) => bar.close)).toEqual([1.1, 1.2]);
  });

  it("gives the last good reading when the file cannot be parsed for a moment", () => {
    const file = path.join(dir, "USDJPY_H1.csv");
    writeFileSync(file, [INTRADAY, row("2026.11.27", "09:00:00", 155), ""].join("\r\n"));
    expect(getLiveSeries(dir, "USDJPY", "H1", ZONE)?.bars).toHaveLength(1);
    writeFileSync(file, "not an export\r\n");
    const later = new Date(Date.now() + 10_000);
    utimesSync(file, later, later);
    expect(getLiveSeries(dir, "USDJPY", "H1", ZONE)?.bars).toHaveLength(1);
    // A file that was never good gives nothing.
    writeFileSync(path.join(dir, "USDCAD_H1.csv"), "not an export\r\n");
    expect(getLiveSeries(dir, "USDCAD", "H1", ZONE)).toBeNull();
  });
});
