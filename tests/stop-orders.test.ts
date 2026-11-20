import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, MarketContext, Signal, Strategy, StrategyAction, StopEntrySpec, Trade } from "../src/engine/types";
import { at, flatBars, indexAt, scripted, symbolData, testConfig, withBar } from "./helpers/bars";

// Stop entry orders (TZ 17.15) on hand-made M15 bars at 1.1000. The order is
// placed at the close of the 10:00 bar, so it works from the 10:15 bar on.
const BASE = flatBars("M15", "2024-01-08T10:00", 40, 1.1);
const PLACED = "2024-01-08T10:15";

function stopBuy(stopEntry: Partial<StopEntrySpec> = {}, overrides: Partial<Signal> = {}): Signal {
  return {
    kind: "entry",
    direction: "BUY",
    stopLoss: { price: 1.099 },
    takeProfit: { rMultiple: 2 },
    stopEntry: { price: 1.101, cancelAt: 1.099, ...stopEntry },
    partial: { rMultiple: 1, fraction: 0.5, breakeven: true },
    reason: "test",
    ...overrides,
  };
}

const stopSell: Signal = {
  kind: "entry",
  direction: "SELL",
  stopLoss: { price: 1.101 },
  takeProfit: { rMultiple: 2 },
  stopEntry: { price: 1.099, cancelAt: 1.101 },
  partial: { rMultiple: 1, fraction: 0.5, breakeven: true },
  reason: "test",
};

type Patch = Partial<{ open: number; high: number; low: number; close: number; spreadPoints: number }>;

function patched(changes: Record<string, Patch>) {
  let bars = BASE;
  for (const [iso, patch] of Object.entries(changes)) bars = withBar(bars, indexAt(bars, iso), patch);
  return bars;
}

function run(bars = BASE, script: Record<string, StrategyAction> = { [PLACED]: stopBuy() }, config = testConfig()): BacktestResult {
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

const skips = (result: BacktestResult): [string, string][] => result.skipped.map((item) => [item.reason, item.detail]);

describe("stop entry", () => {
  it("rests from the next bar and fills at its price when the Ask reaches it", () => {
    const trade = only(run(patched({ "2024-01-08T10:45": { high: 1.1015 } })));
    expect(trade.entryTime).toBe(at("2024-01-08T10:45"));
    expect(trade.signalTime).toBe(at(PLACED));
    expect(trade.entryPrice).toBe(1.101);
    expect(trade.stopLoss).toBe(1.099);
    expect(trade.takeProfit).toBe(1.105);
    expect(trade.lots).toBe(0.25);
  });

  it("does not fill in the bar whose close placed it", () => {
    // The 10:00 bar itself trades through the price; the order starts at 10:15.
    const result = run(patched({ "2024-01-08T10:00": { high: 1.1015 } }));
    expect(result.trades).toEqual([]);
  });

  it("needs the Ask, Bid high plus the spread, to reach a buy stop", () => {
    const spread = 60; // 6 pips: 1.1002 + 0.0006 misses 1.1010, 1.1005 + 0.0006 reaches it
    const notYet = run(patched({ "2024-01-08T10:30": { high: 1.1002, spreadPoints: spread } }));
    expect(notYet.trades).toEqual([]);
    const filled = only(run(patched({ "2024-01-08T10:30": { high: 1.1005, spreadPoints: spread } })));
    expect(filled.entryPrice).toBe(1.101);
    expect(filled.spreadCostUsd).toBeGreaterThan(0);
  });

  it("pays slippage on the fill, and measures the take from the actual entry", () => {
    const trade = only(run(patched({ "2024-01-08T10:45": { high: 1.1015 } }), undefined, testConfig({ slippagePips: 0.2 })));
    expect(trade.entryPrice).toBe(1.10102);
    expect(trade.stopDistance).toBeCloseTo(0.00202, 9);
    expect(trade.takeProfit).toBeCloseTo(1.10506, 9);
    expect(trade.slippageCostUsd).toBeGreaterThan(0);
  });

  it("fills at the open Ask when the bar opens beyond the price", () => {
    const gap = { open: 1.102, high: 1.102, low: 1.1015, close: 1.102 };
    const trade = only(run(patched({ "2024-01-08T10:30": gap })));
    expect(trade.entryPrice).toBe(1.102);
    expect(trade.takeProfit).toBeCloseTo(1.108, 9);
    const withSpread = only(run(patched({ "2024-01-08T10:30": { ...gap, spreadPoints: 20 } })));
    expect(withSpread.entryPrice).toBe(1.1022);
  });

  it("is cancelled when the price reaches the cancel level first", () => {
    const result = run(patched({ "2024-01-08T10:30": { low: 1.0985 }, "2024-01-08T10:45": { high: 1.1015 } }));
    expect(result.trades).toEqual([]);
    expect(skips(result)).toEqual([["order-cancelled", "цена дошла до 1.09900 раньше исполнения"]]);
  });

  it("is cancelled by a bar that opens beyond the cancel level, even if it reaches the price later", () => {
    const result = run(patched({ "2024-01-08T10:30": { open: 1.0985, low: 1.0985, high: 1.1015 } }));
    expect(result.trades).toEqual([]);
    expect(skips(result).map(([reason]) => reason)).toEqual(["order-cancelled"]);
  });

  it("counts a bar that reaches the price and the cancel level as an entry and a stop", () => {
    const trade = only(run(patched({ "2024-01-08T10:30": { low: 1.0985, high: 1.1015 } })));
    expect([trade.entryPrice, trade.exitReason, trade.exitPrice, trade.exitTime]).toEqual([1.101, "stop", 1.099, at("2024-01-08T10:30")]);
    expect(trade.rMultiple).toBeCloseTo(-1, 6);
  });

  it("stops at the level in the fill bar even when that bar opened below the stop", () => {
    // No cancel level: the bar opens under the stop loss, then reaches the price.
    const trade = only(
      run(patched({ "2024-01-08T10:30": { open: 1.0985, low: 1.098, high: 1.1015 } }), { [PLACED]: stopBuy({ cancelAt: undefined }) }),
    );
    expect([trade.exitReason, trade.exitPrice]).toEqual(["stop", 1.099]);
  });

  it("checks only the stop in the bar of the fill", () => {
    // The fill bar reaches the partial level and the take: neither counts there.
    const trade = only(run(patched({ "2024-01-08T10:30": { high: 1.106 }, "2024-01-08T10:45": { high: 1.106 } })));
    expect([trade.entryTime, trade.partialTime, trade.exitTime]).toEqual([at("2024-01-08T10:30"), at("2024-01-08T10:45"), at("2024-01-08T10:45")]);
    expect([trade.partialPrice, trade.exitReason, trade.exitPrice]).toEqual([1.103, "take", 1.105]);
  });

  it("is cancelled when the price reaches it in a bar where it does not work", () => {
    const closed = at("2024-01-08T10:30");
    const signal = stopBuy({ worksAt: (barOpen) => barOpen !== closed });
    const result = run(patched({ "2024-01-08T10:30": { high: 1.1015 }, "2024-01-08T10:45": { high: 1.1015 } }), { [PLACED]: signal });
    expect(result.trades).toEqual([]);
    expect(skips(result)).toEqual([["order-cancelled", "цена дошла до ордера, когда он не работал"]]);
  });

  it("keeps resting through a bar where it does not work and fills later", () => {
    const closed = at("2024-01-08T10:30");
    const signal = stopBuy({ worksAt: (barOpen) => barOpen !== closed });
    const trade = only(run(patched({ "2024-01-08T10:30": { high: 1.1008 }, "2024-01-08T10:45": { high: 1.1015 } }), { [PLACED]: signal }));
    expect(trade.entryTime).toBe(at("2024-01-08T10:45"));
  });

  it("is cancelled by the cancel level in a bar where it does not work, whatever else that bar reached", () => {
    const signal = stopBuy({ worksAt: () => false });
    const result = run(patched({ "2024-01-08T10:30": { low: 1.0985, high: 1.1015 } }), { [PLACED]: signal });
    expect(result.trades).toEqual([]);
    expect(skips(result)).toEqual([["order-cancelled", "цена дошла до 1.09900 раньше исполнения"]]);
  });

  it("expires at the first bar that opens at its time", () => {
    const result = run(patched({ "2024-01-08T11:00": { high: 1.1015 } }), { [PLACED]: stopBuy({ expiresAt: at("2024-01-08T11:00") }) });
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["order-expired"]);
  });

  it("is replaced by a new order and withdrawn by a cancel signal", () => {
    const replaced = only(
      run(patched({ "2024-01-08T11:00": { high: 1.1015 } }), { [PLACED]: stopBuy({ price: 1.102 }), "2024-01-08T10:30": stopBuy() }),
    );
    expect(replaced.entryPrice).toBe(1.101);
    const withdrawn = run(patched({ "2024-01-08T11:00": { high: 1.1015 } }), {
      [PLACED]: stopBuy(),
      "2024-01-08T10:30": { kind: "cancel", reason: "отмена" },
    });
    expect(withdrawn.trades).toEqual([]);
    expect(skips(withdrawn)).toEqual([["order-cancelled", "отмена"]]);
  });

  it("lets the strategy see its resting stop order", () => {
    const seen: (string | null)[] = [];
    const strategy: Strategy = {
      name: "Watcher",
      params: {},
      executionTimeframe: "M15",
      create: () => ({
        onBarClose(ctx: MarketContext) {
          seen.push(ctx.order === null ? null : `${ctx.order.kind} ${ctx.order.direction} ${ctx.order.price}`);
          return ctx.now === at(PLACED) ? stopBuy() : null;
        },
      }),
    };
    runBacktest({ data: [symbolData("EURUSD", BASE)], strategy, span: { start: at("2024-01-08T10:00"), end: at("2024-01-08T10:45") }, config: testConfig() });
    expect(seen).toEqual([null, "stop BUY 1.101", "stop BUY 1.101"]);
  });

  it("refuses a signal that is both a limit and a stop order", () => {
    const both = stopBuy({}, { limit: { price: 1.099 } });
    expect(() => run(BASE, { [PLACED]: both })).toThrow(/лимитным и стоп-ордером/);
  });
});

describe("sell stop", () => {
  it("fills when the Bid low reaches it, at the open when the bar opens below", () => {
    const trade = only(run(patched({ "2024-01-08T10:30": { low: 1.0985 }, "2024-01-08T10:45": { low: 1.0945 } }), { [PLACED]: stopSell }));
    expect([trade.direction, trade.entryPrice, trade.partialPrice, trade.exitReason, trade.exitPrice]).toEqual(["SELL", 1.099, 1.097, "take", 1.095]);
    const gap = only(run(patched({ "2024-01-08T10:30": { open: 1.098, high: 1.0985, low: 1.098, close: 1.098 } }), { [PLACED]: stopSell }));
    expect(gap.entryPrice).toBe(1.098);
  });

  it("pays slippage below its price", () => {
    const trade = only(run(patched({ "2024-01-08T10:30": { low: 1.0985 } }), { [PLACED]: stopSell }, testConfig({ slippagePips: 0.2 })));
    expect(trade.entryPrice).toBe(1.09898);
  });

  it("is cancelled when the Ask, Bid high plus the spread, reaches the cancel level", () => {
    const spread = 60;
    const kept = only(
      run(patched({ "2024-01-08T10:30": { high: 1.1003, spreadPoints: spread }, "2024-01-08T10:45": { low: 1.0985 } }), { [PLACED]: stopSell }),
    );
    expect(kept.entryTime).toBe(at("2024-01-08T10:45"));
    const cancelled = run(patched({ "2024-01-08T10:30": { high: 1.1005, spreadPoints: spread }, "2024-01-08T10:45": { low: 1.0985 } }), { [PLACED]: stopSell });
    expect(cancelled.trades).toEqual([]);
    expect(cancelled.skipped.map((item) => item.reason)).toEqual(["order-cancelled"]);
  });

  it("stops at the level when the Ask reaches the stop in the fill bar", () => {
    const trade = only(run(patched({ "2024-01-08T10:30": { low: 1.0985, high: 1.1015 } }), { [PLACED]: stopSell }));
    expect([trade.entryPrice, trade.exitReason, trade.exitPrice]).toEqual([1.099, "stop", 1.101]);
  });
});

describe("partial close in R", () => {
  it("is measured from the actual fill and moves the rest to breakeven", () => {
    const config = testConfig({ slippagePips: 0.2 });
    const bars = patched({
      "2024-01-08T10:45": { high: 1.1015 },
      "2024-01-08T11:00": { high: 1.1035 },
      // The price stays above the entry, then comes back through it.
      "2024-01-08T11:15": { open: 1.103, high: 1.103, low: 1.102, close: 1.102 },
      "2024-01-08T11:30": { open: 1.102, high: 1.102, low: 1.1005, close: 1.1005 },
    });
    const trade = only(run(bars, undefined, config));
    // Entry 1.10102, risk 20.2 pips: the half goes at 1.10304 less the slippage.
    expect(trade.partialPrice).toBeCloseTo(1.10302, 9);
    expect(trade.partialTime).toBe(at("2024-01-08T11:00"));
    expect([trade.exitReason, trade.stopAtExit]).toEqual(["breakeven", 1.10102]);
    expect(trade.exitPrice).toBeCloseTo(1.101, 9);
  });
});
