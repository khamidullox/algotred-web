import type { StrategyName } from "../config";
import type { Strategy } from "../engine/types";
import {
  breakoutRetestV1A,
  breakoutRetestV1B,
  breakoutRetestV2Breakeven,
  breakoutRetestV2MinStop,
} from "./breakout-retest-v1";
import { failedBreakoutV1 } from "./failed-breakout-v1";
import { rectangleV1 } from "./rectangle-v1";
import { rsi2ReversionD1 } from "./rsi2-reversion-d1";
import { strongLevelD1 } from "./strong-level-d1";
import { seriesBreakH4 } from "./series-break-h4";
import { threeTouchTrendD1 } from "./three-touch-trend-d1";
import { timeOfDayEURUSD } from "./time-of-day-eurusd";
import { midMonthIndexControl, turnOfMonthIndex } from "./turn-of-month-index";
import { trendD1 } from "./trend-d1";

export const STRATEGIES: Readonly<Record<StrategyName, Strategy>> = {
  TrendD1: trendD1,
  "BreakoutRetestV1-A": breakoutRetestV1A,
  "BreakoutRetestV1-B": breakoutRetestV1B,
  "BreakoutRetestV2-minstop": breakoutRetestV2MinStop,
  "BreakoutRetestV2-breakeven": breakoutRetestV2Breakeven,
  StrongLevelD1: strongLevelD1,
  RectangleV1: rectangleV1,
  FailedBreakoutV1: failedBreakoutV1,
  Rsi2ReversionD1: rsi2ReversionD1,
  TimeOfDayEURUSD: timeOfDayEURUSD,
  TurnOfMonthIndex: turnOfMonthIndex,
  MidMonthIndexControl: midMonthIndexControl,
  ThreeTouchTrendD1: threeTouchTrendD1,
  SeriesBreakH4: seriesBreakH4,
};
