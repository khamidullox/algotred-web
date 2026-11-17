import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { atrWilder } from "../src/indicators/atr";
import { strongLevelD1 } from "../src/strategies/strong-level-d1";
import { at, bar, symbolData, testConfig } from "./helpers/bars";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = at("2024-01-01T00:00");
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;

interface Day {
  open: number;
  high: number;
  low: number;
  close: number;
}

const quiet = (level: number, sign: 1 | -1 = 1): Day => ({
  open: px(level),
  high: px(level + 0.001),
  low: px(level - 0.001),
  close: px(level),
});

/** 24 identical H1 bars per day, so the D1 bar is exactly the day given. */
function hourly(days: readonly Day[]): Bar[] {
  const bars: Bar[] = [];
  days.forEach((day, index) => {
    for (let hour = 0; hour < 24; hour++) {
      bars.push(bar(START + index * DAY + hour * HOUR, day.open, day.high, day.low, day.close));
    }
  });
  return bars;
}

/**
 * The approved pattern, long side: a spike high on day 20 (the level, known
 * on day 30), a touch on day 35, the breakout on day 45, a day above the
 * level, the retest on day 47, the entry at the day-48 open and the take on
 * day 50. `sign` -1 mirrors it for a short.
 */
function scenario(options: {
  sign?: 1 | -1;
  touch?: boolean;
  breakoutDay?: number;
  cancel?: boolean;
  total?: number;
} = {}): Day[] {
  const sign = options.sign ?? 1;
  const total = options.total ?? 80;
  const touch = options.touch ?? true;
  const b = options.breakoutDay ?? 45;
  const m = (delta: number): number => px(P + sign * delta);
  const d = (open: number, up: number, down: number, close: number): Day =>
    sign === 1
      ? { open: m(open), high: m(up), low: m(down), close: m(close) }
      : { open: m(open), high: m(down), low: m(up), close: m(close) };
  const days: Day[] = Array.from({ length: total }, () => d(0, 0.001, -0.001, 0));
  days[20] = d(0, 0.003, -0.001, 0); // the level: 1.2030
  if (touch) days[35] = d(0, 0.0025, -0.001, 0); // within 0.5 ATR of the level, closes below it
  days[b] = d(0, 0.005, -0.001, 0.0045); // breakout: closes 15 pips above the level
  days[b + 1] = options.cancel ? d(0.0045, 0.0046, 0.002, 0.0025) : d(0.0045, 0.005, 0.004, 0.0045);
  days[b + 2] = d(0.0045, 0.0046, 0.0031, 0.004); // retest: low at the level plus the buffer, closes above
  for (let i = b + 3; i < total; i++) days[i] = d(0.004, 0.0045, 0.0035, 0.004);
  if (b + 5 < total) days[b + 5] = d(0.004, 0.0065, 0.0035, 0.006); // the take
  return days;
}

function run(days: readonly Day[]) {
  const data = symbolData("EURUSD", hourly(days));
  const result = runBacktest({
    data: [data],
    strategy: strongLevelD1,
    span: { start: START, end: START + days.length * DAY },
    config: testConfig(),
  });
  return { result, atr: atrWilder(data.bars.D1, 14) };
}

describe("StrongLevelD1 on a hand-made daily series", () => {
  const { result, atr } = run(scenario());
  const trade = result.trades[0] as Trade;
  const atrBreakout = atr[45] as number;

  it("takes exactly one long trade", () => {
    expect(result.trades.map((item) => item.direction)).toEqual(["BUY"]);
    expect(result.skipped).toEqual([]);
  });

  it("enters at the open of the day after the retest", () => {
    expect(trade.signalTime).toBe(START + 48 * DAY);
    expect(trade.entryTime).toBe(START + 48 * DAY);
    expect(trade.entryPrice).toBe(1.204);
  });

  it("names the level, its touch, the breakout and the retest", () => {
    expect(trade.reason).toContain("L 1.20300 от 2024-01-21, касаний 1");
    expect(trade.reason).toContain("пробой 2024-02-15 close 1.20450");
    expect(trade.reason).toContain("ретест 2024-02-17 low 1.20310 (2-й день)");
  });

  it("puts the stop under the retest low by 0.1 x ATR(14) D1 of the breakout day and the take at 2R", () => {
    const stop = px(1.2031 - 0.1 * atrBreakout);
    expect(trade.stopLoss).toBe(stop);
    const distance = px(1.204 - stop);
    expect(trade.takeProfit).toBe(px(1.204 + 2 * distance));
    expect(trade.exitReason).toBe("take");
    expect(trade.exitTime).toBe(START + 50 * DAY);
    expect(trade.rMultiple).toBeCloseTo(2, 6);
  });
});

describe("StrongLevelD1 rules", () => {
  it("mirrors for a short", () => {
    const { result } = run(scenario({ sign: -1 }));
    expect(result.trades.map((item) => item.direction)).toEqual(["SELL"]);
    expect(result.trades[0]?.entryPrice).toBe(1.196);
    expect(result.trades[0]?.exitReason).toBe("take");
    expect(result.trades[0]?.reason).toContain("ретест 2024-02-17 high 1.19690");
  });

  it("ignores a level that was never touched", () => {
    const { result } = run(scenario({ touch: false }));
    expect(result.trades).toEqual([]);
  });

  it("does not trade a breakout before the level is known", () => {
    // The level forms on day 20 and is known on day 30; a breakout on day 25 is invisible.
    const { result } = run(scenario({ breakoutDay: 25 }));
    expect(result.trades).toEqual([]);
  });

  it("cancels the setup when a day closes back below the level", () => {
    const { result } = run(scenario({ cancel: true }));
    expect(result.trades).toEqual([]);
  });

  it("forgets a level after 120 days", () => {
    // Known on day 30, expires after day 150; the breakout on day 155 finds no level.
    const { result } = run(scenario({ breakoutDay: 155, total: 170 }));
    expect(result.trades).toEqual([]);
  });

  it("declares its fixed parameters", () => {
    expect(strongLevelD1.params).toMatchObject({
      wingsD1: 10,
      lifeD1: 120,
      touchAtr: 0.5,
      breakoutBufferAtr: 0.1,
      retestBarsD1: 5,
      stopBufferAtr: 0.1,
      maxStopAtr: 1.5,
      takeProfitR: 2,
    });
    expect(strongLevelD1.executionTimeframe).toBe("H1");
  });
});
