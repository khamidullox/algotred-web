import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config";

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
      swap: {
        EURUSD: { swapLongPips: -0.7, swapShortPips: 0.3 },
        GBPUSD: { swapLongPips: 0, swapShortPips: 0 },
        USDJPY: { swapLongPips: 0, swapShortPips: 0 },
      },
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
    expect(parseConfig(validRaw()).costs.commissionPerLotRoundTrip).toBe(7);
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
