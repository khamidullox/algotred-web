import type { StrategyName } from "../config";
import type { Strategy } from "../engine/types";
import { trendD1 } from "./trend-d1";

/** Strategies implemented so far; BreakoutRetestV1 A and B arrive in step 7. */
export const STRATEGIES: Readonly<Partial<Record<StrategyName, Strategy>>> = {
  TrendD1: trendD1,
};
