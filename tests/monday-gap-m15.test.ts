import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config";
import type { Bar } from "../src/data/types";
import { runBacktest } from "../src/engine/backtest";
import { roundPrice, symbolSpec } from "../src/engine/symbols";
import type { BacktestResult, Trade } from "../src/engine/types";
import { FX_AND_GOLD } from "../src/strategies/baskets";
import { exitTimeAfter, MONDAY_GAP, mondayGapM15, spansSaturdayNoon } from "../src/strategies/monday-gap-m15";
import { at, bar, indexAt, symbolData, testConfig, ZONE } from "./helpers/bars";

const M15 = 15 * 60_000;
const P = 1.2;
const PIP = 0.0001;
const SPEC = symbolSpec(testConfig(), "EURUSD");
const px = (value: number): number => roundPrice(SPEC, value);
/** A price `pips` away from the Friday close of the scenario. */
const m = (pips: number): number => px(P + pips * PIP);

/** Summer weeks: the server is 7 hours ahead of New York, so 16:00 New York is 23:00 server time. */
const HISTORY = "2024-04-15";
const FRIDAY = "2024-05-10";
const MONDAY = "2024-05-13";
const NEXT_MONDAY = "2024-05-20";
const T = (clock: string, day = MONDAY): string => `${day}T${clock}`;

type Ohlc = readonly [open: number, high: number, low: number, close: number];

/**
 * Monday to Friday, every M15 bar of the server day, flat at P. The 12:00 bar
 * of every day spans `spike` pips either side, so a daily bar has a range of
 * twice that: with 50 pips the ATR(14) of D1 is 100 pips and the threshold of
 * rule 4 is 20 pips.
 */
function weeks(firstMonday: string, count: number, spike: (date: string) => number = () => 50): Bar[] {
  const bars: Bar[] = [];
  const start = DateTime.fromISO(`${firstMonday}T00:00`, { zone: ZONE });
  for (let week = 0; week < count; week++) {
    for (let day = 0; day < 5; day++) {
      const midnight = start.plus({ weeks: week, days: day });
      const date = midnight.toFormat("yyyy-LL-dd");
      // No clock change falls inside the weeks of these tests, so a day is 96 even quarters.
      const dayStart = midnight.toMillis();
      for (let quarter = 0; quarter < 96; quarter++) {
        const reach = quarter === 48 ? spike(date) : 0;
        // The last bar of a day opens 5 pips above its close: rule 2 is about the close.
        const open = quarter === 95 ? m(5) : P;
        bars.push(bar(dayStart + quarter * M15, open, Math.max(open, m(reach)), m(-reach), P, 0));
      }
    }
  }
  return bars;
}

/** From `iso` to the end every bar is flat at `pips`. */
function flatFrom(bars: readonly Bar[], iso: string, pips: number): Bar[] {
  const from = at(iso);
  return bars.map((item) => (item.time < from ? item : bar(item.time, m(pips), m(pips), m(pips), m(pips), item.spreadPoints)));
}

function setBar(bars: readonly Bar[], iso: string, [open, high, low, close]: Ohlc): Bar[] {
  const copy = [...bars];
  const index = indexAt(copy, iso);
  copy[index] = bar((copy[index] as Bar).time, m(open), m(high), m(low), m(close), (copy[index] as Bar).spreadPoints);
  return copy;
}

/** Removes the bars that open in [from, to). */
function drop(bars: readonly Bar[], from: string, to: string): Bar[] {
  return bars.filter((item) => item.time < at(from) || item.time >= at(to));
}

const SIX_WEEKS = weeks(HISTORY, 6);

/** Four weeks of history, the week of the test and the one after it, quiet from the Monday of the test on. */
function calm(spike?: (date: string) => number): Bar[] {
  return flatFrom(spike === undefined ? SIX_WEEKS : weeks(HISTORY, 6, spike), T("00:00"), 0);
}

/** The week opens `pips` away from the Friday close and stays there. */
function gap(pips: number, spike?: (date: string) => number): Bar[] {
  return flatFrom(calm(spike), T("00:00"), pips);
}

function run(bars: Bar[], options: { start?: string; config?: Config } = {}): BacktestResult {
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: mondayGapM15,
    span: { start: at(options.start ?? T("00:00")), end: (bars.at(-1) as Bar).time + M15 },
    config: options.config ?? testConfig(),
  });
}

const only = (result: BacktestResult): Trade => {
  expect(result.trades).toHaveLength(1);
  return result.trades[0] as Trade;
};

/** A gap of 30 pips down, half taken at 03:00. */
function halfTaken(): Bar[] {
  return flatFrom(setBar(gap(-30), T("03:00"), [-30, -15, -30, -20]), T("03:15"), -20);
}

describe("MondayGapM15: the trade", () => {
  it("buys a gap down one hour after the open and closes it in two steps", () => {
    const bars = flatFrom(setBar(halfTaken(), T("05:00"), [-20, 0, -20, -5]), T("05:15"), -5);
    const result = run(bars);
    const trade = only(result);
    expect(result.skipped).toEqual([]);
    expect(trade.direction).toBe("BUY");
    expect(trade.signalTime).toBe(at(T("01:00")));
    expect(trade.entryTime).toBe(at(T("01:00")));
    expect(trade.entryPrice).toBe(m(-30));
    // Rule 7: one gap beyond the decision price. Rule 9: the Friday close.
    expect(trade.stopLoss).toBe(m(-60));
    expect(trade.takeProfit).toBe(P);
    // Rule 8: half of the lot at half of the gap, the rest at breakeven from the next bar.
    expect(trade.lots).toBe(0.16);
    expect(trade.partialLots).toBe(0.08);
    expect(trade.partialPrice).toBe(m(-15));
    expect(trade.partialTime).toBe(at(T("03:00")));
    expect(trade.breakevenTime).toBe(at(T("03:15")));
    expect(trade.exitReason).toBe("take");
    expect(trade.exitPrice).toBe(P);
    expect(trade.exitTime).toBe(at(T("05:00")));
    expect(trade.rMultiple).toBeCloseTo(0.75, 10);
    expect(trade.nights).toBe(0);
  });

  it("sells a gap up, mirrored", () => {
    let bars = flatFrom(setBar(gap(30), T("03:00"), [30, 30, 15, 20]), T("03:15"), 20);
    bars = flatFrom(setBar(bars, T("05:00"), [20, 20, 0, 5]), T("05:15"), 5);
    const trade = only(run(bars));
    expect(trade.direction).toBe("SELL");
    expect(trade.entryPrice).toBe(m(30));
    expect(trade.stopLoss).toBe(m(60));
    expect(trade.takeProfit).toBe(P);
    expect(trade.partialPrice).toBe(m(15));
    expect(trade.exitReason).toBe("take");
    expect(trade.exitPrice).toBe(P);
    expect(trade.rMultiple).toBeCloseTo(0.75, 10);
  });

  it("leaves the rest at breakeven after the first target", () => {
    const bars = flatFrom(setBar(halfTaken(), T("04:00"), [-20, -20, -30, -30]), T("04:15"), -30);
    const trade = only(run(bars));
    expect(trade.partialPrice).toBe(m(-15));
    expect(trade.exitReason).toBe("breakeven");
    expect(trade.exitPrice).toBe(m(-30));
    expect(trade.exitTime).toBe(at(T("04:00")));
    expect(trade.rMultiple).toBeCloseTo(0.25, 10);
  });

  it("is stopped one gap away when the price keeps going", () => {
    const bars = flatFrom(setBar(gap(-30), T("02:00"), [-30, -30, -60, -60]), T("02:15"), -60);
    const result = run(bars);
    const trade = only(result);
    expect(trade.exitReason).toBe("stop");
    expect(trade.exitPrice).toBe(m(-60));
    expect(trade.partialPrice).toBeNull();
    expect(trade.rMultiple).toBeCloseTo(-1, 10);
    // Rule 11: the gap is twice as wide now, and nothing else is traded this week.
    expect(result.skipped).toEqual([]);
  });

  it("measures the levels from the decision price, not from the fill", () => {
    const costly = testConfig({ minSpreadPoints: 10, slippagePips: 0.2, commissionPerLotRoundTrip: 7 });
    const bars = flatFrom(setBar(halfTaken(), T("05:00"), [-20, 0, -20, -5]), T("05:15"), -5);
    const trade = only(run(bars, { config: costly }));
    // Ask at the open plus slippage.
    expect(trade.entryPrice).toBe(px(m(-30) + 0.0001 + 0.00002));
    expect(trade.stopLoss).toBe(m(-60));
    expect(trade.takeProfit).toBe(P);
    expect(trade.stopDistance).toBe(px(30 * PIP + 0.00012));
    expect(trade.partialPrice).toBe(px(m(-15) - 0.00002));
    expect(trade.exitPrice).toBe(px(P - 0.00002));
  });

  it("writes the Friday close, the open of the week and the levels into the reason", () => {
    expect(only(run(gap(-30))).reason).toBe(
      `L 1.20000 (close ${FRIDAY} 23:45); открытие недели ${MONDAY} 00:00; через час 1.19700; ` +
        `гэп 0.00300 = 0.30 ATR(14) D1 0.01000; стоп 1.19400; половина 1.19850; срок ${MONDAY} 23:00`,
    );
  });
});

describe("MondayGapM15: the exit by time (rule 10)", () => {
  /** The price hovers 25 pips under the Friday close: no target, no stop. */
  const hover = (): Bar[] => flatFrom(gap(-30), T("01:15"), -25);

  it("closes at the open of the 16:00 New York bar", () => {
    const trade = only(run(hover()));
    expect(trade.exitReason).toBe("strategy");
    expect(trade.exitTime).toBe(at(T("23:00")));
    expect(trade.exitPrice).toBe(m(-25));
    expect(trade.partialPrice).toBeNull();
    expect(trade.nights).toBe(0);
    expect(trade.rMultiple).toBeCloseTo(5 / 30, 10);
  });

  it("does not need the bar before 16:00", () => {
    const trade = only(run(drop(hover(), T("22:45"), T("23:00"))));
    expect(trade.exitTime).toBe(at(T("23:00")));
  });

  it("closes at the first bar after 16:00 when that bar is missing", () => {
    const trade = only(run(drop(hover(), T("23:00"), T("23:30"))));
    expect(trade.exitTime).toBe(at(T("23:30")));
  });

  it("is 22:00 server time while New York is on summer time and the server is not", () => {
    // 18 March 2024: New York changed its clocks on 10 March, the server changes on 31 March.
    const monday = "2024-03-18";
    const bars = flatFrom(flatFrom(weeks("2024-02-19", 6), `${monday}T00:00`, -30), `${monday}T01:15`, -25);
    const result = runBacktest({
      data: [symbolData("EURUSD", bars)],
      strategy: mondayGapM15,
      span: { start: at(`${monday}T00:00`), end: (bars.at(-1) as Bar).time + M15 },
      config: testConfig(),
    });
    const trade = only(result);
    expect(trade.entryTime).toBe(at(`${monday}T01:00`));
    expect(trade.exitTime).toBe(at(`${monday}T22:00`));
    expect(trade.reason).toContain(`срок ${monday} 22:00`);
  });

  it("finds the nearest 16:00 New York after a moment", () => {
    expect(exitTimeAfter(at(T("01:00")))).toBe(at(T("23:00")));
    // A moment after 16:00 New York belongs to the next day; 16:00 itself too.
    expect(exitTimeAfter(at(T("23:15")))).toBe(at("2024-05-14T23:00"));
    expect(exitTimeAfter(at(T("23:00")))).toBe(at("2024-05-14T23:00"));
    expect(exitTimeAfter(at("2024-01-15T01:00"))).toBe(at("2024-01-15T23:00"));
  });
});

describe("MondayGapM15: the size of the gap (rule 4)", () => {
  it("needs 0.2 of the daily ATR", () => {
    // ATR(14) of D1 is 100 pips, the threshold 20 pips.
    expect(run(gap(-19.5)).trades).toHaveLength(0);
    expect(run(gap(-19.5)).skipped).toEqual([]);
    expect(run(gap(-20.5)).trades).toHaveLength(1);
    expect(run(gap(19.5)).trades).toHaveLength(0);
    expect(run(gap(20.5)).trades).toHaveLength(1);
  });

  it("takes the ATR on the last daily bar closed before the decision", () => {
    // Friday has a range of 300 pips: ATR = (13 * 100 + 300) / 14 = 114.3 pips, the threshold 22.9 pips.
    const wideFriday = (date: string): number => (date === FRIDAY ? 150 : 50);
    expect(run(gap(-22, wideFriday)).trades).toHaveLength(0);
    const trade = only(run(gap(-23.5, wideFriday)));
    expect(trade.reason).toContain("гэп 0.00235 = 0.21 ATR(14) D1 0.01143");
  });

  it("measures the gap one hour after the open, not at the open", () => {
    // Opens 30 pips down and is back to 10 pips within the hour: too small by then.
    const closed = flatFrom(setBar(gap(-30), T("00:45"), [-30, -10, -30, -10]), T("01:00"), -10);
    expect(run(closed).trades).toHaveLength(0);
    // Opens at the Friday close and falls 30 pips within the hour: a trade.
    const fell = flatFrom(setBar(calm(), T("00:45"), [0, 0, -30, -30]), T("01:00"), -30);
    const trade = only(run(fell));
    expect(trade.direction).toBe("BUY");
    expect(trade.entryPrice).toBe(m(-30));
    expect(trade.stopLoss).toBe(m(-60));
    expect(trade.takeProfit).toBe(P);
  });
});

describe("MondayGapM15: the moment of the decision (rules 3 and 6)", () => {
  it("skips the week when no bar closes one hour after the open", () => {
    const result = run(drop(gap(-30), T("00:45"), T("01:00")));
    expect(result.trades).toHaveLength(0);
    expect(result.skipped).toEqual([]);
  });

  it("drops the signal when the next bar does not open at once", () => {
    const result = run(drop(gap(-30), T("01:00"), T("01:15")));
    expect(result.trades).toHaveLength(0);
    expect(result.skipped.map((item) => item.reason)).toEqual(["gap-after-signal"]);
  });

  it("counts the hour from the first bar the week really has", () => {
    const trade = only(run(drop(gap(-30), T("00:00"), T("00:15"))));
    expect(trade.entryTime).toBe(at(T("01:15")));
    expect(trade.reason).toContain(`открытие недели ${MONDAY} 00:15`);
    expect(trade.reason).toContain(`срок ${MONDAY} 23:00`);
  });

  it("trades when the run starts inside the first hour of the week", () => {
    const trade = only(run(gap(-30), { start: T("00:30") }));
    expect(trade.entryTime).toBe(at(T("01:00")));
    expect(trade.takeProfit).toBe(P);
  });

  it("does not trade a week that is already past its first hour when the run starts", () => {
    expect(run(gap(-30), { start: T("01:15") }).trades).toHaveLength(0);
  });
});

describe("MondayGapM15: the week (rules 1, 2 and 11)", () => {
  it("does not take a holiday break in the middle of the week for a weekend", () => {
    // Closed from Tuesday 20:00 to Thursday 00:00, and 30 pips lower after it.
    const bars = flatFrom(drop(calm(), "2024-05-14T20:00", "2024-05-16T00:00"), "2024-05-16T00:00", -30);
    // Keep the next Monday without a gap: flat at the same price.
    expect(run(bars).trades).toHaveLength(0);
  });

  it("takes the Thursday close when the market is shut on Friday", () => {
    // Thursday ends 10 pips above P, Friday is a holiday, Monday opens 20 pips under P.
    let bars = flatFrom(SIX_WEEKS, `2024-05-09T23:00`, 10);
    bars = flatFrom(drop(bars, `${FRIDAY}T00:00`, T("00:00")), T("00:00"), -20);
    const trade = only(run(bars));
    expect(trade.direction).toBe("BUY");
    expect(trade.takeProfit).toBe(m(10));
    expect(trade.stopLoss).toBe(m(-50));
    expect(trade.reason).toContain("L 1.20100 (close 2024-05-09 23:45)");
  });

  it("trades every weekend on its own", () => {
    // Monday: 30 pips down, hovering. Tuesday on: back at P. Next Monday: 30 pips up, hovering.
    let bars = flatFrom(flatFrom(gap(-30), T("01:15"), -25), "2024-05-14T00:00", 0);
    bars = flatFrom(flatFrom(bars, `${NEXT_MONDAY}T00:00`, 30), `${NEXT_MONDAY}T01:15`, 25);
    const result = run(bars);
    expect(result.trades.map((trade) => trade.direction)).toEqual(["BUY", "SELL"]);
    const [first, second] = result.trades as [Trade, Trade];
    expect(first.exitTime).toBe(at(T("23:00")));
    expect(second.entryTime).toBe(at(`${NEXT_MONDAY}T01:00`));
    expect(second.takeProfit).toBe(P);
    expect(second.exitReason).toBe("strategy");
    expect(second.exitTime).toBe(at(`${NEXT_MONDAY}T23:00`));
    expect(second.exitPrice).toBe(m(25));
  });

  it("knows a break that holds a Saturday noon, server time", () => {
    const s = (iso: string): number => at(iso);
    expect(spansSaturdayNoon(s("2024-05-11T00:00"), s("2024-05-13T00:00"), ZONE)).toBe(true);
    // Shut from Thursday evening: still a weekend.
    expect(spansSaturdayNoon(s("2024-05-09T20:00"), s("2024-05-13T00:00"), ZONE)).toBe(true);
    // A holiday in the middle of the week.
    expect(spansSaturdayNoon(s("2024-05-14T20:00"), s("2024-05-16T00:00"), ZONE)).toBe(false);
    // The break ends before the noon, or starts after it.
    expect(spansSaturdayNoon(s("2024-05-10T20:00"), s("2024-05-11T11:59"), ZONE)).toBe(false);
    expect(spansSaturdayNoon(s("2024-05-11T12:01"), s("2024-05-13T00:00"), ZONE)).toBe(false);
    expect(spansSaturdayNoon(s("2024-05-11T12:00"), s("2024-05-13T00:00"), ZONE)).toBe(true);
    expect(spansSaturdayNoon(s("2024-05-10T20:00"), s("2024-05-11T12:00"), ZONE)).toBe(true);
    // No break at all.
    expect(spansSaturdayNoon(s("2024-05-11T12:00"), s("2024-05-11T12:00"), ZONE)).toBe(false);
  });
});

describe("MondayGapM15: what is fixed", () => {
  it("trades the eight instruments of TZ 17.2 on M15 with the approved numbers", () => {
    expect(mondayGapM15.name).toBe("MondayGapM15");
    expect(mondayGapM15.executionTimeframe).toBe("M15");
    expect(mondayGapM15.symbols).toEqual(FX_AND_GOLD);
    expect(MONDAY_GAP).toEqual({
      atrPeriod: 14,
      waitMinutes: 60,
      minGapAtr: 0.2,
      partialGapShare: 0.5,
      partialFraction: 0.5,
      exitHourNewYork: 16,
    });
  });
});
