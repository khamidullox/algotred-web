import { DateTime } from "luxon";
import type { Bar } from "../data/types";
import type { Strategy, StrategyAction } from "../engine/types";
import { AtrWilder } from "../indicators/atr";
import { RsiWilder } from "../indicators/rsi";
import { US_INDICES } from "./baskets";

/** Chosen on dev in the search of TZ 17.17 and frozen before the test run. */
export const IBS_DIP = {
  /** Rule 1: the daily close lies in this lowest share of the day's range. */
  ibsBelow: 0.1,
  /** Rule 4: leave after a daily close with RSI(rsiPeriod) above this. */
  rsiPeriod: 2,
  exitAboveRsi: 70,
  /** Rule 5: leave after this many daily closes in the trade at the latest. */
  maxDays: 10,
  /** Rule 3: the stop, which also sizes the lot. */
  atrPeriod: 20,
  atrMultiple: 2,
} as const;

/** The control of TZ 17.17: the same trade from a close in the middle of the day's range. */
export const IBS_CONTROL = {
  ibsFrom: 0.45,
  ibsBelow: 0.55,
} as const;

/**
 * Internal bar strength: where the close lies in the day's range, 0 at the
 * low and 1 at the high. A day with no range has none.
 */
export function ibs(bar: Bar): number {
  return bar.high === bar.low ? Number.NaN : (bar.close - bar.low) / (bar.high - bar.low);
}

/** The closes that give an entry: `from <= IBS < below`; `from` null means from the low itself. */
interface Band {
  readonly from: number | null;
  readonly below: number;
}

function createIbsStrategy(name: string, band: Band): Strategy {
  return {
    name,
    params: {
      ...IBS_DIP,
      ibsBelow: band.below,
      ...(band.from === null ? {} : { ibsFrom: band.from }),
      direction: "long only",
      atrMethod: "Wilder",
      rsiMethod: "Wilder (as MT5 Relative Strength Index)",
      signalTimeframe: "D1",
      executionTimeframe: "H1",
    },
    executionTimeframe: "H1",
    symbols: US_INDICES,
    create: () => {
      const atr = new AtrWilder(IBS_DIP.atrPeriod);
      const rsi = new RsiWilder(IBS_DIP.rsiPeriod);
      /** Daily closes seen with the position open. */
      let held = 0;
      return {
        onBarClose(ctx): StrategyAction | null {
          if (!ctx.justClosed("D1")) return null;
          const bars = ctx.bars("D1");
          const last = bars.last();
          if (last === undefined) return null;
          const atrValue = atr.update(bars);
          const rsiValue = rsi.update(bars);
          const price = (value: number): string => value.toFixed(ctx.spec.digits);

          // Rules 4 and 5: the exit, checked at every daily close in the trade.
          if (ctx.position !== null) {
            held++;
            if (rsiValue > IBS_DIP.exitAboveRsi) {
              return { kind: "exit", reason: `RSI(${IBS_DIP.rsiPeriod}) ${rsiValue.toFixed(2)} > ${IBS_DIP.exitAboveRsi}` };
            }
            if (held >= IBS_DIP.maxDays) return { kind: "exit", reason: `${held} дневных закрытий в сделке` };
            return null;
          }
          held = 0;

          // Rule 1: where the day closed in its own range.
          if (Number.isNaN(atrValue) || Number.isNaN(rsiValue)) return null;
          const value = ibs(last);
          if (Number.isNaN(value) || !(value < band.below)) return null;
          if (band.from !== null && !(value >= band.from)) return null;
          const day = DateTime.fromMillis(last.time, { zone: ctx.zone }).toFormat("yyyy-LL-dd");
          return {
            kind: "entry",
            direction: "BUY",
            // Rule 3.
            stopLoss: { distance: IBS_DIP.atrMultiple * atrValue },
            takeProfit: null,
            reason:
              `D1 ${day} close ${price(last.close)}: IBS ${value.toFixed(2)} ` +
              `(low ${price(last.low)}, high ${price(last.high)}); ATR(${IBS_DIP.atrPeriod}) ${price(atrValue)}`,
          };
        },
      };
    },
  };
}

/**
 * IbsDipIndexD1 (TZ 17.17): buy a US index CFD at the next open after a day
 * that closed in the lowest tenth of its range; stop 2 x ATR(20) away; leave
 * at the next open after a daily close with RSI(2) above 70, or after ten
 * daily closes. Long only, no trend filter, one position per index.
 *
 * Runs on H1 like the other daily strategies and acts only when a D1 bar has
 * closed. The rule was chosen on dev out of several hundred variants, so its
 * dev numbers are flattering; test and holdout are the check.
 */
export const ibsDipIndexD1 = createIbsStrategy("IbsDipIndexD1", { from: null, below: IBS_DIP.ibsBelow });

/**
 * IbsIndexControl (TZ 17.17): the same exit, stop and instruments, entered
 * after a day that closed in the middle of its range. It shows what being
 * long for a few days earned without any dip.
 */
export const ibsIndexControl = createIbsStrategy("IbsIndexControl", { from: IBS_CONTROL.ibsFrom, below: IBS_CONTROL.ibsBelow });
