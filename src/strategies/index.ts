import type { StrategyName } from "../config";
import type { Strategy } from "../engine/types";
import { breakoutRetestV1A, breakoutRetestV1B } from "./breakout-retest-v1";
import { trendD1 } from "./trend-d1";

export const STRATEGIES: Readonly<Record<StrategyName, Strategy>> = {
  TrendD1: trendD1,
  "BreakoutRetestV1-A": breakoutRetestV1A,
  "BreakoutRetestV1-B": breakoutRetestV1B,
};
