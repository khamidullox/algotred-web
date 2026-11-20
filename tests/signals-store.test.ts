import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config";
import { findDailyExport, loadSignals } from "../src/app/_lib/signals-store";
import { ZONE } from "./helpers/bars";

const dir = mkdtempSync(path.join(tmpdir(), "signals-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const index = { digits: 2, contractSize: 10, usdSide: "quote", swapLongPips: 0, swapShortPips: 0, timeZoneCheck: false } as const;
const config: Config = parseConfig({
  brokerTimeZone: ZONE,
  dataDir: dir,
  reportsDir: "reports",
  initialCapitalUsd: 10_000,
  riskPerTradePct: 0.5,
  costs: { minSpreadPoints: 0, commissionPerLotRoundTrip: 0, slippagePips: 0 },
  symbols: {
    EURUSD: { digits: 5, contractSize: 100_000, usdSide: "quote", swapLongPips: 0, swapShortPips: 0 },
    US500: index,
    US30: index,
    US2000: index,
  },
  usdExposureLimit: false,
});

const FIRST = DateTime.fromISO("2024-01-01T00:00", { zone: ZONE });
const serverDay = (day: number): number => FIRST.plus({ days: day }).toMillis();
const date = (day: number): string => FIRST.plus({ days: day }).toFormat("yyyy.LL.dd");

/** A daily MT5 export: one row a day from 2024-01-01, a 10-point range around each close. */
function daily(closes: readonly number[]): string {
  const rows = closes.map((close, day) => {
    const open = day === 0 ? close : (closes[day - 1] as number);
    return [date(day), open.toFixed(2), (Math.max(open, close) + 5).toFixed(2), (Math.min(open, close) - 5).toFixed(2), close.toFixed(2), "1", "0", "0"].join("\t");
  });
  return ["<DATE>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>", ...rows].join("\r\n") + "\r\n";
}

/** 210 days up 10 points a day from 5000, then two falling days: RSI(2) under 5 above SMA(200). */
const climb = Array.from({ length: 210 }, (_, day) => 5000 + 10 * day);
const DIP = [...climb, 7050, 6970];
const LAST = DIP.length - 1;

writeFileSync(path.join(dir, "US500_D1.csv"), daily(DIP));
writeFileSync(path.join(dir, "US2000_D1.csv"), "not an export\r\n");
writeFileSync(path.join(dir, "USTEC_Daily_202207060000_202610300000.csv"), daily(climb));

describe("loadSignals", () => {
  // A week after the last bar closed.
  const view = loadSignals(config, serverDay(LAST + 8));
  const card = (symbol: string) => view.cards.find((item) => item.symbol === symbol);

  it("shows the strategy's instruments and Nasdaq when its export is there", () => {
    expect(view.strategy).toBe("Rsi2ReversionIndexD1");
    expect(view.riskUsd).toBe(50);
    expect(view.cards.map((item) => item.symbol)).toEqual(["US500", "US30", "US2000", "USTEC"]);
    expect(card("USTEC")?.note).toContain("ТЗ 17.18");
    expect(card("US500")?.note).toBeNull();
  });

  it("gives the entry signal with the stop and the lot", () => {
    const us500 = card("US500");
    expect(us500?.problem).toBeNull();
    expect(us500?.asOf).toBe(serverDay(LAST));
    expect(us500?.ageDays).toBe(7);
    expect(us500?.state).toMatchObject({ kind: "enter", direction: "BUY" });
    const atr = us500?.indicators?.atr as number;
    expect(us500?.indicators?.close).toBe(6970);
    expect(us500?.indicators?.rsi).toBeLessThan(5);
    expect(us500?.sizing?.stopDistance).toBeCloseTo(2 * atr, 10);
    // 0.01 lot of a 10 USD-a-point contract loses 0.1 USD a point.
    expect(us500?.sizing?.minLotRiskUsd).toBeCloseTo(0.1 * 2 * atr, 8);
    expect(us500?.sizing?.lots).toBe(Math.floor(50 / (0.1 * 2 * atr) + 1e-9) / 100);
  });

  it("says what is wrong instead of a state when the file is missing or is not an export", () => {
    expect(card("US30")?.problem).toContain("US30_D1.csv");
    expect(card("US30")?.state).toEqual({ kind: "flat" });
    expect(card("US2000")?.problem).not.toBeNull();
    expect(card("US2000")?.indicators).toBeNull();
  });

  it("has no signal on a steady climb", () => {
    expect(card("USTEC")?.state).toEqual({ kind: "flat" });
    expect(card("USTEC")?.sizing).toBeNull();
  });

  it("leaves out the day that is still trading, and looks no further than the moment given", () => {
    // One hour before the last day ends, that day is not closed: the signal is not there yet.
    const early = loadSignals(config, serverDay(LAST + 1) - 3_600_000).cards[0];
    expect(early?.asOf).toBe(serverDay(LAST - 1));
    expect(early?.unfinishedDayDropped).toBe(true);
    expect(early?.state).toEqual({ kind: "flat" });
    // The moment the day ends, it counts.
    expect(loadSignals(config, serverDay(LAST + 1)).cards[0]?.state.kind).toBe("enter");
  });
});

describe("loadSignals without the Nasdaq export", () => {
  it("leaves Nasdaq out and keeps the strategy's own instruments, files or not", () => {
    const empty = mkdtempSync(path.join(tmpdir(), "signals-empty-"));
    try {
      const view = loadSignals({ ...config, dataDir: empty }, serverDay(LAST + 8));
      expect(view.cards.map((item) => item.symbol)).toEqual(["US500", "US30", "US2000"]);
      expect(view.cards.every((item) => item.problem !== null)).toBe(true);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("findDailyExport", () => {
  it("takes the TZ name and the name MT5 gives a daily export, and nothing else", () => {
    expect(findDailyExport(dir, "US500")).toBe(path.join(dir, "US500_D1.csv"));
    expect(findDailyExport(dir, "USTEC")).toBe(path.join(dir, "USTEC_Daily_202207060000_202610300000.csv"));
    expect(findDailyExport(dir, "US30")).toBeNull();
    // An hourly file of the same symbol is not a daily export.
    writeFileSync(path.join(dir, "US30_H1.csv"), "");
    expect(findDailyExport(dir, "US30")).toBeNull();
    expect(findDailyExport(path.join(dir, "missing"), "US500")).toBeNull();
  });
});
