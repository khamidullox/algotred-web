import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig, symbolConfig, symbolNames } from "../src/config";

function validRaw(): Record<string, unknown> {
  return {
    brokerTimeZone: "Europe/Athens",
    dataDir: "data/raw",
    reportsDir: "reports",
    initialCapitalUsd: 10000,
    riskPerTradePct: 0.5,
    costs: {
      minSpreadPoints: 0,
      commissionPerLotRoundTrip: 7,
      slippagePips: 0.2,
    },
    symbols: {
      EURUSD: { digits: 5, contractSize: 100000, usdSide: "quote", swapLongPips: -0.7, swapShortPips: 0.3 },
      USDJPY: { digits: 3, contractSize: 100000, usdSide: "base", swapLongPips: 0, swapShortPips: 0 },
      XAUUSD: { digits: 2, contractSize: 100, usdSide: "quote", swapLongPips: -3, swapShortPips: 1, minSpreadPoints: 20 },
    },
    usdExposureLimit: false,
  };
}

describe("config", () => {
  it("loads config/default.json with the values fixed by the TZ", () => {
    const config = loadConfig();
    expect(config.initialCapitalUsd).toBe(10000);
    expect(config.riskPerTradePct).toBe(0.5);
    expect(config.costs.slippagePips).toBe(0.2);
    expect(config.usdExposureLimit).toBe(false);
  });

  it("accepts a valid config", () => {
    const config = parseConfig(validRaw());
    expect(config.costs.commissionPerLotRoundTrip).toBe(7);
    expect(symbolNames(config)).toEqual(["EURUSD", "USDJPY", "XAUUSD"]);
    expect(symbolConfig(config, "XAUUSD").minSpreadPoints).toBe(20);
  });

  it("requires at least one symbol and sane symbol names", () => {
    expect(() => parseConfig({ ...validRaw(), symbols: {} })).toThrow(ConfigError);
    expect(() =>
      parseConfig({
        ...validRaw(),
        symbols: { "eur/usd": { digits: 5, contractSize: 100000, usdSide: "quote", swapLongPips: 0, swapShortPips: 0 } },
      }),
    ).toThrow(ConfigError);
    expect(() => symbolConfig(parseConfig(validRaw()), "GBPUSD")).toThrow(ConfigError);
  });

  it.each(["Mars/Phobos", "+05:00", "UTC+5", ""])(
    "rejects brokerTimeZone %j",
    (zone) => {
      expect(() =>
        parseConfig({ ...validRaw(), brokerTimeZone: zone }),
      ).toThrow(ConfigError);
    },
  );

  it("rejects unknown keys so typos do not pass silently", () => {
    expect(() => parseConfig({ ...validRaw(), slipagePips: 1 })).toThrow(
      ConfigError,
    );
  });

  it("rejects negative costs", () => {
    const raw = validRaw();
    (raw.costs as Record<string, unknown>).slippagePips = -0.2;
    expect(() => parseConfig(raw)).toThrow(/slippagePips/);
  });

  it("reports a missing file as ConfigError", () => {
    expect(() => loadConfig("config/does-not-exist.json")).toThrow(ConfigError);
  });
});
