import { TIMEFRAMES, type Config, type SymbolName, type Timeframe } from "../config";
import { lowerBound } from "../data/bars";
import { eventsBetween, type NewsEvent } from "../data/calendar";
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
  fillLimit,
  fillMarketExit,
  fillStopEntry,
  limitCancelReached,
  resolveLevels,
  stopAfterStopEntry,
  stopEntryCancel,
  type Fill,
} from "./execution";
import { LOT_STEP, lotsForRisk, riskAtStopUsd } from "./sizing";
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
  LimitSpec,
  MarketContext,
  OpenPosition,
  Signal,
  SkipReason,
  SkippedSignal,
  StopEntrySpec,
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
  /** The economic calendar, sorted by time; strategies see it through `ctx.news`. */
  readonly news?: readonly NewsEvent[];
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
  /**
   * The resting order that filled the position (TZ 17.10, 17.15), or null for
   * a market entry: in the bar of such a fill only the stop is checked.
   */
  readonly orderEntry: "limit" | "stop" | null;
  /** Partial close still to come (TZ 17.10), its level already a price, or null. */
  readonly partial: { readonly price: number; readonly fraction: number; readonly breakeven: boolean } | null;
  /** Lots the partial close takes, rounded down to the lot step; 0 when nothing is closed. */
  readonly partialLots: number;
  /** The partial close once it happened. */
  partialFill: Fill | null;
  partialTime: number | null;
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
  /** Resting limit or stop order (TZ 17.10, 17.15); it works from the bar after its signal. */
  order: RestingOrderState | null;
  readonly ctx: MarketContext;
}

type RestingOrderState =
  | { readonly kind: "limit"; readonly signal: Signal; readonly spec: LimitSpec; readonly signalTime: number }
  | { readonly kind: "stop"; readonly signal: Signal; readonly spec: StopEntrySpec; readonly signalTime: number };

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

  // A strategy may trade only some of the instruments (TZ 17.5): the run
  // takes those it is given data for. The CLI checks that the config has them all.
  const wanted = strategy.symbols;
  const runData =
    wanted === undefined
      ? input.data
      : input.data.filter((data) => wanted.includes(data.symbol));
  if (wanted !== undefined && runData.length === 0) {
    throw new Error(
      `Стратегия ${strategy.name} торгует ${wanted.join(", ")}, а данных ни по одному из них нет.`,
    );
  }

  const states = runData
    .map((data) =>
      createState(data, strategy, config, costMultiplier, span, zone, input.news ?? []),
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

  /** A resting order that goes without a fill: the record keeps what it was and when it went. */
  const skipOrder = (
    state: SymbolState,
    order: RestingOrderState,
    reason: "order-cancelled" | "order-expired",
    detail: string,
    endTime: number,
  ): void => {
    skipped.push({
      symbol: state.symbol,
      direction: order.signal.direction,
      signalTime: order.signalTime,
      reason,
      detail,
      order: { kind: order.kind, price: roundPrice(state.spec, order.spec.price), endTime, reason: order.signal.reason },
    });
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

    // Excursions: the bar extremes while open, capped at the realised exit on
    // the side the trade was closed on (a stop never "went" beyond the stop).
    let maePrice = Math.max(0, sign * (position.entry.price - position.worst));
    let mfePrice = Math.max(0, sign * (position.best - position.entry.price));
    const realised = sign * (fill.price - position.entry.price);
    if (exitReason === "stop") maePrice = Math.max(0, -realised);
    if (exitReason === "take") mfePrice = Math.max(0, realised);

    // Money per closed part: the partial close (TZ 17.10), if any, and the
    // rest. Each part is converted to USD at its own exit fill.
    const legs: { lots: number; fill: Fill; time: number }[] = [];
    if (position.partialFill !== null && position.partialTime !== null) {
      legs.push({ lots: position.partialLots, fill: position.partialFill, time: position.partialTime });
    }
    legs.push({ lots: roundLots(position.lots - (position.partialFill === null ? 0 : position.partialLots)), fill, time: exitTime });
    // Financing scales with the position's value when the swap was quoted
    // at a known price (TZ 17.6, indices); otherwise the pips are fixed.
    const swapScale =
      costs.swapReferencePrice === null
        ? 1
        : position.entry.price / costs.swapReferencePrice;
    let grossPnlUsd = 0;
    let spreadCostUsd = 0;
    let slippageCostUsd = 0;
    let commission = 0;
    let swapUsd = 0;
    let netPnlUsd = 0;
    let nights = 0;
    for (const leg of legs) {
      const rate = leg.fill.price;
      const toUsd = (diff: number): number => priceDiffToUsd(spec, diff, leg.lots, rate);
      const legCommission = commissionUsd(leg.lots, costs);
      const span = swapNights(position.entryTime, leg.time, zone, costs.tripleSwapWeekday);
      const legSwap =
        swapPips(position.direction, span.weightedNights, costs) *
        swapScale *
        pipValueUsdPerLot(spec, rate) *
        leg.lots;
      grossPnlUsd += toUsd(sign * (leg.fill.raw - position.entry.raw));
      spreadCostUsd += toUsd(position.entry.spread + leg.fill.spread);
      slippageCostUsd += toUsd(position.entry.slippage + leg.fill.slippage);
      commission += legCommission;
      swapUsd += legSwap;
      netPnlUsd += toUsd(sign * (leg.fill.price - position.entry.price)) - legCommission + legSwap;
      nights = span.nights;
    }
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
      partialTime: position.partialFill === null ? null : position.partialTime,
      partialPrice: position.partialFill === null ? null : position.partialFill.price,
      partialLots: position.partialFill === null ? null : position.partialLots,
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

  /**
   * Opens a position from an entry fill: the USD exposure limit, the levels,
   * the stop filters and the lot, in that order. Used by market, limit and stop entries.
   */
  const enter = (state: SymbolState, bar: Bar, action: Signal, signalTime: number, entry: Fill, orderEntry: "limit" | "stop" | null): void => {
    const { spec } = state;
    const { direction } = action;
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

    const partial = action.partial ?? null;
    // A partial level given in R is measured from the actual fill (TZ 17.15).
    const partialPrice =
      partial === null
        ? 0
        : roundPrice(
            spec,
            "price" in partial
              ? partial.price
              : entry.price + (direction === "BUY" ? 1 : -1) * partial.rMultiple * levels.stopDistance,
          );
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
      orderEntry,
      partial: partial === null ? null : { price: partialPrice, fraction: partial.fraction, breakeven: partial.breakeven },
      partialLots: partial === null ? 0 : Math.floor((lots * partial.fraction) / LOT_STEP + 1e-9) / 100,
      partialFill: null,
      partialTime: null,
    };
  };

  const atOpen = (state: SymbolState, bar: Bar): void => {
    // A resting order past its time is withdrawn before the bar trades (TZ 17.10).
    const order = state.order;
    if (order !== null && order.spec.expiresAt !== undefined && bar.time >= order.spec.expiresAt) {
      state.order = null;
      skipOrder(state, order, "order-expired", `не исполнен до ${formatInZone(order.spec.expiresAt, zone)} (время сервера)`, bar.time);
    }
    const pending = state.pending;
    if (pending === null) return;
    // A scheduled order keeps resting until its time (TZ 17.6).
    if (pending.action.kind !== "cancel" && pending.action.notBefore !== undefined && bar.time < pending.action.notBefore) return;
    state.pending = null;
    const { action, signalTime } = pending;

    if (action.kind === "cancel") return;
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
    // A reversal (TZ 17.5): the opposite position is closed at this open
    // first, whatever happens to the new entry below.
    if (state.position !== null && action.reverse === true && state.position.direction !== direction) {
      const fill = fillMarketExit(spec, state.position.direction, bar, bar.open, costs);
      closePosition(state, fill, bar.time, "strategy");
    }
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
    enter(state, bar, action, signalTime, fillEntry(spec, direction, bar, costs), null);
  };

  /** A resting stop order inside the bar: cancelled, filled, or still waiting (TZ 17.15). */
  const workStopEntry = (state: SymbolState, bar: Bar, order: RestingOrderState & { kind: "stop" }): void => {
    const { spec, costs } = state;
    const { signal, signalTime, spec: stop } = order;
    const { direction } = signal;
    const cancel = stop.cancelAt === undefined ? null : stopEntryCancel(spec, direction, bar, stop.cancelAt, costs);
    const fill = fillStopEntry(spec, direction, bar, roundPrice(spec, stop.price), costs);
    const works = stop.worksAt === undefined || stop.worksAt(bar.time);
    // A bar that opens beyond the cancel level reached it first. Inside a
    // bar the order is unknown: a working order that reached its price is
    // filled (and then stopped), the worse case; otherwise the level cancels.
    if (stop.cancelAt !== undefined && (cancel === "open" || (cancel === "inside" && (fill === null || !works)))) {
      state.order = null;
      skipOrder(state, order, "order-cancelled", `цена дошла до ${stop.cancelAt.toFixed(spec.digits)} раньше исполнения`, bar.time);
      return;
    }
    if (fill === null) return;
    state.order = null;
    if (!works) {
      skipOrder(state, order, "order-cancelled", "цена дошла до ордера, когда он не работал", bar.time);
      return;
    }
    enter(state, bar, signal, signalTime, fill, "stop");
  };

  /** A resting order inside the bar: cancelled, filled, or still waiting (TZ 17.10, 17.15). */
  const workOrder = (state: SymbolState, bar: Bar): void => {
    const order = state.order;
    if (order === null || state.position !== null) return;
    const { signal, signalTime } = order;
    if (order.kind === "stop") {
      workStopEntry(state, bar, order);
      return;
    }
    const limit = order.spec;
    const { direction } = signal;
    const fill = fillLimit(state.spec, direction, bar, roundPrice(state.spec, limit.price), state.costs);
    // The order inside a bar is unknown: a bar that reaches the cancel level
    // counts as cancelled even if it reached the price too.
    if (limit.cancelAt !== undefined && limitCancelReached(direction, bar, limit.cancelAt)) {
      state.order = null;
      skipOrder(state, order, "order-cancelled", `цена дошла до ${limit.cancelAt.toFixed(state.spec.digits)} раньше исполнения`, bar.time);
      return;
    }
    if (fill === null) return;
    state.order = null;
    enter(state, bar, signal, signalTime, fill, "limit");
  };

  const unreachable = (direction: Direction): number => (direction === "BUY" ? -Infinity : Infinity);

  const insideBar = (state: SymbolState, bar: Bar): void => {
    workOrder(state, bar);
    const position = state.position;
    if (position === null) return;
    // In the bar where a resting order filled, what happened before the fill
    // is not the position's: only the stop is checked, and only the adverse
    // excursion is tracked (TZ 17.10, rule 8; TZ 17.15, rule 9).
    const fillBar = position.orderEntry !== null && position.entryTime === bar.time;
    // Track the excursions on the side the position is closed on: a buy is
    // sold at the Bid, a sell is bought back at the Ask.
    if (position.direction === "BUY") {
      position.worst = Math.min(position.worst, bar.low);
      if (!fillBar) position.best = Math.max(position.best, bar.high);
    } else {
      const spread = spreadOf(state.spec, bar, state.costs);
      position.worst = Math.max(position.worst, roundPrice(state.spec, bar.high + spread));
      if (!fillBar) position.best = Math.min(position.best, roundPrice(state.spec, bar.low + spread));
    }
    if (fillBar) {
      // A stop entry filled after the open of its bar, so its stop has no gap rule.
      const stop =
        position.orderEntry === "stop"
          ? stopAfterStopEntry(state.spec, position.direction, bar, position.stopLoss, state.costs)
          : checkStops(state.spec, position.direction, bar, position.stopLoss, null, state.costs);
      if (stop !== null) closePosition(state, stop.fill, bar.time, stop.reason);
      return;
    }
    // Partial close still ahead (TZ 17.10): the stop comes first in a bar
    // that reaches both; then the partial level, then the take for the rest.
    if (position.partial !== null && position.partialTime === null) {
      const stop = checkStops(state.spec, position.direction, bar, position.stopLoss, null, state.costs);
      if (stop !== null) {
        closePosition(state, stop.fill, bar.time, stop.reason);
        return;
      }
      const level = checkStops(state.spec, position.direction, bar, unreachable(position.direction), position.partial.price, state.costs);
      if (level === null) return;
      position.partialTime = bar.time;
      if (position.partialLots > 0) position.partialFill = level.fill;
      if (position.takeProfit !== null) {
        const take = checkStops(state.spec, position.direction, bar, unreachable(position.direction), position.takeProfit, state.costs);
        if (take !== null) {
          closePosition(state, take.fill, bar.time, "take");
          return;
        }
      }
      // The rest goes to breakeven from the next bar, never inside this one.
      if (position.partial.breakeven) {
        position.stopLoss = position.entry.price;
        position.breakevenTime = bar.time + execStep;
      }
      return;
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

    if (action.kind === "cancel") {
      const order = state.order;
      if (order !== null) {
        state.order = null;
        skipOrder(state, order, "order-cancelled", action.reason, state.now);
      }
      return;
    }

    // A limit or stop entry rests from the next bar on (TZ 17.10, 17.15); a new one replaces the old.
    if (action.kind === "entry" && (action.limit !== undefined || action.stopEntry !== undefined)) {
      if (action.limit !== undefined && action.stopEntry !== undefined) {
        throw new Error(`Стратегия ${strategy.name}: сигнал не может быть сразу лимитным и стоп-ордером.`);
      }
      if (state.position !== null) {
        skip(state, action.direction, state.now, "position-open", "по этой паре уже открыта позиция");
        return;
      }
      if (state.index + 1 >= state.end) {
        skip(state, action.direction, state.now, "no-next-bar", "сигнал на последней свече набора: входить не во что");
        return;
      }
      const replaced = state.order;
      if (replaced !== null) {
        skipOrder(state, replaced, "order-cancelled", "заменён новым ордером", state.now);
      }
      state.order =
        action.stopEntry !== undefined
          ? { kind: "stop", signal: action, spec: action.stopEntry, signalTime: state.now }
          : { kind: "limit", signal: action, spec: action.limit as LimitSpec, signalTime: state.now };
      return;
    }

    if (action.kind === "entry") {
      const reverses =
        action.reverse === true &&
        state.position !== null &&
        state.position.direction !== action.direction;
      if (state.position !== null && !reverses) {
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

  // A position still open when the data ends is closed at the last close;
  // a resting order is withdrawn.
  for (const state of states) {
    const last = state.exec[state.end - 1] as Bar;
    const order = state.order;
    if (order !== null) {
      state.order = null;
      skipOrder(state, order, "order-expired", "набор закончился раньше исполнения", last.time + execStep);
    }
    if (state.position === null) continue;
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
    symbols: runData.map((data) => data.symbol),
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

/** Lots back on the 0.01 grid after a subtraction. */
function roundLots(lots: number): number {
  return Math.round(lots / LOT_STEP) / 100;
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
  news: readonly NewsEvent[],
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
    order: null,
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
      get order() {
        const order = state.order;
        return order === null
          ? null
          : { kind: order.kind, direction: order.signal.direction, price: order.spec.price, signalTime: order.signalTime };
      },
      // The schedule is public in advance; the figures only once released.
      news: (from, to, filter) =>
        eventsBetween(news, from, to, filter).map((event) =>
          event.time <= state.now ? event : { ...event, actual: null, revisedPrevious: null },
        ),
    },
  };
  // History before the first bar of the span is closed from the start, and must
  // not count as "just closed" on that bar.
  advanceClosed(state);
  state.justClosed.clear();
  return state;
}
