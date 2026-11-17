import { TIMEFRAMES, type Config, type SymbolName, type Timeframe } from "../config";
import { lowerBound } from "../data/bars";
import { formatInZone, nextZoneDay, type TimeSpan } from "../data/time";
import { MINUTE_MS, TIMEFRAME_MINUTES, type Bar } from "../data/types";
import { ClosedBarsView } from "./closed-bars";
import {
  commissionUsd,
  costSettings,
  spreadOf,
  swapConfigured,
  swapNights,
  swapPips,
  type CostSettings,
} from "./costs";
import {
  checkStops,
  fillEntry,
  fillMarketExit,
  resolveLevels,
  type Fill,
} from "./execution";
import { lotsForRisk, riskAtStopUsd } from "./sizing";
import {
  pipValueUsdPerLot,
  priceDiffToUsd,
  roundPrice,
  symbolSpec,
  usdDirection,
  type SymbolSpec,
} from "./symbols";
import type {
  BacktestResult,
  Direction,
  ExitReason,
  MarketContext,
  OpenPosition,
  SkipReason,
  SkippedSignal,
  Strategy,
  StrategyAction,
  StrategyInstance,
  Trade,
} from "./types";

/** Every timeframe of one symbol, sorted by time, including history before the dataset. */
export interface SymbolData {
  readonly symbol: SymbolName;
  readonly bars: Readonly<Record<Timeframe, readonly Bar[]>>;
}

export interface BacktestOptions {
  /** 2 runs the stress test of TZ 7.3. Default 1. */
  readonly costMultiplier?: number;
  /** Overrides `config.usdExposureLimit`. */
  readonly usdExposureLimit?: boolean;
}

export interface BacktestInput {
  readonly data: readonly SymbolData[];
  readonly strategy: Strategy;
  /** Signals are generated and positions held only inside this span, [start, end) UTC ms. */
  readonly span: TimeSpan;
  readonly config: Config;
  readonly options?: BacktestOptions;
}

interface Position {
  readonly direction: Direction;
  readonly reason: string;
  readonly signalTime: number;
  readonly entryTime: number;
  readonly entry: Fill;
  /** The original stop; `stopLoss` is the one in force. */
  readonly initialStopLoss: number;
  stopLoss: number;
  readonly takeProfit: number | null;
  readonly stopDistance: number;
  readonly lots: number;
  /** Worst price seen against the position (Bid for a buy, Ask for a sell). */
  worst: number;
  /** Best price seen in favour of the position, same side. */
  best: number;
  /** Favourable excursion, in R, at which the stop moves to the entry; null when the rule is off. */
  readonly breakevenAtR: number | null;
  /** Close time of the bar after which the stop was moved, or null. */
  breakevenTime: number | null;
}

interface SymbolState {
  readonly symbol: SymbolName;
  readonly spec: SymbolSpec;
  readonly costs: CostSettings;
  readonly strategy: StrategyInstance;
  /** Bars of the execution timeframe. */
  readonly exec: readonly Bar[];
  /** Index of the current execution bar; [start, end) are the bars inside the span. */
  index: number;
  readonly end: number;
  readonly closed: Readonly<Record<Timeframe, ClosedBarsView>>;
  /** Close time of every bar of every timeframe, UTC ms. */
  readonly closeTimes: Readonly<Record<Timeframe, readonly number[]>>;
  readonly justClosed: Set<Timeframe>;
  now: number;
  position: Position | null;
  pending: { action: StrategyAction; signalTime: number } | null;
  readonly ctx: MarketContext;
}

function toOpenPosition(position: Position): OpenPosition {
  return {
    direction: position.direction,
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    entryPrice: position.entry.price,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    lots: position.lots,
    reason: position.reason,
  };
}

/**
 * Runs one strategy over several symbols on one account (TZ 7).
 *
 * All symbols move through time together: at every open the pending orders of
 * every symbol are filled, then every bar is checked for stops, then every
 * strategy sees its closed bar. Position size is taken from the balance at the
 * moment of the fill, so a trade closed on one pair changes the size of the
 * next trade on another.
 */
export function runBacktest(input: BacktestInput): BacktestResult {
  const { config, strategy, span } = input;
  const zone = config.brokerTimeZone;
  const costMultiplier = input.options?.costMultiplier ?? 1;
  const usdExposureLimit =
    input.options?.usdExposureLimit ?? config.usdExposureLimit;
  const execTimeframe = strategy.executionTimeframe;
  const execStep = TIMEFRAME_MINUTES[execTimeframe] * MINUTE_MS;

  let balance = config.initialCapitalUsd;
  const trades: Trade[] = [];
  const skipped: SkippedSignal[] = [];

  const states = input.data
    .map((data) =>
      createState(data, strategy, config, costMultiplier, span, zone),
    )
    .filter((state) => state.index < state.end);

  const skip = (
    state: SymbolState,
    direction: Direction,
    signalTime: number,
    reason: SkipReason,
    detail: string,
  ): void => {
    skipped.push({ symbol: state.symbol, direction, signalTime, reason, detail });
  };

  const closePosition = (
    state: SymbolState,
    fill: Fill,
    exitTime: number,
    exitReason: ExitReason,
  ): void => {
    const position = state.position;
    if (position === null) return;
    state.position = null;

    const { spec, costs } = state;
    const sign = position.direction === "BUY" ? 1 : -1;
    // Everything is converted to USD at the exit fill.
    const rate = fill.price;
    const toUsd = (diff: number): number =>
      priceDiffToUsd(spec, diff, position.lots, rate);

    // Excursions: the bar extremes while open, capped at the realised exit on
    // the side the trade was closed on (a stop never "went" beyond the stop).
    let maePrice = Math.max(0, sign * (position.entry.price - position.worst));
    let mfePrice = Math.max(0, sign * (position.best - position.entry.price));
    const realised = sign * (fill.price - position.entry.price);
    if (exitReason === "stop") maePrice = Math.max(0, -realised);
    if (exitReason === "take") mfePrice = Math.max(0, realised);

    const grossPnlUsd = toUsd(sign * (fill.raw - position.entry.raw));
    const spreadCostUsd = toUsd(position.entry.spread + fill.spread);
    const slippageCostUsd = toUsd(position.entry.slippage + fill.slippage);
    const commission = commissionUsd(position.lots, costs);
    const { nights, weightedNights } = swapNights(
      position.entryTime,
      exitTime,
      zone,
    );
    const swapUsd =
      swapPips(position.direction, weightedNights, costs) *
      pipValueUsdPerLot(spec, rate) *
      position.lots;
    const netPnlUsd =
      toUsd(sign * (fill.price - position.entry.price)) - commission + swapUsd;
    const riskUsd = riskAtStopUsd(
      spec,
      position.lots,
      position.stopDistance,
      position.entry.price,
    );
    balance += netPnlUsd;

    trades.push({
      symbol: state.symbol,
      direction: position.direction,
      reason: position.reason,
      signalTime: position.signalTime,
      entryTime: position.entryTime,
      entryPrice: position.entry.price,
      stopLoss: position.initialStopLoss,
      takeProfit: position.takeProfit,
      stopDistance: position.stopDistance,
      lots: position.lots,
      riskUsd,
      exitTime,
      exitPrice: fill.price,
      exitReason:
        exitReason === "stop" && position.breakevenTime !== null ? "breakeven" : exitReason,
      stopAtExit: position.stopLoss,
      breakevenTime: position.breakevenTime,
      nights,
      maePrice,
      mfePrice,
      maeR: maePrice / position.stopDistance,
      mfeR: mfePrice / position.stopDistance,
      grossPnlUsd,
      spreadCostUsd,
      slippageCostUsd,
      commissionUsd: commission,
      swapUsd,
      netPnlUsd,
      rMultiple: netPnlUsd / riskUsd,
      balanceAfter: balance,
    });
  };

  const usdExposureTaken = (
    state: SymbolState,
    direction: Direction,
  ): SymbolName | null => {
    const wanted = usdDirection(state.spec, direction);
    for (const other of states) {
      if (
        other !== state &&
        other.position !== null &&
        usdDirection(other.spec, other.position.direction) === wanted
      ) {
        return other.symbol;
      }
    }
    return null;
  };

  const atOpen = (state: SymbolState, bar: Bar): void => {
    const pending = state.pending;
    state.pending = null;
    if (pending === null) return;
    const { action, signalTime } = pending;

    if (action.kind === "exit") {
      if (state.position !== null) {
        const fill = fillMarketExit(
          state.spec,
          state.position.direction,
          bar,
          bar.open,
          state.costs,
        );
        closePosition(state, fill, bar.time, "strategy");
      }
      return;
    }

    const { spec, costs } = state;
    const { direction } = action;
    if (action.expectedEntryTime !== undefined && bar.time !== action.expectedEntryTime) {
      skip(
        state,
        direction,
        signalTime,
        "gap-after-signal",
        `следующая свеча открылась ${formatInZone(bar.time, zone)} вместо ${formatInZone(action.expectedEntryTime, zone)} (время сервера)`,
      );
      return;
    }
    if (usdExposureLimit) {
      const holder = usdExposureTaken(state, direction);
      if (holder !== null) {
        skip(
          state,
          direction,
          signalTime,
          "usd-exposure",
          `уже открыта позиция по ${holder} в ту же сторону доллара`,
        );
        return;
      }
    }

    const entry = fillEntry(spec, direction, bar, costs);
    const levels = resolveLevels(spec, direction, entry.price, action);
    if (!levels.ok) {
      skip(state, direction, signalTime, "invalid-levels", levels.detail);
      return;
    }
    if (
      action.maxStopDistance !== undefined &&
      levels.stopDistance > action.maxStopDistance + spec.point / 100
    ) {
      skip(
        state,
        direction,
        signalTime,
        "stop-too-far",
        `стоп ${levels.stopDistance.toFixed(spec.digits)} дальше допустимых ${action.maxStopDistance.toFixed(spec.digits)}`,
      );
      return;
    }

    if (
      action.minStopDistance !== undefined &&
      levels.stopDistance < action.minStopDistance - spec.point / 100
    ) {
      skip(
        state,
        direction,
        signalTime,
        "stop-too-close",
        `стоп ${levels.stopDistance.toFixed(spec.digits)} ближе допустимых ${action.minStopDistance.toFixed(spec.digits)}`,
      );
      return;
    }

    const riskUsd = (balance * config.riskPerTradePct) / 100;
    const lots = lotsForRisk(spec, riskUsd, levels.stopDistance, entry.price);
    if (lots === 0) {
      skip(
        state,
        direction,
        signalTime,
        "lot-too-small",
        `риск ${riskUsd.toFixed(2)} USD при стопе ${levels.stopDistance.toFixed(spec.digits)} даёт меньше 0.01 лота`,
      );
      return;
    }

    state.position = {
      direction,
      reason: action.reason,
      signalTime,
      entryTime: bar.time,
      entry,
      initialStopLoss: levels.stopLoss,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
      stopDistance: levels.stopDistance,
      lots,
      worst: entry.price,
      best: entry.price,
      breakevenAtR: action.breakevenAtR ?? null,
      breakevenTime: null,
    };
  };

  const insideBar = (state: SymbolState, bar: Bar): void => {
    const position = state.position;
    if (position === null) return;
    // Track the excursions on the side the position is closed on: a buy is
    // sold at the Bid, a sell is bought back at the Ask.
    if (position.direction === "BUY") {
      position.worst = Math.min(position.worst, bar.low);
      position.best = Math.max(position.best, bar.high);
    } else {
      const spread = spreadOf(state.spec, bar, state.costs);
      position.worst = Math.max(position.worst, roundPrice(state.spec, bar.high + spread));
      position.best = Math.min(position.best, roundPrice(state.spec, bar.low + spread));
    }
    const hit = checkStops(
      state.spec,
      position.direction,
      bar,
      position.stopLoss,
      position.takeProfit,
      state.costs,
    );
    if (hit !== null) {
      closePosition(state, hit.fill, bar.time, hit.reason);
      return;
    }
    // Breakeven (TZ 16.3): the order of moves inside a bar is unknown, so the
    // stop moves only after a bar that reached the level has closed.
    if (position.breakevenAtR !== null && position.breakevenTime === null) {
      const sign = position.direction === "BUY" ? 1 : -1;
      const favourable = sign * (position.best - position.entry.price);
      if (favourable >= position.breakevenAtR * position.stopDistance - state.spec.point / 100) {
        position.stopLoss = position.entry.price;
        position.breakevenTime = bar.time + execStep;
      }
    }
  };

  const atClose = (state: SymbolState, bar: Bar): void => {
    state.now = bar.time + execStep;
    advanceClosed(state);

    const action = state.strategy.onBarClose(state.ctx);
    if (action === null) return;

    if (action.kind === "entry") {
      if (state.position !== null) {
        skip(
          state,
          action.direction,
          state.now,
          "position-open",
          "по этой паре уже открыта позиция",
        );
        return;
      }
      if (state.index + 1 >= state.end) {
        skip(
          state,
          action.direction,
          state.now,
          "no-next-bar",
          "сигнал на последней свече набора: входить не во что",
        );
        return;
      }
    } else if (state.position === null) {
      return;
    }
    state.pending = { action, signalTime: state.now };
  };

  // All symbols advance together, one execution bar time at a time.
  for (;;) {
    let time = Infinity;
    for (const state of states) {
      if (state.index < state.end) {
        time = Math.min(time, (state.exec[state.index] as Bar).time);
      }
    }
    if (time === Infinity) break;

    const active = states.filter(
      (state) =>
        state.index < state.end &&
        (state.exec[state.index] as Bar).time === time,
    );
    for (const state of active) atOpen(state, state.exec[state.index] as Bar);
    for (const state of active) insideBar(state, state.exec[state.index] as Bar);
    for (const state of active) {
      atClose(state, state.exec[state.index] as Bar);
      state.index++;
    }
  }

  // A position still open when the data ends is closed at the last close.
  for (const state of states) {
    if (state.position === null) continue;
    const last = state.exec[state.end - 1] as Bar;
    const fill = fillMarketExit(
      state.spec,
      state.position.direction,
      last,
      last.close,
      state.costs,
    );
    closePosition(state, fill, last.time + execStep, "end-of-data");
  }

  return {
    strategy: strategy.name,
    params: strategy.params,
    executionTimeframe: execTimeframe,
    symbols: input.data.map((data) => data.symbol),
    span,
    brokerTimeZone: zone,
    initialBalance: config.initialCapitalUsd,
    finalBalance: balance,
    costMultiplier,
    usdExposureLimit,
    swapAccounted: swapConfigured(config),
    trades,
    skipped,
  };
}

/** Marks every bar that closed at or before `state.now` as closed. */
function advanceClosed(state: SymbolState): void {
  state.justClosed.clear();
  for (const timeframe of TIMEFRAMES) {
    const closeTimes = state.closeTimes[timeframe];
    const view = state.closed[timeframe];
    let count = view.length;
    while (count < closeTimes.length && (closeTimes[count] as number) <= state.now) {
      count++;
    }
    if (count !== view.length) {
      view.advanceTo(count);
      state.justClosed.add(timeframe);
    }
  }
}

function createState(
  data: SymbolData,
  strategy: Strategy,
  config: Config,
  costMultiplier: number,
  span: TimeSpan,
  zone: string,
): SymbolState {
  const spec = symbolSpec(config, data.symbol);
  const exec = data.bars[strategy.executionTimeframe];
  const closeTimes = {} as Record<Timeframe, readonly number[]>;
  const closed = {} as Record<Timeframe, ClosedBarsView>;
  for (const timeframe of TIMEFRAMES) {
    const bars = data.bars[timeframe];
    // A server day is not always 24 hours long, so the daily close comes from the calendar.
    closeTimes[timeframe] =
      timeframe === "D1"
        ? bars.map((bar) => nextZoneDay(bar.time, zone))
        : bars.map((bar) => bar.time + TIMEFRAME_MINUTES[timeframe] * MINUTE_MS);
    closed[timeframe] = new ClosedBarsView(bars);
  }

  const start = lowerBound(exec, span.start);
  const state: SymbolState = {
    symbol: data.symbol,
    spec,
    costs: costSettings(config, data.symbol, costMultiplier),
    strategy: strategy.create(data.symbol),
    exec,
    index: start,
    end: lowerBound(exec, span.end),
    closed,
    closeTimes,
    justClosed: new Set(),
    now: exec[start]?.time ?? span.start,
    position: null,
    pending: null,
    ctx: {
      symbol: data.symbol,
      spec,
      zone,
      get now() {
        return state.now;
      },
      bars: (timeframe) => closed[timeframe],
      justClosed: (timeframe) => state.justClosed.has(timeframe),
      get position() {
        return state.position === null ? null : toOpenPosition(state.position);
      },
    },
  };
  // History before the first bar of the span is closed from the start, and must
  // not count as "just closed" on that bar.
  advanceClosed(state);
  state.justClosed.clear();
  return state;
}
