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

describe("loadSignals with the feed of the MT5 indicator", () => {
  const feed = mkdtempSync(path.join(tmpdir(), "signals-feed-"));
  afterAll(() => rmSync(feed, { recursive: true, force: true }));

  // The broker's own names and contract: 5 USD a point for a lot, lots of 0.1.
  const spx = { symbol: "SPX500", title: "S&P 500", file: "SPX500_D1.csv", digits: 2, tickSize: 0.1, tickValue: 0.5, lotMin: 0.1, lotStep: 0.1, lotMax: 50, dayOpen: true };
  const ndx = { ...spx, symbol: "NDX100", title: "Nasdaq 100", file: "NDX100_D1.csv", dayOpen: false };
  const lost = { ...spx, symbol: "US30", title: "Dow Jones", file: "US30_D1.csv" };
  const meta = (symbols: readonly object[], balance = 6000): string =>
    JSON.stringify({ version: 1, serverTime: "2024.07.31 14:05:10", server: "Broker-Demo", currency: "USD", balance, symbols });
  // The entry day is trading: it opened at the signal day's close, 6970, and stands at 7100.
  writeFileSync(path.join(feed, "SPX500_D1.csv"), daily([...DIP, 7100]));
  writeFileSync(path.join(feed, "NDX100_D1.csv"), daily(DIP));
  writeFileSync(path.join(feed, "feed.json"), meta([spx, ndx, lost]));
  // The moment asked about is irrelevant to which bars are closed: the terminal said it.
  const view = loadSignals(config, serverDay(LAST + 30), feed);
  const card = (symbol: string) => view.cards.find((item) => item.symbol === symbol);

  it("shows the terminal's instruments under the broker's names, with its balance as the account", () => {
    expect(view.source).toMatchObject({ kind: "terminal", server: "Broker-Demo", serverTime: "2024.07.31 14:05:10" });
    expect(view.cards.map((item) => item.symbol)).toEqual(["SPX500", "NDX100", "US30"]);
    expect(view.accountSize).toBe(6000);
    expect(view.riskPct).toBe(0.5);
    expect(view.riskUsd).toBe(30);
    expect(view.currency).toBe("USD");
    expect(card("NDX100")?.note).toContain("ТЗ 17.18");
    expect(card("SPX500")?.note).toBeNull();
  });

  it("leaves the day still trading out of the state and plans the entry from its open", () => {
    const own = card("SPX500");
    expect(own?.asOf).toBe(serverDay(LAST));
    expect(own?.unfinishedDayDropped).toBe(true);
    expect(own?.state).toMatchObject({ kind: "enter", direction: "BUY" });
    expect(own?.today).toEqual({ open: 6970, high: 7105, low: 6965, last: 7100 });
    const atr = own?.indicators?.atr as number;
    const stop = Math.round((6970 - 2 * atr) * 100) / 100;
    expect(own?.plan).toEqual({ entryPrice: 6970, stopPrice: stop, stopTouched: false });
    expect(own?.sizing?.stopDistance).toBeCloseTo(6970 - stop, 10);
    // Entered at the open, and the day stands above SMA(5): tomorrow the rule leaves.
    expect(own?.nextDay).toEqual({ kind: "exit", direction: "BUY" });
  });

  it("counts the lot from the broker's contract, not from the project's config", () => {
    const own = card("SPX500");
    expect(own?.lotRules).toEqual({ moneyPerPointPerLot: 5, lotStep: 0.1, lotMin: 0.1, lotMax: 50 });
    const distance = own?.sizing?.stopDistance as number;
    // 30 USD of risk, 5 USD a point: with a stop of some 50 points that is 0.1 lot.
    expect(distance).toBeGreaterThan(30);
    expect(distance).toBeLessThan(60);
    expect(own?.sizing?.lots).toBe(0.1);
    expect(own?.sizing?.minLotRiskUsd).toBeCloseTo(0.1 * 5 * distance, 8);
  });

  it("takes the terminal's word that the last day is closed, whatever the clock says", () => {
    // Long before that day ended by the clock, the same file gives the signal: dayOpen is false.
    const early = loadSignals(config, serverDay(LAST) + 3_600_000, feed).cards.find((item) => item.symbol === "NDX100");
    expect(early?.asOf).toBe(serverDay(LAST));
    expect(early?.unfinishedDayDropped).toBe(false);
    expect(early?.state.kind).toBe("enter");
    expect(early?.today).toBeNull();
    expect(early?.plan).toBeNull();
    expect(early?.nextDay).toBeNull();
  });

  it("says so when a file named by the feed is not there, and goes on with the rest", () => {
    expect(card("US30")?.problem).toContain("не читается");
    expect(card("US30")?.state).toEqual({ kind: "flat" });
  });

  it("notices a stop already reached on the entry day", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "signals-feed-stop-"));
    try {
      // The entry day fell to 6800: its low, 6795, is under the stop some 50 points below 6970.
      writeFileSync(path.join(dir, "SPX500_D1.csv"), daily([...DIP, 6800]));
      writeFileSync(path.join(dir, "feed.json"), meta([spx], 0));
      const stopped = loadSignals(config, serverDay(LAST + 1), dir);
      expect(stopped.cards[0]?.plan?.stopTouched).toBe(true);
      // No balance from the terminal: the account of the config stands in.
      expect(stopped.accountSize).toBe(10_000);
      expect(stopped.riskUsd).toBe(50);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the files of the data folder without a feed, and says why when the feed is broken", () => {
    const none = loadSignals(config, serverDay(LAST + 8), path.join(feed, "missing"));
    expect(none.source).toEqual({ kind: "files", feedProblem: null });
    expect(none.cards.map((item) => item.symbol)).toEqual(["US500", "US30", "US2000", "USTEC"]);
    expect(none.accountSize).toBe(10_000);

    const broken = mkdtempSync(path.join(tmpdir(), "signals-feed-broken-"));
    try {
      writeFileSync(path.join(broken, "feed.json"), "{");
      const view = loadSignals(config, serverDay(LAST + 8), broken);
      expect(view.source.kind).toBe("files");
      expect(view.source.kind === "files" ? view.source.feedProblem : null).toContain("не JSON");
      expect(view.cards[0]?.state.kind).toBe("enter");
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it("without a feed folder given never looks for one", () => {
    expect(loadSignals(config, serverDay(LAST + 8)).source).toEqual({ kind: "files", feedProblem: null });
  });
});

describe("the lot rules of the files", () => {
  it("come from the config's contract: 10 USD a point for a lot, lots of 0.01", () => {
    const own = loadSignals(config, serverDay(LAST + 8)).cards[0];
    expect(own?.lotRules).toEqual({ moneyPerPointPerLot: 10, lotStep: 0.01, lotMin: 0.01, lotMax: 0 });
    expect(own?.today).toBeNull();
    expect(own?.plan).toBeNull();
  });
});

describe("the day still trading in a file of the data folder", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "signals-today-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // The signal day, then the entry day (down to 6950), then a day back up to 7060:
  // above the mean of the last five closes, (7090 + 7050 + 6970 + 6950 + 7060) / 5 = 7024.
  writeFileSync(path.join(dir, "US500_D1.csv"), daily([...DIP, 6950, 7060]));
  const own = { ...config, dataDir: dir };

  it("is the one row after the closed days, once that day has begun", () => {
    // An hour into the entry day would be before its row exists; here the file was saved
    // in the middle of the last day, so the entry day is closed and a position is open.
    const midday = loadSignals(own, serverDay(LAST + 2) + 12 * 3_600_000).cards[0];
    expect(midday?.asOf).toBe(serverDay(LAST + 1));
    expect(midday?.state.kind).toBe("open");
    expect(midday?.today).toEqual({ open: 6950, high: 7065, low: 6945, last: 7060 });
    expect(midday?.stopTouchedToday).toBe(false);
    expect(midday?.nextDay?.kind).toBe("exit");
  });

  it("is never taken from later rows when a past moment is asked about", () => {
    // The end of the signal day exactly, as the page asks for a past date: two later rows
    // are in the file, and none of them is "today".
    const signalDay = loadSignals(own, serverDay(LAST + 1)).cards[0];
    expect(signalDay?.asOf).toBe(serverDay(LAST));
    expect(signalDay?.state.kind).toBe("enter");
    expect(signalDay?.unfinishedDayDropped).toBe(true);
    expect(signalDay?.today).toBeNull();
    expect(signalDay?.plan).toBeNull();
    expect(signalDay?.nextDay).toBeNull();
    // The end of the day before the last row: one later row, opening at that very moment.
    const dayBefore = loadSignals(own, serverDay(LAST + 2)).cards[0];
    expect(dayBefore?.asOf).toBe(serverDay(LAST + 1));
    expect(dayBefore?.today).toBeNull();
    expect(dayBefore?.nextDay).toBeNull();
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
