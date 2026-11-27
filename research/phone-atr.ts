// The stop a person reads off the phone (TZ 17.51). MetaTrader on a phone has
// the broker's own candles and the same RSI and moving averages as the rule,
// but its ATR is a simple average of the true range, where the rule uses
// Wilder's. This runs the rule with orders at 09:00 Tashkent time twice on
// dev: with its own stop, 2 x Wilder ATR(20), and with 2 x the simple average
// of the last 20 true ranges, and pairs the trades. Nothing else differs.
// dev only; test and holdout are not touched.
// Usage: npx tsx research/phone-atr.ts
import { DateTime } from "luxon";
import { runBacktest } from "../src/engine/backtest";
import type { Bar } from "../src/data/types";
import type { BacktestResult, Strategy, StrategyInstance, Trade } from "../src/engine/types";
import { trueRange } from "../src/indicators/atr";
import { placedAtClock, RSI2_INDEX_AT_9_TASHKENT, RSI2_REVERSION, rsi2ReversionIndexD1, rsi2ReversionIndexD1At9Tashkent, serverInstant } from "../src/strategies/rsi2-reversion-d1";
import { loadStand } from "./lib";

const clock = RSI2_INDEX_AT_9_TASHKENT.orderClock;
const from = RSI2_INDEX_AT_9_TASHKENT.tradeFrom;
if (clock === undefined || from === undefined) throw new Error("the frozen variant has no order hour or starting date");

/** The rule at the open with the frozen variant's starting date and, when asked, the phone's stop distance. */
function rule(symbol: string, phoneStop: boolean): StrategyInstance {
  const own = rsi2ReversionIndexD1.create(symbol);
  let tradeFrom: number | null = null;
  return {
    onBarClose(ctx) {
      const action = own.onBarClose(ctx);
      if (action === null || action.kind !== "entry") return action;
      tradeFrom ??= serverInstant(from, ctx.zone);
      if (ctx.now < tradeFrom) return null;
      if (!phoneStop) return action;
      // The simple average of the last 20 true ranges: what MT5's own ATR(20) shows on the signal candle.
      const bars = ctx.bars("D1");
      const period = RSI2_REVERSION.atrPeriod;
      if (bars.length < period + 1) return null;
      let sum = 0;
      for (let index = bars.length - period; index < bars.length; index++) sum += trueRange(bars.at(index) as Bar, (bars.at(index - 1) as Bar).close);
      return { ...action, stopLoss: { distance: (RSI2_REVERSION.atrMultiple * sum) / period } };
    },
  };
}

const variant = (name: string, phoneStop: boolean): Strategy => ({
  ...rsi2ReversionIndexD1,
  name,
  create: (symbol) => placedAtClock(rule(symbol, phoneStop), clock),
});

const stand = loadStand();
const zone = stand.config.brokerTimeZone;
const run = (strategy: Strategy): BacktestResult =>
  runBacktest({ data: stand.data, strategy, span: stand.span, config: stand.config, news: stand.news, options: { costMultiplier: 1 } });
const mean = (values: readonly number[]): number => (values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length);
const deviation = (values: readonly number[]): number => {
  const m = mean(values);
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, values.length - 1));
};
const signed = (value: number, digits = 3): string => `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
const keyOf = (trade: Trade): string => `${trade.symbol} ${DateTime.fromMillis(trade.entryTime, { zone }).toFormat("yyyy-LL-dd")}`;
const line = (name: string, result: BacktestResult): string => {
  const rs = result.trades.map((trade) => trade.rMultiple);
  const stops = result.trades.filter((trade) => trade.exitReason === "stop").length;
  return `${name.padEnd(34)} ${String(rs.length).padStart(3)} trades, mean R ${signed(mean(rs))}, sum ${signed(rs.reduce((a, b) => a + b, 0), 1)} R, ` +
    `wins ${((100 * result.trades.filter((trade) => trade.netPnlUsd > 0).length) / Math.max(1, rs.length)).toFixed(1)}%, stopped out ${stops}, ` +
    `lot skips ${result.skipped.filter((skip) => skip.reason === "lot-too-small").length}`;
};

const frozen = run(rsi2ReversionIndexD1At9Tashkent);
const same = run(variant("Rsi2At9-wilder", false));
const phone = run(variant("Rsi2At9-phone-atr", true));
const identical = frozen.trades.length === same.trades.length && frozen.trades.every((trade, i) => {
  const other = same.trades[i];
  return other !== undefined && other.entryTime === trade.entryTime && other.exitTime === trade.exitTime && Math.abs(other.rMultiple - trade.rMultiple) < 1e-9;
});
console.log(`Check: the wrapper with the rule's own stop repeats the frozen strategy on dev: ${identical ? "yes" : "NO"}`);
console.log(line("stop 2 x Wilder ATR(20), the rule", frozen));
console.log(line("stop 2 x simple ATR(20), the phone", phone));

const byKey = new Map(frozen.trades.map((trade) => [keyOf(trade), trade]));
const pairs = phone.trades.flatMap((trade) => {
  const other = byKey.get(keyOf(trade));
  return other === undefined ? [] : [{ phone: trade, rule: other }];
});
const diffs = pairs.map((pair) => pair.phone.rMultiple - pair.rule.rMultiple);
const ratios = pairs.map((pair) => pair.phone.stopDistance / pair.rule.stopDistance).sort((a, b) => a - b);
const at = (q: number): number => ratios[Math.round(q * (ratios.length - 1))] ?? Number.NaN;
console.log(
  `pairs ${pairs.length} (phone only ${phone.trades.length - pairs.length}, rule only ${frozen.trades.length - pairs.length}); ` +
    `paired difference ${signed(mean(diffs))} R, standard error ${(deviation(diffs) / Math.sqrt(Math.max(1, diffs.length))).toFixed(3)}; ` +
    `pairs with another result ${diffs.filter((value) => Math.abs(value) > 1e-9).length}`,
);
console.log(`stop distance, phone to rule: median ${at(0.5).toFixed(2)}, from ${at(0.05).toFixed(2)} to ${at(0.95).toFixed(2)} in nine cases of ten, extremes ${at(0).toFixed(2)} and ${at(1).toFixed(2)}`);
