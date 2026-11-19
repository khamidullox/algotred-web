import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, MarketContext, Signal, Strategy, StrategyAction, Trade } from "../src/engine/types";
import { tradesToCsv } from "../src/report/trades-csv";
import { at, flatBars, indexAt, scripted, symbolData, testConfig, withBar } from "./helpers/bars";

// Limit orders and partial closes (TZ 17.10) on hand-made M15 bars. The order
// is placed at the close of the 10:00 bar, so it works from the 10:15 bar on.
const BASE = flatBars("M15", "2024-01-08T10:00", 40, 1.1);
const PLACED = "2024-01-08T10:15";

function limitBuy(overrides: Partial<Signal> = {}, limit: Partial<NonNullable<Signal["limit"]>> = {}): Signal {
  return {
    kind: "entry",
    direction: "BUY",
    stopLoss: { price: 1.097 },
    takeProfit: { price: 1.103 },
    limit: { price: 1.099, cancelAt: 1.101, ...limit },
    partial: { price: 1.101, fraction: 0.5, breakeven: true },
    reason: "test",
    ...overrides,
  };
}

/** Bars with the given server times patched (high, low, open, close). */
function patched(changes: Record<string, Partial<{ open: number; high: number; low: number; close: number; spreadPoints: number }>>) {
  let bars = BASE;
  for (const [iso, patch] of Object.entries(changes)) bars = withBar(bars, indexAt(bars, iso), patch);
  return bars;
}

function run(bars = BASE, script: Record<string, StrategyAction> = { [PLACED]: limitBuy() }, config = testConfig()): BacktestResult {
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: scripted(script),
    span: { start: (bars[0] as { time: number }).time, end: (bars.at(-1) as { time: number }).time + 15 * 60_000 },
    config,
  });
}

const only = (result: BacktestResult): Trade => {
  expect(result.trades).toHaveLength(1);
  return result.trades[0] as Trade;
};

describe("limit entry", () => {
  it("rests from the next bar and fills at its price when the Ask reaches it", () => {
    const trade = only(run(patched({ "2024-01-08T10:45": { low: 1.0985 } })));
    expect(trade.entryTime).toBe(at("2024-01-08T10:45"));
    expect(trade.entryPrice).toBe(1.099);
    expect(trade.stopLoss).toBe(1.097);
    expect(trade.lots).toBe(0.25);
  });

  it("needs the Ask, Bid low plus the spread, to reach a buy limit", () => {
    const spread = 60; // 6 pips: 1.0985 + 0.0006 misses 1.0990, 1.0980 + 0.0006 reaches it
    const notYet = run(patched({ "2024-01-08T10:30": { low: 1.0985, spreadPoints: spread } }));
    expect(notYet.trades).toEqual([]);
    const filled = only(run(patched({ "2024-01-08T10:30": { low: 1.098, spreadPoints: spread } })));
    expect(filled.entryPrice).toBe(1.099);
    expect(filled.spreadCostUsd).toBeGreaterThan(0);
    expect(filled.slippageCostUsd).toBe(0);
  });

  it("fills at the open when the bar opens beyond the limit", () => {
    const trade = only(run(patched({ "2024-01-08T10:30": { open: 1.098, high: 1.098, low: 1.0975, close: 1.098 } })));
    expect(trade.entryPrice).toBe(1.098);
  });

  it("is cancelled when the price reaches the cancel level first, or in the same bar", () => {
    const first = run(patched({ "2024-01-08T10:30": { high: 1.1012 }, "2024-01-08T10:45": { low: 1.0985 } }));
    expect(first.trades).toEqual([]);
    expect(first.skipped.map((item) => item.reason)).toEqual(["order-cancelled"]);
    const same = run(patched({ "2024-01-08T10:30": { high: 1.1012, low: 1.0985 } }));
    expect(same.trades).toEqual([]);
    expect(same.skipped.map((item) => item.reason)).toEqual(["order-cancelled"]);
  });

  it("expires at the first bar that opens at its time", () => {
    const result = run(patched({ "2024-01-08T11:00": { low: 1.0985 } }), { [PLACED]: limitBuy({}, { expiresAt: at("2024-01-08T11:00") }) });
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["order-expired"]);
  });

  it("is replaced by a new limit signal and withdrawn by a cancel signal", () => {
    const replaced = run(patched({ "2024-01-08T11:00": { low: 1.0985 } }), {
      [PLACED]: limitBuy(),
      "2024-01-08T10:30": limitBuy({}, { price: 1.098 }),
    });
    expect(replaced.trades).toEqual([]);
    // The new order at 1.0980 is never reached and lapses with the data.
    expect(replaced.skipped.map((item) => [item.reason, item.detail])).toEqual([
      ["order-cancelled", "заменён новым ордером"],
      ["order-expired", "набор закончился раньше исполнения"],
    ]);
    const withdrawn = run(patched({ "2024-01-08T11:00": { low: 1.0985 } }), {
      [PLACED]: limitBuy(),
      "2024-01-08T10:30": { kind: "cancel", reason: "отмена" },
    });
    expect(withdrawn.trades).toEqual([]);
    expect(withdrawn.skipped.map((item) => item.reason)).toEqual(["order-cancelled"]);
  });

  it("checks only the stop in the bar of the fill", () => {
    const stopped = only(run(patched({ "2024-01-08T10:30": { low: 1.0965 } })));
    expect([stopped.exitReason, stopped.exitPrice, stopped.exitTime]).toEqual(["stop", 1.097, at("2024-01-08T10:30")]);
    // The same bar reaching the partial level and the take does not count them.
    const later = only(run(patched({ "2024-01-08T10:30": { low: 1.0985, high: 1.1035 }, "2024-01-08T10:45": { high: 1.1035 } }), {
      [PLACED]: limitBuy({}, { cancelAt: 1.2 }),
    }));
    expect(later.exitTime).toBe(at("2024-01-08T10:45"));
  });

  it("lets the strategy see its resting order", () => {
    const seen: (string | null)[] = [];
    const strategy: Strategy = {
      name: "Watcher",
      params: {},
      executionTimeframe: "M15",
      create: () => ({
        onBarClose(ctx: MarketContext) {
          seen.push(ctx.order === null ? null : `${ctx.order.direction} ${ctx.order.price}`);
          return ctx.now === at(PLACED) ? limitBuy() : null;
        },
      }),
    };
    runBacktest({ data: [symbolData("EURUSD", BASE)], strategy, span: { start: at("2024-01-08T10:00"), end: at("2024-01-08T10:45") }, config: testConfig() });
    // Closes at 10:15 (the order is placed), 10:30 and 10:45: the bars never come down to 1.0990.
    expect(seen).toEqual([null, "BUY 1.099", "BUY 1.099"]);
  });

  it("mirrors for a sell limit: filled by the Bid high, cancelled by the Bid low", () => {
    const sell: Signal = {
      kind: "entry",
      direction: "SELL",
      stopLoss: { price: 1.103 },
      takeProfit: { price: 1.097 },
      limit: { price: 1.101, cancelAt: 1.099 },
      partial: { price: 1.099, fraction: 0.5, breakeven: true },
      reason: "test",
    };
    const filled = only(run(patched({ "2024-01-08T10:30": { high: 1.1015 }, "2024-01-08T10:45": { low: 1.0965 } }), { [PLACED]: sell }));
    expect([filled.direction, filled.entryPrice, filled.exitReason, filled.partialPrice]).toEqual(["SELL", 1.101, "take", 1.099]);
    const cancelled = run(patched({ "2024-01-08T10:30": { low: 1.0985 } }), { [PLACED]: sell });
    expect(cancelled.skipped.map((item) => item.reason)).toEqual(["order-cancelled"]);
  });
});

describe("partial close", () => {
  const filledAt1045 = { "2024-01-08T10:45": { low: 1.0985 } };

  it("closes half at the level and moves the rest to breakeven from the next bar", () => {
    const trade = only(
      run(patched({ ...filledAt1045, "2024-01-08T11:00": { high: 1.1012 }, "2024-01-08T11:30": { low: 1.0985 } }), {
        [PLACED]: limitBuy({}, { cancelAt: 1.2 }),
      }),
    );
    expect([trade.partialTime, trade.partialPrice, trade.partialLots]).toEqual([at("2024-01-08T11:00"), 1.101, 0.12]);
    expect([trade.exitReason, trade.exitPrice, trade.stopAtExit]).toEqual(["breakeven", 1.099, 1.099]);
    expect(trade.breakevenTime).toBe(at("2024-01-08T11:15"));
    // 0.12 lot × 20 pips × 10 USD on the half, nothing on the rest; risk is 0.25 lot × 20 pips.
    expect(trade.netPnlUsd).toBeCloseTo(24, 6);
    expect(trade.rMultiple).toBeCloseTo(0.48, 6);
  });

  it("does not move the stop inside the bar that reached the level", () => {
    const trade = only(
      run(patched({ ...filledAt1045, "2024-01-08T11:00": { high: 1.1012, low: 1.0985 }, "2024-01-08T11:15": { high: 1.1035 } }), {
        [PLACED]: limitBuy({}, { cancelAt: 1.2 }),
      }),
    );
    expect([trade.exitReason, trade.exitPrice]).toEqual(["take", 1.103]);
  });

  it("takes the half and the rest in one bar that reaches both levels", () => {
    const trade = only(run(patched({ ...filledAt1045, "2024-01-08T11:00": { high: 1.1035 } }), { [PLACED]: limitBuy({}, { cancelAt: 1.2 }) }));
    expect([trade.exitReason, trade.partialPrice, trade.exitPrice]).toEqual(["take", 1.101, 1.103]);
    // 0.12 lot × 20 pips + 0.13 lot × 40 pips, 10 USD a pip a lot.
    expect(trade.netPnlUsd).toBeCloseTo(76, 6);
  });

  it("counts a stop when one bar reaches the stop and the partial level", () => {
    const trade = only(run(patched({ ...filledAt1045, "2024-01-08T11:00": { high: 1.1012, low: 1.0965 } }), { [PLACED]: limitBuy({}, { cancelAt: 1.2 }) }));
    expect([trade.exitReason, trade.partialPrice]).toEqual(["stop", null]);
    expect(trade.rMultiple).toBeCloseTo(-1, 6);
  });

  it("only moves the stop when the lot cannot be halved", () => {
    const trade = only(
      run(patched({ ...filledAt1045, "2024-01-08T11:00": { high: 1.1012 }, "2024-01-08T11:30": { low: 1.0985 } }), { [PLACED]: limitBuy({}, { cancelAt: 1.2 }) }, testConfig({ riskPerTradePct: 0.02 })),
    );
    expect(trade.lots).toBe(0.01);
    expect([trade.partialPrice, trade.exitReason, trade.netPnlUsd]).toEqual([null, "breakeven", 0]);
  });

  it("charges commission and spread on both parts and writes the partial to trades.csv", () => {
    const config = testConfig({ commissionPerLotRoundTrip: 7 });
    const result = run(patched({ ...filledAt1045, "2024-01-08T11:00": { high: 1.1035 } }), { [PLACED]: limitBuy({}, { cancelAt: 1.2 }) }, config);
    const trade = only(result);
    expect(trade.commissionUsd).toBeCloseTo(7 * 0.25, 9);
    expect(trade.netPnlUsd).toBeCloseTo(76 - 1.75, 6);
    const [header, row] = tradesToCsv(result.trades, "Europe/Athens", config).split("\r\n");
    expect(header?.split(",").slice(-3)).toEqual(["partial_server", "partial_price", "partial_lots"]);
    expect(row?.split(",").slice(-3)).toEqual(["2024-01-08 11:00", "1.10100", "0.12"]);
  });
});
