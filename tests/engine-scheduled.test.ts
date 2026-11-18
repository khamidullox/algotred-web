import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { StrategyAction, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { at, bar, flatBars, scripted, symbolData, testConfig } from "./helpers/bars";

const M15 = 15 * 60_000;
const START = "2024-01-08T08:00";
const COUNT = 40; // 08:00 .. 17:45

/** EURUSD M15 bars: 1.2000 until 13:00, 1.2050 after; one bar spikes down at 11:00 when `spike`. */
function bars(spike = false): Bar[] {
  return flatBars("M15", START, COUNT, 1.2).map((item) => {
    if (spike && item.time === at("2024-01-08T11:00")) return bar(item.time, 1.2, 1.2, 1.19, 1.2);
    return item.time >= at("2024-01-08T13:00") ? bar(item.time, 1.205, 1.205, 1.205, 1.205) : item;
  });
}

const buyAt = (notBefore?: number): StrategyAction => ({
  kind: "entry",
  direction: "BUY",
  stopLoss: { distance: 0.005 },
  takeProfit: null,
  reason: "scheduled buy",
  ...(notBefore === undefined ? {} : { notBefore }),
});
const exitAt = (notBefore?: number): StrategyAction => ({
  kind: "exit",
  reason: "scheduled exit",
  ...(notBefore === undefined ? {} : { notBefore }),
});

function run(script: Record<string, StrategyAction>, data: Bar[] = bars()) {
  return runBacktest({
    data: [symbolData("EURUSD", data)],
    strategy: scripted(script),
    span: { start: at(START), end: at(START) + COUNT * M15 },
    config: testConfig(),
  });
}

describe("scheduled orders (TZ 17.6)", () => {
  it("rests an entry until its time and fills at that open", () => {
    const result = run({ "2024-01-08T09:00": buyAt(at("2024-01-08T12:00")), "2024-01-08T15:00": exitAt() });
    const trade = result.trades[0] as Trade;
    expect(trade.signalTime).toBe(at("2024-01-08T09:00"));
    expect(trade.entryTime).toBe(at("2024-01-08T12:00"));
    expect(trade.exitTime).toBe(at("2024-01-08T15:00"));
  });

  it("rests an exit until its time, emitted right after the fill", () => {
    const result = run({
      "2024-01-08T09:00": buyAt(),
      "2024-01-08T09:15": exitAt(at("2024-01-08T14:00")),
    });
    const trade = result.trades[0] as Trade;
    expect(trade.entryTime).toBe(at("2024-01-08T09:00"));
    expect(trade.exitTime).toBe(at("2024-01-08T14:00"));
    expect(trade.exitPrice).toBe(1.205);
  });

  it("fills at the first open after its time when that hour is missing", () => {
    const holed = bars().filter(
      (item) => item.time < at("2024-01-08T14:00") || item.time >= at("2024-01-08T15:00"),
    );
    const result = run(
      { "2024-01-08T09:00": buyAt(), "2024-01-08T09:15": exitAt(at("2024-01-08T14:00")) },
      holed,
    );
    expect((result.trades[0] as Trade).exitTime).toBe(at("2024-01-08T15:00"));
  });

  it("lets the stop act first and then does nothing", () => {
    const result = run(
      { "2024-01-08T09:00": buyAt(), "2024-01-08T09:15": exitAt(at("2024-01-08T14:00")) },
      bars(true),
    );
    expect(result.trades.map((trade) => [trade.exitReason, trade.exitTime])).toEqual([
      ["stop", at("2024-01-08T11:00")],
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("fills at the next open without a time, as before", () => {
    const result = run({ "2024-01-08T09:00": buyAt(), "2024-01-08T12:00": exitAt() });
    const trade = result.trades[0] as Trade;
    expect(trade.entryTime).toBe(at("2024-01-08T09:00"));
    expect(trade.exitTime).toBe(at("2024-01-08T12:00"));
  });
});
