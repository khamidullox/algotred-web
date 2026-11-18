import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { Strategy, StrategyAction, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { at, bar, exit, flatBars, scripted, symbolData, testConfig } from "./helpers/bars";

const M15 = 15 * 60_000;
const START = "2024-01-08T08:00";
const COUNT = 32; // 08:00 .. 15:45

/** EURUSD M15 bars at 1.2000 until 10:00 (included), then at 1.1900. */
function bars(): Bar[] {
  return flatBars("M15", START, COUNT, 1.2).map((item) =>
    item.time > at("2024-01-08T10:00") ? bar(item.time, 1.19, 1.19, 1.19, 1.19) : item,
  );
}

const sellTight: StrategyAction = {
  kind: "entry",
  direction: "SELL",
  stopLoss: { distance: 0.001 },
  takeProfit: null,
  reason: "sell",
};
const buyTight = (extra: Partial<Extract<StrategyAction, { kind: "entry" }>> = {}): StrategyAction => ({
  kind: "entry",
  direction: "BUY",
  stopLoss: { distance: 0.001 },
  takeProfit: null,
  reason: "buy",
  ...extra,
});

function run(script: Record<string, StrategyAction>, data: Bar[] = bars()) {
  return runBacktest({
    data: [symbolData("EURUSD", data)],
    strategy: scripted(script),
    span: { start: at(START), end: at(START) + COUNT * M15 },
    config: testConfig(),
  });
}

describe("reversing a position (TZ 17.5)", () => {
  // Sell at 10:00 (1.2000, stop 10 pips), the price drops 100 pips, a reversing
  // buy is signalled at 12:00 and the day ends with an exit at 14:00.
  const result = run({
    "2024-01-08T10:00": sellTight,
    "2024-01-08T12:00": buyTight({ reverse: true }),
    "2024-01-08T14:00": exit(),
  });
  const [short, long] = result.trades as [Trade, Trade];

  it("closes the sell and opens the buy at the same open", () => {
    expect(result.trades.map((trade) => trade.direction)).toEqual(["SELL", "BUY"]);
    expect(result.skipped).toEqual([]);
    expect(short.exitReason).toBe("strategy");
    expect(short.exitTime).toBe(at("2024-01-08T12:00"));
    expect(short.exitPrice).toBe(1.19);
    expect(long.entryTime).toBe(at("2024-01-08T12:00"));
    expect(long.entryPrice).toBe(1.19);
    expect(long.exitTime).toBe(at("2024-01-08T14:00"));
  });

  it("sizes the new position from the balance after the close", () => {
    // 0.50 lot at a 10-pip stop; +100 pips is +500 USD, so the buy risks
    // 0.5% of 10 500 = 52.50 USD: 0.52 lot (0.50 if sized before the close).
    expect(short.lots).toBe(0.5);
    expect(short.netPnlUsd).toBeCloseTo(500, 6);
    expect(long.lots).toBe(0.52);
  });

  it("skips an entry against an open position without the flag, as before", () => {
    const plain = run({
      "2024-01-08T10:00": sellTight,
      "2024-01-08T12:00": buyTight(),
      "2024-01-08T14:00": exit(),
    });
    expect(plain.trades.map((trade) => [trade.direction, trade.exitTime])).toEqual([
      ["SELL", at("2024-01-08T14:00")],
    ]);
    expect(plain.skipped.map((item) => item.reason)).toEqual(["position-open"]);
  });

  it("does not reverse into the same direction", () => {
    const same = run({
      "2024-01-08T10:00": sellTight,
      "2024-01-08T12:00": { ...sellTight, reverse: true },
      "2024-01-08T14:00": exit(),
    });
    expect(same.trades).toHaveLength(1);
    expect(same.skipped.map((item) => item.reason)).toEqual(["position-open"]);
  });

  it("still closes the old position when the new entry hits a gap", () => {
    // No bars from 12:00 to 12:45: the next open is 13:00, not the expected 12:00.
    const holed = bars().filter(
      (item) => item.time < at("2024-01-08T12:00") || item.time >= at("2024-01-08T13:00"),
    );
    const gapped = run(
      {
        "2024-01-08T10:00": sellTight,
        "2024-01-08T12:00": buyTight({ reverse: true, expectedEntryTime: at("2024-01-08T12:00") }),
      },
      holed,
    );
    expect(gapped.trades.map((trade) => [trade.direction, trade.exitTime])).toEqual([
      ["SELL", at("2024-01-08T13:00")],
    ]);
    expect(gapped.skipped.map((item) => item.reason)).toEqual(["gap-after-signal"]);
  });
});

describe("a strategy's own instruments (TZ 17.5)", () => {
  const everywhere: Strategy = {
    ...scripted({ "2024-01-08T10:00": buyTight(), "2024-01-08T14:00": exit() }),
    symbols: ["EURUSD"],
  };

  it("runs only on the instruments the strategy names", () => {
    const result = runBacktest({
      data: [symbolData("EURUSD", bars()), symbolData("GBPUSD", bars())],
      strategy: everywhere,
      span: { start: at(START), end: at(START) + COUNT * M15 },
      config: testConfig(),
    });
    expect(result.symbols).toEqual(["EURUSD"]);
    expect(result.trades.map((trade) => trade.symbol)).toEqual(["EURUSD"]);
  });

  it("refuses to run when none of its instruments has data", () => {
    expect(() =>
      runBacktest({
        data: [symbolData("GBPUSD", bars())],
        strategy: everywhere,
        span: { start: at(START), end: at(START) + COUNT * M15 },
        config: testConfig(),
      }),
    ).toThrow(/EURUSD/);
  });

  it("runs on the named instruments it has data for", () => {
    const both: Strategy = { ...everywhere, symbols: ["EURUSD", "USDJPY"] };
    const result = runBacktest({
      data: [symbolData("EURUSD", bars()), symbolData("GBPUSD", bars())],
      strategy: both,
      span: { start: at(START), end: at(START) + COUNT * M15 },
      config: testConfig(),
    });
    expect(result.symbols).toEqual(["EURUSD"]);
  });

  it("keeps every instrument for a strategy that names none", () => {
    const result = runBacktest({
      data: [symbolData("EURUSD", bars()), symbolData("GBPUSD", bars())],
      strategy: scripted({ "2024-01-08T10:00": buyTight(), "2024-01-08T14:00": exit() }),
      span: { start: at(START), end: at(START) + COUNT * M15 },
      config: testConfig(),
    });
    expect(result.symbols).toEqual(["EURUSD", "GBPUSD"]);
    expect(result.trades.map((trade) => trade.symbol)).toEqual(["EURUSD", "GBPUSD"]);
  });
});
