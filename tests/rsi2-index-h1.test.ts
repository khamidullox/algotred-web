import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/engine/backtest";
import type { BacktestResult, Strategy, Trade } from "../src/engine/types";
import type { Bar } from "../src/data/types";
import { rsi2IndexControl, rsi2IndexH1Control } from "../src/strategies/rsi2-index-control";
import { rsi2ReversionIndexD1, rsi2ReversionIndexH1 } from "../src/strategies/rsi2-reversion-d1";
import { bar, symbolData, testConfig, ZONE } from "./helpers/bars";

const HOUR = 3_600_000;
const P = 1.2;
const px = (value: number): number => Math.round(value * 1e5) / 1e5;
const TREND = 210;
const server = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
/** The first instant Rsi2ReversionIndexH1 may take a signal (TZ 17.13). */
const TRADE_FROM = server("2016-09-01T00:00");

/**
 * Closes as offsets from P: 210 steps of 10 points (up, or down for `sign`
 * -1), then `tail`, then 16 more steps of 10 points.
 */
function closesOf(tail: readonly number[], sign: 1 | -1): number[] {
  const offsets: number[] = [];
  for (let step = 0; step < TREND; step++) offsets.push(0.001 * step);
  offsets.push(...tail);
  const last = offsets.at(-1) as number;
  for (let step = 1; step <= 16; step++) offsets.push(last + 0.001 * step);
  return offsets.map((offset) => px(P + sign * offset));
}

const candle = (time: number, open: number, close: number): Bar =>
  bar(time, open, px(Math.max(open, close) + 0.0005), px(Math.min(open, close) - 0.0005), close);

function backtest(strategy: Strategy, bars: readonly Bar[], start: number, end: number): BacktestResult {
  return runBacktest({
    data: [symbolData("EURUSD", bars)],
    strategy: { ...strategy, symbols: ["EURUSD"] },
    span: { start, end },
    config: testConfig(),
  });
}

/** One H1 candle per close, the first opening at `start` (UTC ms). */
function hourly(strategy: Strategy, tail: readonly number[], options: { sign?: 1 | -1; start?: number } = {}) {
  const start = options.start ?? server("2024-01-08T00:00");
  const closes = closesOf(tail, options.sign ?? 1);
  const bars = closes.map((close, hour) => candle(start + hour * HOUR, hour === 0 ? close : (closes[hour - 1] as number), close));
  const result = backtest(strategy, bars, start, start + closes.length * HOUR);
  return { trades: result.trades, hourStart: (hour: number): number => start + hour * HOUR };
}

/** The same closes as days: every day is 24 identical H1 candles, so the D1 candle is that day. */
function daily(strategy: Strategy, tail: readonly number[], sign: 1 | -1): readonly Trade[] {
  const dayStart = (day: number): number => DateTime.fromISO("2024-01-01T00:00", { zone: ZONE }).plus({ days: day }).toMillis();
  const closes = closesOf(tail, sign);
  const bars: Bar[] = [];
  closes.forEach((close, day) => {
    const open = day === 0 ? close : (closes[day - 1] as number);
    for (let time = dayStart(day); time < dayStart(day + 1); time += HOUR) bars.push(candle(time, open, close));
  });
  return backtest(strategy, bars, dayStart(0), dayStart(closes.length)).trades;
}

/** Two falling candles after the climb: RSI(2) 4.76, then the bounce above SMA(5). */
const DIP = [0.205, 0.197, 0.198, 0.204];
/** One candle 10 points down after the climb: RSI(2) exactly 50. */
const PAUSE = [0.208];

/** What a trade is apart from its clock times. */
const shape = (trade: Trade) => [trade.direction, trade.entryPrice, trade.stopLoss, trade.lots, trade.exitPrice, trade.exitReason];

describe("Rsi2ReversionIndexH1", () => {
  it("makes from hourly candles the trade the daily strategy makes from the same candles as days", () => {
    for (const sign of [1, -1] as const) {
      const fromHours = hourly(rsi2ReversionIndexH1, DIP, { sign }).trades;
      expect(fromHours).toHaveLength(1);
      expect(fromHours.map(shape)).toEqual(daily(rsi2ReversionIndexD1, DIP, sign).map(shape));
    }
  });

  it("enters at the open of the hour after the signal and leaves at the open after the H1 close above SMA(5)", () => {
    const { trades, hourStart } = hourly(rsi2ReversionIndexH1, DIP);
    const [trade] = trades;
    expect(trade?.direction).toBe("BUY");
    // Candle 211 closes the dip; candle 213 closes above SMA(5).
    expect(trade?.signalTime).toBe(hourStart(212));
    expect(trade?.entryTime).toBe(hourStart(212));
    expect(trade?.exitTime).toBe(hourStart(214));
    expect(trade?.exitReason).toBe("strategy");
    expect(trade?.reason).toContain("H1 close");
  });

  it("keeps the position through midnight: no forced close at the end of the day", () => {
    // Starting at 03:00, candle 212 opens at 23:00 and candle 214 at 01:00 of the next day.
    const { trades, hourStart } = hourly(rsi2ReversionIndexH1, DIP, { start: server("2024-01-08T03:00") });
    expect(trades).toHaveLength(1);
    expect(DateTime.fromMillis(trades[0]?.entryTime as number, { zone: ZONE }).hour).toBe(23);
    expect(trades[0]?.exitTime).toBe(hourStart(214));
    expect(DateTime.fromMillis(trades[0]?.exitTime as number, { zone: ZONE }).hour).toBe(1);
  });

  it("takes a signal that closes at 2016-09-01 00:00 server time and ignores one an hour earlier", () => {
    // The dip candle is number 211: it closes 212 hours after the start.
    const onTime = hourly(rsi2ReversionIndexH1, DIP, { start: TRADE_FROM - 212 * HOUR });
    expect(onTime.trades.map((trade) => trade.entryTime)).toEqual([TRADE_FROM]);
    expect(hourly(rsi2ReversionIndexH1, DIP, { start: TRADE_FROM - 213 * HOUR }).trades).toEqual([]);
  });

  it("keeps the frozen numbers of TZ 17.4, reads H1 and trades the three US indices", () => {
    expect(rsi2ReversionIndexH1.params).toEqual({
      ...rsi2ReversionIndexD1.params,
      signalTimeframe: "H1",
      tradeFrom: "2016-09-01T00:00 server time",
    });
    expect(rsi2ReversionIndexD1.params).not.toHaveProperty("tradeFrom");
    expect(rsi2ReversionIndexH1.symbols).toEqual(["US500", "US30", "US2000"]);
    expect(rsi2ReversionIndexH1.name).toBe("Rsi2ReversionIndexH1");
  });
});

describe("Rsi2IndexH1Control", () => {
  it("buys in an uptrend on a neutral RSI(2) and leaves at the open after the fourth H1 close", () => {
    const { trades, hourStart } = hourly(rsi2IndexH1Control, PAUSE);
    expect(trades.map((trade) => [trade.direction, trade.exitReason])).toEqual([["BUY", "strategy"]]);
    const [trade] = trades;
    expect(trade?.entryTime).toBe(hourStart(211));
    // Closes of candles 211, 212, 213, 214 with the position open: out at the open of candle 215.
    expect(trade?.exitTime).toBe(hourStart(215));
    expect(trade?.reason).toContain("RSI(2) 50.00");
    expect(trade?.reason).toContain("H1 close");
  });

  it("sells in a downtrend, mirrored", () => {
    expect(hourly(rsi2IndexH1Control, PAUSE, { sign: -1 }).trades.map((trade) => trade.direction)).toEqual(["SELL"]);
  });

  it("stays out on the dip the main strategy buys, and the main strategy stays out on a neutral RSI(2)", () => {
    expect(hourly(rsi2IndexH1Control, DIP).trades).toEqual([]);
    expect(hourly(rsi2ReversionIndexH1, PAUSE).trades).toEqual([]);
  });

  it("takes a signal that closes at 2016-09-01 00:00 server time and ignores one an hour earlier", () => {
    // The neutral candle is number 210: it closes 211 hours after the start.
    const onTime = hourly(rsi2IndexH1Control, PAUSE, { start: TRADE_FROM - 211 * HOUR });
    expect(onTime.trades.map((trade) => trade.entryTime)).toEqual([TRADE_FROM]);
    expect(hourly(rsi2IndexH1Control, PAUSE, { start: TRADE_FROM - 212 * HOUR }).trades).toEqual([]);
  });

  it("declares four candles to hold, H1 and the same instruments, stop and start as the main strategy", () => {
    expect(rsi2IndexH1Control.params).toMatchObject({
      neutralRsiLow: 45,
      neutralRsiHigh: 55,
      holdBars: 4,
      atrMultiple: 2,
      atrPeriod: 20,
      trendSmaPeriod: 200,
      signalTimeframe: "H1",
      tradeFrom: rsi2ReversionIndexH1.params.tradeFrom,
    });
    expect(rsi2IndexH1Control.params).not.toHaveProperty("holdDays");
    expect(rsi2IndexH1Control.symbols).toEqual(rsi2ReversionIndexH1.symbols);
    // The daily control of TZ 17.12 keeps its own parameters.
    expect(rsi2IndexControl.params).toMatchObject({ holdDays: 4, signalTimeframe: "D1" });
    expect(rsi2IndexControl.params).not.toHaveProperty("tradeFrom");
    expect(rsi2IndexControl.params).not.toHaveProperty("holdBars");
  });
});
