import { describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config";
import { runBacktest } from "../src/engine/backtest";
import { costSettings, slippageOf, swapNights } from "../src/engine/costs";
import { symbolSpec } from "../src/engine/symbols";
import type { Trade } from "../src/engine/types";
import { at, bar, buy, exit, flatBars, scripted, symbolData, ZONE } from "./helpers/bars";

/** A config with one index CFD priced like FundedNext's SPX500 (TZ 17.6). */
function indexConfig(own: Record<string, unknown> = {}): Config {
  return parseConfig({
    brokerTimeZone: ZONE,
    dataDir: "data/raw",
    reportsDir: "reports",
    initialCapitalUsd: 10_000,
    riskPerTradePct: 0.5,
    costs: { minSpreadPoints: 5, commissionPerLotRoundTrip: 7, slippagePips: 0.2 },
    symbols: {
      US500: {
        digits: 2,
        contractSize: 10,
        usdSide: "quote",
        swapLongPips: -13.4693,
        swapShortPips: -3.663,
        minSpreadPoints: 60,
        commissionPerLotRoundTrip: 0,
        slippagePoints: 24,
        tripleSwapDay: "friday",
        timeZoneCheck: false,
        ...own,
      },
      EURUSD: { digits: 5, contractSize: 100_000, usdSide: "quote", swapLongPips: 0, swapShortPips: 0 },
    },
    usdExposureLimit: false,
  });
}

describe("the triple-swap day (TZ 17.6)", () => {
  const thursdayNoon = at("2024-05-09T12:00");
  const mondayNoon = at("2024-05-13T12:00");
  const tuesdayNoon = at("2024-05-07T12:00");
  const thursdayMorning = at("2024-05-09T08:00");

  it("charges Friday three times when the instrument says so", () => {
    // Nights ending Thursday and Friday charge; Saturday and Sunday do not.
    expect(swapNights(thursdayNoon, mondayNoon, ZONE, 5)).toEqual({ nights: 2, weightedNights: 4 });
    expect(swapNights(thursdayNoon, mondayNoon, ZONE)).toEqual({ nights: 2, weightedNights: 2 });
  });

  it("keeps Wednesday as the default", () => {
    expect(swapNights(tuesdayNoon, thursdayMorning, ZONE)).toEqual({ nights: 2, weightedNights: 4 });
    expect(swapNights(tuesdayNoon, thursdayMorning, ZONE, 5)).toEqual({ nights: 2, weightedNights: 2 });
  });
});

describe("per-instrument cost settings (TZ 17.6)", () => {
  const config = indexConfig();

  it("reads the slippage in the instrument's points and the triple day", () => {
    const index = costSettings(config, "US500");
    expect(index.slippagePoints).toBe(24);
    expect(index.tripleSwapWeekday).toBe(5);
    expect(index.commissionPerLotRoundTrip).toBe(0);
    expect(slippageOf(symbolSpec(config, "US500"), index)).toBeCloseTo(0.24, 12);
  });

  it("leaves forex as it was: slippage in pips, triple swap on Wednesday", () => {
    const fx = costSettings(config, "EURUSD");
    expect(fx.slippagePoints).toBeNull();
    expect(fx.tripleSwapWeekday).toBe(3);
    expect(slippageOf(symbolSpec(config, "EURUSD"), fx)).toBeCloseTo(0.00002, 12);
  });

  it("rejects a triple-swap day other than Wednesday or Friday", () => {
    expect(() => indexConfig({ tripleSwapDay: "monday" })).toThrow();
  });
});

describe("an index trade over a weekend (TZ 17.6)", () => {
  // US500 at 5000.00 on hourly bars, spread 0.50 in the file (floor 0.60).
  const bars = flatBars("H1", "2024-05-09T00:00", 24 * 6, 5000, 50);
  const result = runBacktest({
    data: [symbolData("US500", bars)],
    strategy: scripted({ "2024-05-09T12:00": buy(20), "2024-05-13T12:00": exit() }, "H1"),
    span: { start: at("2024-05-09T00:00"), end: at("2024-05-09T00:00") + 24 * 6 * 3_600_000 },
    config: indexConfig(),
  });
  const trade = result.trades[0] as Trade;

  it("fills with the index spread floor and slippage in index points", () => {
    // Ask = 5000.00 + 0.60 spread + 0.24 slippage.
    expect(trade.entryPrice).toBe(5000.84);
    // Bid at exit = 5000.00 - 0.24 slippage.
    expect(trade.exitPrice).toBe(4999.76);
  });

  it("pays Friday's swap three times and no commission", () => {
    expect(trade.nights).toBe(2);
    expect(trade.commissionUsd).toBe(0);
    // 4 weighted nights x -13.4693 pips x 1 USD a pip per lot (pip 0.1 point, contract 10).
    expect(trade.swapUsd).toBeCloseTo(4 * -13.4693 * trade.lots, 9);
  });

  it("sizes the lot from 10 USD per index point", () => {
    // 50 USD risk at a 20-point stop: 0.25 lot.
    expect(trade.lots).toBe(0.25);
  });
});

describe("other instruments are unaffected", () => {
  it("prices a forex buy exactly as before", () => {
    const bars = flatBars("H1", "2024-05-09T00:00", 48, 1.1).map((item) => bar(item.time, 1.1, 1.1, 1.1, 1.1, 0));
    const result = runBacktest({
      data: [symbolData("EURUSD", bars)],
      strategy: scripted({ "2024-05-09T12:00": buy(0.002), "2024-05-10T12:00": exit() }, "H1"),
      span: { start: at("2024-05-09T00:00"), end: at("2024-05-09T00:00") + 48 * 3_600_000 },
      config: indexConfig(),
    });
    const trade = result.trades[0] as Trade;
    // Ask = 1.10000 + 5 points + 0.2 pip; Bid at exit = 1.10000 - 0.2 pip.
    expect(trade.entryPrice).toBe(1.10007);
    expect(trade.exitPrice).toBe(1.09998);
  });
});
