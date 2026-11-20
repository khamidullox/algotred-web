import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Strategy } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { rsi2IndexControl } from "../src/strategies/rsi2-index-control";
import { rsi2ReversionD1, rsi2ReversionIndexD1 } from "../src/strategies/rsi2-reversion-d1";
import { bar, symbolData, testConfig, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
const dayStart = (day: number): number =>
  DateTime.fromISO("2024-01-01T00:00", { zone: ZONE }).plus({ days: day }).toMillis();
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
const TREND_DAYS = 210;

/**
 * 210 days moving 10 points a day (up, or down for `sign` -1), then `tail`
 * (offsets from P), then 16 more days going on 10 points a day. Every day is
 * 24 identical H1 bars, so the D1 bar is that day. The strategies trade the
 * index CFDs; here their rules run on EURUSD-shaped prices.
 */
function run(strategy: Strategy, tail: readonly number[], sign: 1 | -1 = 1): BacktestResult {
  const offsets: number[] = [];
  for (let day = 0; day < TREND_DAYS; day++) offsets.push(0.001 * day);
  offsets.push(...tail);
  const last = offsets.at(-1) as number;
  for (let day = 1; day <= 16; day++) offsets.push(last + 0.001 * day);
  const closes = offsets.map((offset) => px(P + sign * offset));
  const bars: Bar[] = [];
  closes.forEach((close, day) => {
    const open = day === 0 ? close : (closes[day - 1] as number);
    for (let time = dayStart(day); time < dayStart(day + 1); time += HOUR) {
      bars.push(bar(time, open, px(Math.max(open, close) + 0.0005), px(Math.min(open, close) - 0.0005), close));
    }
  });
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: { ...strategy, symbols: ["EURUSD"] },
    span: { start: dayStart(0), end: dayStart(closes.length) },
    config: testConfig(),
  });
}

/** Two falling days after the climb: RSI(2) 4.76 (the dip of the 17.4 tests). */
const DIP = [0.205, 0.197, 0.198, 0.204];
/** One day 10 points down after the climb: RSI(2) exactly 50. */
const PAUSE = [0.208];

const withoutName = (result: BacktestResult) => result.trades.map(({ reason, ...trade }) => ({ ...trade, reason }));

describe("Rsi2ReversionIndexD1", () => {
  it("trades exactly like Rsi2ReversionD1 on the same prices", () => {
    for (const [tail, sign] of [[DIP, 1], [DIP, -1]] as const) {
      const index = run(rsi2ReversionIndexD1, tail, sign);
      expect(index.trades).toHaveLength(1);
      expect(withoutName(index)).toEqual(withoutName(run(rsi2ReversionD1, tail, sign)));
    }
    // Four runs over a long daily history: about 4 s on a free machine, over the default 5 s on a busy one.
  }, 30_000);

  it("keeps the frozen numbers of TZ 17.4 and trades the three US indices", () => {
    expect(rsi2ReversionIndexD1.params).toEqual(rsi2ReversionD1.params);
    expect(rsi2ReversionIndexD1.symbols).toEqual(["US500", "US30", "US2000"]);
    expect(rsi2ReversionIndexD1.name).toBe("Rsi2ReversionIndexD1");
  });
});

describe("Rsi2IndexControl", () => {
  it("buys in an uptrend on a neutral RSI(2) and leaves at the open after the fourth daily close", () => {
    const result = run(rsi2IndexControl, PAUSE);
    expect(result.trades.map((trade) => [trade.direction, trade.exitReason])).toEqual([["BUY", "strategy"]]);
    const [trade] = result.trades;
    expect(trade?.entryTime).toBe(dayStart(211));
    // Closes of days 211, 212, 213, 214 with the position open: out at the open of day 215.
    expect(trade?.exitTime).toBe(dayStart(215));
    expect(trade?.reason).toContain("RSI(2) 50.00");
  });

  it("sells in a downtrend, mirrored", () => {
    expect(run(rsi2IndexControl, PAUSE, -1).trades.map((trade) => trade.direction)).toEqual(["SELL"]);
  });

  it("stays out when RSI(2) is outside 45 to 55, as on the dip the main strategy buys", () => {
    // 5 points down: RSI(2) 66.7; 15 points down: 40.
    expect(run(rsi2IndexControl, [0.2085]).trades).toEqual([]);
    expect(run(rsi2IndexControl, [0.2075]).trades).toEqual([]);
    expect(run(rsi2IndexControl, DIP).trades).toEqual([]);
    expect(run(rsi2ReversionIndexD1, PAUSE).trades).toEqual([]);
  });

  it("declares its fixed parameters and the same instruments and stop as the main strategy", () => {
    expect(rsi2IndexControl.params).toMatchObject({ neutralRsiLow: 45, neutralRsiHigh: 55, holdDays: 4, atrMultiple: 2, atrPeriod: 20, trendSmaPeriod: 200 });
    expect(rsi2IndexControl.symbols).toEqual(rsi2ReversionIndexD1.symbols);
  });
});
