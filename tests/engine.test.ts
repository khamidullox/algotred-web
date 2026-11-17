import { describe, expect, it } from "vitest";
import { runBacktest, type SymbolData } from "../src/engine/backtest";
import { swapNights } from "../src/engine/costs";
import { lotsForRisk } from "../src/engine/sizing";
import { SYMBOL_SPECS } from "../src/engine/symbols";
import type {
  BacktestResult,
  MarketContext,
  Strategy,
  StrategyAction,
  Trade,
} from "../src/engine/types";
import {
  at,
  buy,
  exit,
  flatBars,
  indexAt,
  scripted,
  sell,
  symbolData,
  testConfig,
  truncate,
  withBar,
  ZONE,
} from "./helpers/bars";

// Monday 2024-05-06 to Friday 2024-05-10, server time: no clock change, no holiday.
const WEEK_START = "2024-05-06T00:00";
const WEEK_BARS = 5 * 96;
const PRICE = 1.1;
const EURUSD = SYMBOL_SPECS.EURUSD;
const USDJPY = SYMBOL_SPECS.USDJPY;

/** The whole week, open to the strategy. */
const week = { start: at(WEEK_START), end: at("2024-05-11T00:00") };

function run(
  data: SymbolData | SymbolData[],
  strategy: Strategy,
  config = testConfig(),
  options?: { costMultiplier?: number; usdExposureLimit?: boolean },
): BacktestResult {
  return runBacktest({
    data: Array.isArray(data) ? data : [data],
    strategy,
    span: week,
    config,
    options,
  });
}

function only(result: BacktestResult): Trade {
  expect(result.trades).toHaveLength(1);
  return result.trades[0] as Trade;
}

const round = (value: number, digits = 6): number =>
  Math.round(value * 10 ** digits) / 10 ** digits;

describe("test 7: a hand-made set gives exactly the expected trades", () => {
  // Flat market at 1.10000 with a 1-pip spread. A buy signal at 10:00 Monday
  // with a 20-pip stop and a 2R take; the take is reached on Monday 12:00.
  const m15 = withBar(
    flatBars("M15", WEEK_START, WEEK_BARS, PRICE, 10),
    indexAt(flatBars("M15", WEEK_START, WEEK_BARS, PRICE), "2024-05-06T12:00"),
    { high: 1.1045 },
  );
  const result = run(
    symbolData("EURUSD", m15),
    scripted({ "2024-05-06T10:00": buy(0.002, 2) }),
  );
  const trade = only(result);

  it("enters at the next open, at the Ask", () => {
    expect(trade.signalTime).toBe(at("2024-05-06T10:00"));
    expect(trade.entryTime).toBe(at("2024-05-06T10:00"));
    expect(trade.entryPrice).toBe(1.1001);
  });

  it("places the stop and the take from the actual fill", () => {
    expect(trade.stopLoss).toBe(1.0981);
    expect(trade.takeProfit).toBe(1.1041);
    expect(trade.stopDistance).toBe(0.002);
  });

  it("sizes the position from the risk and the stop", () => {
    // 0.5% of 10 000 = 50 USD; 20 pips at 10 USD per pip per lot = 0.25 lot.
    expect(trade.lots).toBe(0.25);
    expect(trade.riskUsd).toBeCloseTo(50, 6);
  });

  it("exits at the take and books 2R", () => {
    expect(trade.exitReason).toBe("take");
    expect(trade.exitTime).toBe(at("2024-05-06T12:00"));
    expect(trade.exitPrice).toBe(1.1041);
    expect(round(trade.grossPnlUsd)).toBe(102.5);
    expect(round(trade.spreadCostUsd)).toBe(2.5);
    expect(round(trade.netPnlUsd)).toBe(100);
    expect(trade.rMultiple).toBeCloseTo(2, 6);
    expect(round(result.finalBalance)).toBe(10_100);
    expect(trade.nights).toBe(0);
  });

  it("keeps no skipped signals", () => {
    expect(result.skipped).toEqual([]);
  });
});

describe("test 2: the stop counts before the take in one bar", () => {
  const base = flatBars("M15", WEEK_START, WEEK_BARS, PRICE);
  const index = indexAt(base, "2024-05-06T11:00");

  it("for a buy", () => {
    const m15 = withBar(base, index, { high: 1.106, low: 1.095 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": buy(0.002, 2) })),
    );
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitPrice).toBe(1.098);
    expect(trade.rMultiple).toBeCloseTo(-1, 6);
  });

  it("for a sell", () => {
    const m15 = withBar(base, index, { high: 1.106, low: 1.095 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": sell(0.002, 2) })),
    );
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitPrice).toBe(1.102);
    expect(trade.rMultiple).toBeCloseTo(-1, 6);
  });
});

describe("test 3: a gap through the stop fills at the open", () => {
  const base = flatBars("M15", WEEK_START, WEEK_BARS, PRICE);
  const index = indexAt(base, "2024-05-06T11:00");

  it("for a buy", () => {
    const m15 = withBar(base, index, { open: 1.09, high: 1.0905, low: 1.0895, close: 1.09 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": buy(0.002) })),
    );
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitPrice).toBe(1.09);
    // 100 pips lost on a 20-pip stop.
    expect(trade.rMultiple).toBeCloseTo(-5, 6);
  });

  it("for a sell, at the Ask of the open", () => {
    const m15 = withBar(
      flatBars("M15", WEEK_START, WEEK_BARS, PRICE, 10),
      index,
      { open: 1.11, high: 1.1105, low: 1.1095, close: 1.11 },
    );
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": sell(0.002) })),
    );
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitPrice).toBe(1.1101);
    expect(trade.spreadCostUsd).toBeCloseTo(0.0001 * 0.25 * 100_000, 6);
  });

  it("a gap through the take also fills at the open", () => {
    const m15 = withBar(base, index, { open: 1.11, high: 1.1105, low: 1.1095, close: 1.11 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": buy(0.002, 2) })),
    );
    expect(trade.exitReason).toBe("take");
    expect(trade.exitPrice).toBe(1.11);
  });
});

describe("a sell is closed at the Ask", () => {
  const base = flatBars("M15", WEEK_START, WEEK_BARS, PRICE, 10);
  const index = indexAt(base, "2024-05-06T11:00");

  it("hits the stop when high + spread reaches it", () => {
    // Entry 1.10000 (Bid), stop 1.10200. The Bid high is 1.10190: the Ask is 1.10200.
    const m15 = withBar(base, index, { high: 1.1019 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": sell(0.002) })),
    );
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitPrice).toBe(1.102);
  });

  it("does not hit the stop on the Bid alone", () => {
    const m15 = withBar(base, index, { high: 1.1018 });
    const result = run(
      symbolData("EURUSD", m15),
      scripted({ "2024-05-06T10:00": sell(0.002) }),
    );
    expect(only(result).exitReason).toBe("end-of-data");
  });

  it("hits the take when low + spread reaches it", () => {
    const m15 = withBar(base, index, { low: 1.0959 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": sell(0.002, 2) })),
    );
    expect(trade.exitReason).toBe("take");
    expect(trade.exitPrice).toBe(1.096);
    expect(trade.rMultiple).toBeCloseTo(2, 6);
  });
});

describe("test 4: every cost changes the result by its own amount", () => {
  // Buy Monday 10:00, 50-pip stop (0.10 lot), exit by the strategy at the open
  // of Thursday 10:00 at the same price. The file spread is 10 points, so the
  // trade loses exactly the spread when every other cost is zero.
  const m15 = flatBars("M15", WEEK_START, WEEK_BARS, PRICE, 10);
  const data = symbolData("EURUSD", m15);
  const strategy = scripted({
    "2024-05-06T10:00": buy(0.005),
    "2024-05-09T10:00": exit(),
  });
  const trade = (config = testConfig(), costMultiplier?: number): Trade =>
    only(run(data, strategy, config, { costMultiplier }));

  it("loses only the spread when the other costs are zero", () => {
    const flat = trade();
    expect(flat.lots).toBe(0.1);
    expect(flat.exitReason).toBe("strategy");
    expect(flat.exitTime).toBe(at("2024-05-09T10:00"));
    expect(round(flat.grossPnlUsd)).toBe(0);
    expect(flat.netPnlUsd).toBeCloseTo(-1, 6);
  });

  it("spread: the file spread, but not below minSpreadPoints", () => {
    // 10 points in the file: 1 pip on 0.10 lot = 1 USD.
    expect(trade().spreadCostUsd).toBeCloseTo(1, 6);
    // The floor raises it to 30 points.
    const floored = trade(testConfig({ minSpreadPoints: 30 }));
    expect(floored.spreadCostUsd).toBeCloseTo(3, 6);
    expect(floored.netPnlUsd).toBeCloseTo(-3, 6);
  });

  it("commission: per lot, once per trade", () => {
    const result = trade(testConfig({ commissionPerLotRoundTrip: 7 }));
    expect(result.commissionUsd).toBeCloseTo(0.7, 6);
    expect(result.netPnlUsd).toBeCloseTo(-1 - 0.7, 6);
  });

  it("slippage: on the entry and on the exit, against the trader", () => {
    const result = trade(testConfig({ slippagePips: 0.2 }));
    expect(result.entryPrice).toBe(1.10012);
    expect(result.exitPrice).toBe(1.09998);
    expect(result.slippageCostUsd).toBeCloseTo(0.4, 6);
    expect(result.netPnlUsd).toBeCloseTo(-1 - 0.4, 6);
  });

  it("swap: per night, three on Wednesday, in the direction of the trade", () => {
    // Monday 10:00 to Thursday 10:00 crosses the nights of Monday, Tuesday and
    // Wednesday: 1 + 1 + 3 = 5 nights at -0.5 pip on 0.10 lot.
    const swap = { swapLongPips: -0.5, swapShortPips: 0.3 };
    const long = trade(testConfig({ swap: { EURUSD: swap } }));
    expect(long.nights).toBe(3);
    expect(long.swapUsd).toBeCloseTo(-2.5, 6);
    expect(long.netPnlUsd).toBeCloseTo(-1 - 2.5, 6);

    const short = only(
      run(
        data,
        scripted({ "2024-05-06T10:00": sell(0.005), "2024-05-09T10:00": exit() }),
        testConfig({ swap: { EURUSD: swap } }),
      ),
    );
    expect(short.swapUsd).toBeCloseTo(1.5, 6);
  });

  it("stress test doubles spread, commission and slippage but not swap", () => {
    const config = testConfig({
      minSpreadPoints: 30,
      commissionPerLotRoundTrip: 7,
      slippagePips: 0.2,
      swap: { EURUSD: { swapLongPips: -0.5, swapShortPips: 0 } },
    });
    const normal = trade(config);
    const stressed = trade(config, 2);
    expect(stressed.spreadCostUsd).toBeCloseTo(2 * normal.spreadCostUsd, 6);
    expect(stressed.commissionUsd).toBeCloseTo(2 * normal.commissionUsd, 6);
    expect(stressed.slippageCostUsd).toBeCloseTo(2 * normal.slippageCostUsd, 6);
    expect(stressed.swapUsd).toBeCloseTo(normal.swapUsd, 6);
  });

  it("net = gross - spread - slippage - commission + swap", () => {
    const result = trade(
      testConfig({
        minSpreadPoints: 30,
        commissionPerLotRoundTrip: 7,
        slippagePips: 0.2,
        swap: { EURUSD: { swapLongPips: -0.5, swapShortPips: 0 } },
      }),
    );
    expect(result.netPnlUsd).toBeCloseTo(
      result.grossPnlUsd -
        result.spreadCostUsd -
        result.slippageCostUsd -
        result.commissionUsd +
        result.swapUsd,
      9,
    );
  });
});

describe("swap nights", () => {
  it("skips the weekend and counts Wednesday three times", () => {
    // Friday 10:00 to the next Monday 10:00: only the night ending Friday.
    expect(swapNights(at("2024-05-10T10:00"), at("2024-05-13T10:00"), ZONE)).toEqual({
      nights: 1,
      weightedNights: 1,
    });
    // Tuesday 10:00 to Thursday 10:00: Tuesday night and the triple Wednesday night.
    expect(swapNights(at("2024-05-07T10:00"), at("2024-05-09T10:00"), ZONE)).toEqual({
      nights: 2,
      weightedNights: 4,
    });
  });

  it("does not charge the night a position is opened at midnight, charges the night it is closed at midnight", () => {
    expect(swapNights(at("2024-05-07T00:00"), at("2024-05-07T10:00"), ZONE)).toEqual({
      nights: 0,
      weightedNights: 0,
    });
    expect(swapNights(at("2024-05-06T10:00"), at("2024-05-07T00:00"), ZONE)).toEqual({
      nights: 1,
      weightedNights: 1,
    });
  });

  it("uses server midnight across a clock change", () => {
    // Athens moves to summer time on 2024-03-31. Midnight stays midnight.
    expect(swapNights(at("2024-03-29T10:00"), at("2024-04-02T10:00"), ZONE)).toEqual({
      nights: 2,
      weightedNights: 2,
    });
  });
});

describe("test 5: lot size", () => {
  it("EURUSD: 50 USD risk, 20-pip stop gives 0.25 lot", () => {
    expect(lotsForRisk(EURUSD, 50, 0.002, 1.1)).toBe(0.25);
  });

  it("rounds down to 0.01", () => {
    // 50 / (23 pips * 10 USD) = 0.2173...
    expect(lotsForRisk(EURUSD, 50, 0.0023, 1.1)).toBe(0.21);
    // 50 / (16.6666 pips * 10) = 0.3000000 and a floating-point hair under it.
    expect(lotsForRisk(EURUSD, 50, 0.0016666666666666668, 1.1)).toBe(0.3);
  });

  it("USDJPY: the pip value depends on the price", () => {
    // 1000 / 150 = 6.6667 USD per pip per lot; 30 pips risk 200 USD per lot.
    expect(lotsForRisk(USDJPY, 50, 0.3, 150)).toBe(0.25);
    // At 100.000 a pip is 10 USD, as for EURUSD.
    expect(lotsForRisk(USDJPY, 50, 0.3, 100)).toBe(0.16);
  });

  it("returns 0 below 0.01 lot", () => {
    expect(lotsForRisk(EURUSD, 50, 0.06, 1.1)).toBe(0);
    expect(lotsForRisk(EURUSD, 0, 0.002, 1.1)).toBe(0);
  });

  it("the engine skips the trade and counts it", () => {
    const m15 = flatBars("M15", WEEK_START, WEEK_BARS, PRICE);
    const result = run(
      symbolData("EURUSD", m15),
      scripted({ "2024-05-06T10:00": buy(0.06) }),
    );
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(["lot-too-small"]);
  });

  it("USDJPY trades are booked in USD at the exit price", () => {
    const m15 = withBar(
      flatBars("M15", WEEK_START, WEEK_BARS, 150, 0),
      indexAt(flatBars("M15", WEEK_START, WEEK_BARS, 150), "2024-05-06T12:00"),
      { high: 150.7 },
    );
    const trade = only(
      run(symbolData("USDJPY", m15), scripted({ "2024-05-06T10:00": buy(0.3, 2) })),
    );
    expect(trade.lots).toBe(0.25);
    expect(trade.takeProfit).toBe(150.6);
    // 60 pips * 0.25 lot * 1000 JPY per pip per lot = 15 000 JPY at 150.60.
    expect(trade.netPnlUsd).toBeCloseTo(15_000 / 150.6, 6);
    // The risk is valued at the entry price, so the R is a little above 2.
    expect(trade.rMultiple).toBeCloseTo((15_000 / 150.6) / (7_500 / 150), 6);
  });
});

describe("position rules", () => {
  const base = flatBars("M15", WEEK_START, WEEK_BARS, PRICE);

  it("one position per pair: an entry while one is open is skipped", () => {
    const result = run(
      symbolData("EURUSD", base),
      scripted({
        "2024-05-06T10:00": buy(0.002),
        "2024-05-06T11:00": buy(0.002),
        "2024-05-06T12:00": exit(),
      }),
    );
    expect(result.trades).toHaveLength(1);
    expect(result.skipped).toMatchObject([
      { reason: "position-open", signalTime: at("2024-05-06T11:00") },
    ]);
  });

  it("a strategy exit is executed at the next open", () => {
    const m15 = withBar(base, indexAt(base, "2024-05-06T12:00"), {
      open: 1.103,
      high: 1.104,
      low: 1.102,
      close: 1.1035,
    });
    const trade = only(
      run(
        symbolData("EURUSD", m15),
        scripted({ "2024-05-06T10:00": buy(0.002), "2024-05-06T12:00": exit() }),
      ),
    );
    expect(trade.exitReason).toBe("strategy");
    expect(trade.exitTime).toBe(at("2024-05-06T12:00"));
    expect(trade.exitPrice).toBe(1.103);
  });

  it("an exit without a position is ignored", () => {
    const result = run(symbolData("EURUSD", base), scripted({ "2024-05-06T10:00": exit() }));
    expect(result.trades).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  it("a signal on the last bar of the dataset is not filled", () => {
    const result = run(
      symbolData("EURUSD", base),
      scripted({ "2024-05-11T00:00": buy(0.002) }),
    );
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(["no-next-bar"]);
  });

  it("a position open at the end is closed at the last close and marked", () => {
    const m15 = withBar(base, WEEK_BARS - 1, { close: 1.105 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-10T10:00": buy(0.002) })),
    );
    expect(trade.exitReason).toBe("end-of-data");
    expect(trade.exitTime).toBe(at("2024-05-11T00:00"));
    expect(trade.exitPrice).toBe(1.105);
  });

  it("the stop filter drops a trade whose actual stop is too far", () => {
    const m15 = withBar(base, indexAt(base, "2024-05-06T10:00"), {
      open: 1.102,
      high: 1.102,
      low: 1.1,
      close: 1.1,
    });
    const action: StrategyAction = {
      kind: "entry",
      direction: "BUY",
      stopLoss: { price: 1.099 },
      takeProfit: null,
      maxStopDistance: 0.0025,
      reason: "test",
    };
    // The signal at the 10:00 close is filled at the open of the 10:00 bar, 1.10200.
    const result = run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": action }));
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(["stop-too-far"]);
  });

  it("the minimum-stop filter drops a trade whose actual stop is too close", () => {
    const action: StrategyAction = {
      kind: "entry",
      direction: "BUY",
      stopLoss: { price: 1.0996 },
      takeProfit: null,
      minStopDistance: 0.0005,
      reason: "test",
    };
    const result = run(symbolData("EURUSD", base), scripted({ "2024-05-06T10:00": action }));
    expect(result.trades).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(["stop-too-close"]);
    // Exactly the minimum passes.
    const exact = run(
      symbolData("EURUSD", base),
      scripted({ "2024-05-06T10:00": { ...action, stopLoss: { price: 1.0995 } } }),
    );
    expect(exact.trades).toHaveLength(1);
  });

  it("a stop on the wrong side of the fill is rejected", () => {
    const action: StrategyAction = {
      kind: "entry",
      direction: "BUY",
      stopLoss: { price: 1.101 },
      takeProfit: null,
      reason: "test",
    };
    const result = run(symbolData("EURUSD", base), scripted({ "2024-05-06T10:00": action }));
    expect(result.skipped.map((skip) => skip.reason)).toEqual(["invalid-levels"]);
  });

  it("drops a signal whose next bar does not open at the expected time", () => {
    // No bars from 10:15 to 11:45: after the 10:00 close the next bar is 12:00.
    const gapped = base.filter(
      (item) => item.time < at("2024-05-06T10:15") || item.time >= at("2024-05-06T12:00"),
    );
    const strict = (): StrategyAction => ({
      ...(buy(0.002) as Extract<StrategyAction, { kind: "entry" }>),
      expectedEntryTime: at("2024-05-06T10:15"),
    });
    const result = run(symbolData("EURUSD", gapped), scripted({ "2024-05-06T10:15": strict() }));
    expect(result.trades).toEqual([]);
    expect(result.skipped).toMatchObject([
      { reason: "gap-after-signal", signalTime: at("2024-05-06T10:15") },
    ]);
    expect(result.skipped[0]?.detail).toContain("12:00");
    // The same signal on the unbroken series is filled at 10:15.
    const filled = run(symbolData("EURUSD", base), scripted({ "2024-05-06T10:15": strict() }));
    expect(filled.trades).toHaveLength(1);
    expect(filled.trades[0]?.entryTime).toBe(at("2024-05-06T10:15"));
  });

  it("the second trade is sized from the balance after the first", () => {
    const m15 = withBar(base, indexAt(base, "2024-05-06T12:00"), { high: 1.1045 });
    const result = run(
      symbolData("EURUSD", m15),
      scripted({ "2024-05-06T10:00": buy(0.002, 2), "2024-05-07T10:00": buy(0.002) }),
    );
    expect(result.trades).toHaveLength(2);
    const second = result.trades[1] as Trade;
    // 0.5% of 10 100 = 50.5 USD; 20 pips -> 0.2525 -> 0.25 lot.
    expect(second.lots).toBe(0.25);
    expect(second.riskUsd).toBeCloseTo(50, 6);
  });
});

describe("maximum adverse and favourable excursion", () => {
  const base = flatBars("M15", WEEK_START, WEEK_BARS, PRICE);

  it("measures the extremes on the Bid for a buy, including the entry bar", () => {
    // Entry 1.10000 at 10:15 (20-pip stop). 10:15 dips to 1.0990, 11:00 reaches
    // 1.1030, the strategy leaves at the 12:00 open at 1.1010.
    let m15 = withBar(base, indexAt(base, "2024-05-06T10:15"), { low: 1.099 });
    m15 = withBar(m15, indexAt(m15, "2024-05-06T11:00"), { high: 1.103 });
    m15 = withBar(m15, indexAt(m15, "2024-05-06T12:00"), { open: 1.101, high: 1.101, low: 1.101, close: 1.101 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:15": buy(0.002), "2024-05-06T12:00": exit() })),
    );
    expect(trade.exitPrice).toBe(1.101);
    expect(trade.maePrice).toBeCloseTo(0.001, 9);
    expect(trade.mfePrice).toBeCloseTo(0.003, 9);
    expect(trade.maeR).toBeCloseTo(0.5, 9);
    expect(trade.mfeR).toBeCloseTo(1.5, 9);
  });

  it("caps the adverse excursion of a stopped trade at the realised loss", () => {
    // The stop bar's low overshoots the stop by 30 pips: the loss is still 1R.
    const m15 = withBar(base, indexAt(base, "2024-05-06T11:00"), { low: 1.095 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": buy(0.002) })),
    );
    expect(trade.exitReason).toBe("stop");
    expect(trade.maeR).toBeCloseTo(1, 9);
    // A gap beyond the stop is a real loss and is counted in full.
    const gapped = withBar(base, indexAt(base, "2024-05-06T11:00"), { open: 1.09, high: 1.0905, low: 1.0895, close: 1.09 });
    expect(only(run(symbolData("EURUSD", gapped), scripted({ "2024-05-06T10:00": buy(0.002) }))).maeR).toBeCloseTo(5, 9);
  });

  it("caps the favourable excursion of a take at the realised gain", () => {
    const m15 = withBar(base, indexAt(base, "2024-05-06T12:00"), { high: 1.109 });
    const trade = only(
      run(symbolData("EURUSD", m15), scripted({ "2024-05-06T10:00": buy(0.002, 2) })),
    );
    expect(trade.exitReason).toBe("take");
    expect(trade.mfeR).toBeCloseTo(2, 9);
    expect(trade.maeR).toBe(0);
  });

  it("measures a sell on the Ask, so the spread counts against it", () => {
    // 1-pip spread. Sell at 1.10000; the 11:00 bar's Bid high is 1.1009, Ask 1.1010.
    const withSpread = flatBars("M15", WEEK_START, WEEK_BARS, PRICE, 10);
    const m15 = withBar(withSpread, indexAt(withSpread, "2024-05-06T11:00"), { high: 1.1009, low: 1.0985 });
    const trade = only(
      run(
        symbolData("EURUSD", m15),
        scripted({ "2024-05-06T10:00": sell(0.002), "2024-05-06T12:00": exit() }),
      ),
    );
    expect(trade.exitReason).toBe("strategy");
    expect(trade.maePrice).toBeCloseTo(0.001, 9);
    // Favourable: lowest Ask 1.0985 + 0.0001 = 1.0986, 14 pips below the entry.
    expect(trade.mfePrice).toBeCloseTo(0.0014, 9);
  });
});

describe("several pairs on one account", () => {
  const eurusd = symbolData(
    "EURUSD",
    withBar(
      flatBars("M15", WEEK_START, WEEK_BARS, PRICE),
      indexAt(flatBars("M15", WEEK_START, WEEK_BARS, PRICE), "2024-05-06T12:00"),
      { high: 1.1045 },
    ),
  );
  const usdjpy = symbolData("USDJPY", flatBars("M15", WEEK_START, WEEK_BARS, 150));

  it("a profit on one pair raises the balance used for the next trade on another", () => {
    // EURUSD takes 3R (+150 USD) at 12:00; both pairs enter again at 14:00.
    const eurusd3r = symbolData(
      "EURUSD",
      withBar(
        flatBars("M15", WEEK_START, WEEK_BARS, PRICE),
        indexAt(flatBars("M15", WEEK_START, WEEK_BARS, PRICE), "2024-05-06T12:00"),
        { high: 1.1065 },
      ),
    );
    const result = run([eurusd3r, usdjpy], {
      ...scripted({}),
      create: (symbol) => ({
        onBarClose: (ctx: MarketContext) => {
          if (ctx.now === at("2024-05-06T10:00") && symbol === "EURUSD") return buy(0.002, 3);
          if (ctx.now === at("2024-05-06T14:00")) {
            return symbol === "EURUSD" ? buy(0.0011) : buy(0.33);
          }
          return null;
        },
      }),
    });
    const first = result.trades.find((trade) => trade.signalTime === at("2024-05-06T10:00"));
    expect(first?.netPnlUsd).toBeCloseTo(150, 6);
    const later = result.trades.filter((trade) => trade.signalTime === at("2024-05-06T14:00"));
    expect(later.map((trade) => [trade.symbol, trade.lots])).toEqual([
      // 0.5% of 10 150 = 50.75 USD. 11 pips: 0.4613 -> 0.46 (0.45 from 10 000).
      ["EURUSD", 0.46],
      // 33 pips at 6.6667 USD per pip: 0.2307 -> 0.23 (0.22 from 10 000).
      ["USDJPY", 0.23],
    ]);
  });

  it("usdExposureLimit blocks a second trade in the same dollar direction", () => {
    // Buying EURUSD is short USD; selling USDJPY is also short USD.
    const result = run(
      [eurusd, usdjpy],
      {
        ...scripted({}),
        create: (symbol) => ({
          onBarClose: (ctx: MarketContext) =>
            ctx.now === at("2024-05-06T10:00")
              ? symbol === "EURUSD"
                ? buy(0.002)
                : sell(0.3)
              : null,
        }),
      },
      testConfig(),
      { usdExposureLimit: true },
    );
    expect(result.trades.map((trade) => trade.symbol)).toEqual(["EURUSD"]);
    expect(result.skipped).toMatchObject([{ symbol: "USDJPY", reason: "usd-exposure" }]);
  });

  it("without the limit both trades are taken", () => {
    const result = run(
      [eurusd, usdjpy],
      {
        ...scripted({}),
        create: (symbol) => ({
          onBarClose: (ctx: MarketContext) =>
            ctx.now === at("2024-05-06T10:00")
              ? symbol === "EURUSD"
                ? buy(0.002)
                : sell(0.3)
              : null,
        }),
      },
    );
    expect(result.trades).toHaveLength(2);
    expect(result.usdExposureLimit).toBe(false);
  });
});

describe("the market context", () => {
  const m15 = flatBars("M15", WEEK_START, WEEK_BARS, PRICE);
  const data = symbolData("EURUSD", m15);

  it("shows only closed bars and says which timeframes just closed", () => {
    const seen: Array<{ now: number; m15: number; h1: number; d1: number; closed: string[] }> = [];
    const strategy: Strategy = {
      name: "Probe",
      params: {},
      executionTimeframe: "M15",
      create: () => ({
        onBarClose: (ctx) => {
          seen.push({
            now: ctx.now,
            m15: ctx.bars("M15").length,
            h1: ctx.bars("H1").length,
            d1: ctx.bars("D1").length,
            closed: ["M15", "H1", "D1"].filter((tf) => ctx.justClosed(tf as "M15")),
          });
          return null;
        },
      }),
    };
    runBacktest({
      data: [data],
      strategy,
      span: { start: at("2024-05-07T00:00"), end: at("2024-05-08T00:00") },
      config: testConfig(),
    });
    expect(seen).toHaveLength(96);
    const first = seen[0];
    // Tuesday 00:15: Monday is history, the first M15 of Tuesday has just closed.
    expect(first).toEqual({ now: at("2024-05-07T00:15"), m15: 97, h1: 24, d1: 1, closed: ["M15"] });
    const hour = seen.find((entry) => entry.now === at("2024-05-07T01:00"));
    expect(hour).toEqual({ now: at("2024-05-07T01:00"), m15: 100, h1: 25, d1: 1, closed: ["M15", "H1"] });
    const day = seen[95];
    expect(day).toEqual({ now: at("2024-05-08T00:00"), m15: 192, h1: 48, d1: 2, closed: ["M15", "H1", "D1"] });
    // Every closed bar ends at or before now.
    for (const entry of seen) {
      expect(entry.m15 * 15 * 60_000 + at(WEEK_START)).toBeLessThanOrEqual(entry.now);
    }
  });

  it("a closed-bars view cannot reach a forming bar", () => {
    let probe: ReturnType<MarketContext["bars"]> | null = null;
    runBacktest({
      data: [data],
      strategy: {
        name: "Probe",
        params: {},
        executionTimeframe: "M15",
        create: () => ({
          onBarClose: (ctx) => {
            if (ctx.now === at("2024-05-06T10:30")) {
              probe = ctx.bars("H1");
              expect(probe.length).toBe(10);
              expect(probe.at(10)).toBeUndefined();
              expect(probe.last()?.time).toBe(at("2024-05-06T09:00"));
              expect(probe.lastN(3).map((bar) => bar.time)).toEqual([
                at("2024-05-06T07:00"),
                at("2024-05-06T08:00"),
                at("2024-05-06T09:00"),
              ]);
              expect(probe.slice(-2, 100)).toHaveLength(2);
              expect(probe.slice(8).length).toBe(2);
            }
            return null;
          },
        }),
      },
      span: week,
      config: testConfig(),
    });
    expect(probe).not.toBeNull();
  });
});

describe("test 1: no look-ahead", () => {
  // A market with some movement, built from a fixed pseudo-random sequence.
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  let price = PRICE;
  const m15 = flatBars("M15", WEEK_START, WEEK_BARS, PRICE, 10).map((bar) => {
    const open = price;
    const close = open + (next() - 0.5) * 0.002;
    const high = Math.max(open, close) + next() * 0.0005;
    const low = Math.min(open, close) - next() * 0.0005;
    price = close;
    return { ...bar, open, high, low, close };
  });
  const data = symbolData("EURUSD", m15);

  // A greedy strategy: it looks at the latest bar of every timeframe.
  function greedy(log: string[]): Strategy {
    return {
      name: "Greedy",
      params: {},
      executionTimeframe: "M15",
      create: () => ({
        onBarClose: (ctx) => {
          const m = ctx.bars("M15").last();
          const h = ctx.bars("H1").last();
          const d = ctx.bars("D1").last();
          if (m === undefined || h === undefined) return null;
          log.push(`${ctx.now}:${m.close}:${h.close}:${d?.close ?? "-"}:${ctx.bars("H1").length}`);
          if (ctx.position !== null) {
            return m.close < h.open ? exit() : null;
          }
          if (m.close > h.high - 0.0001 && (d === undefined || m.close > d.close)) {
            return buy(0.002, 2);
          }
          if (m.close < h.low + 0.0001) {
            return sell(0.002, 2);
          }
          return null;
        },
      }),
    };
  }

  it("signals and trades up to t do not change when the data after t is removed", () => {
    const cutoffs = ["2024-05-07T13:15", "2024-05-08T00:00", "2024-05-09T17:30"];
    for (const cutoff of cutoffs) {
      const t = at(cutoff);
      const fullLog: string[] = [];
      const partLog: string[] = [];
      const full = runBacktest({ data: [data], strategy: greedy(fullLog), span: week, config: testConfig() });
      const part = runBacktest({
        data: [truncate(data, t)],
        strategy: greedy(partLog),
        span: { start: week.start, end: t },
        config: testConfig(),
      });
      expect(partLog.length).toBeGreaterThan(50);
      expect(fullLog.slice(0, partLog.length)).toEqual(partLog);

      const before = (trades: readonly Trade[]): Partial<Trade>[] =>
        trades
          .filter((trade) => trade.exitTime < t && trade.exitReason !== "end-of-data")
          .map(({ signalTime, entryTime, entryPrice, direction, exitTime, exitPrice, exitReason, lots }) => ({
            signalTime, entryTime, entryPrice, direction, exitTime, exitPrice, exitReason, lots,
          }));
      expect(before(full.trades).length).toBeGreaterThan(0);
      expect(before(full.trades)).toEqual(before(part.trades));
    }
  });

  it("the greedy strategy really trades on this data", () => {
    const result = runBacktest({ data: [data], strategy: greedy([]), span: week, config: testConfig() });
    expect(result.trades.length).toBeGreaterThan(3);
  });
});
