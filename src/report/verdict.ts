import type { Dataset } from "../config";
import type { Bootstrap, BreakdownRow, MetricsBlock } from "./metrics";

/** Thresholds of TZ section 10. Not configurable on purpose. */
export const CRITERIA = {
  tradesContinue: 200,
  tradesReject: 100,
  profitFactorContinue: 1.2,
  profitFactorReject: 1.0,
  drawdownContinuePct: 0.15,
  drawdownRejectPct: 0.2,
  pairsContinue: 2,
} as const;

export type CriterionStatus = "continue" | "reject" | "between" | "unknown";

export interface Criterion {
  readonly name: string;
  readonly value: string;
  readonly continueRule: string;
  readonly rejectRule: string;
  readonly status: CriterionStatus;
}

export type VerdictCode = "CONTINUE" | "REJECT" | "INCONCLUSIVE";

export interface Verdict {
  readonly code: VerdictCode;
  readonly criteria: readonly Criterion[];
  /** True when TZ 10 is meant for this run: BreakoutRetestV1 on the test set. */
  readonly applies: boolean;
  readonly note: string;
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

/**
 * The decision table of TZ 10 on after-cost metrics. Every criterion lands in
 * the "continue" column, the "reject" column or between them. One criterion
 * in the reject column rejects; all in the continue column continue; anything
 * else is inconclusive.
 */
export function decide(
  main: MetricsBlock,
  bySymbol: readonly BreakdownRow[],
  bootstrap: Bootstrap | null,
  strategy: string,
  dataset: Dataset,
): Verdict {
  const criteria: Criterion[] = [];

  criteria.push({
    name: "Число сделок",
    value: String(main.trades),
    continueRule: `${CRITERIA.tradesContinue} и больше`,
    rejectRule: `меньше ${CRITERIA.tradesReject}`,
    status:
      main.trades >= CRITERIA.tradesContinue
        ? "continue"
        : main.trades < CRITERIA.tradesReject
          ? "reject"
          : "between",
  });

  const pf = main.profitFactor;
  criteria.push({
    name: "Profit Factor",
    value: pf === null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2),
    continueRule: `${CRITERIA.profitFactorContinue.toFixed(2)} и выше`,
    rejectRule: `${CRITERIA.profitFactorReject.toFixed(2)} и ниже`,
    status:
      pf === null
        ? "unknown"
        : pf >= CRITERIA.profitFactorContinue
          ? "continue"
          : pf <= CRITERIA.profitFactorReject
            ? "reject"
            : "between",
  });

  criteria.push({
    name: "Максимальная просадка",
    value: pct(main.maxDrawdownPct),
    continueRule: `до ${pct(CRITERIA.drawdownContinuePct)}`,
    rejectRule: `больше ${pct(CRITERIA.drawdownRejectPct)}`,
    status:
      main.trades === 0
        ? "unknown"
        : main.maxDrawdownPct <= CRITERIA.drawdownContinuePct
          ? "continue"
          : main.maxDrawdownPct > CRITERIA.drawdownRejectPct
            ? "reject"
            : "between",
  });

  const expectancy = main.expectancyR;
  criteria.push({
    name: "Математическое ожидание, R",
    value: expectancy === null ? "—" : expectancy.toFixed(3),
    continueRule: "положительное",
    rejectRule: "отрицательное",
    status:
      expectancy === null
        ? "unknown"
        : expectancy > 0
          ? "continue"
          : expectancy < 0
            ? "reject"
            : "between",
  });

  criteria.push({
    name: "Доверительный интервал среднего R",
    value:
      bootstrap === null
        ? "—"
        : `${bootstrap.lower.toFixed(3)} … ${bootstrap.upper.toFixed(3)}`,
    continueRule: "нижняя граница выше нуля",
    rejectRule: "—",
    status: bootstrap === null ? "unknown" : bootstrap.lower > 0 ? "continue" : "between",
  });

  const positive = bySymbol.filter((row) => row.metrics.totalUsd > 0).length;
  const negative = bySymbol.filter((row) => row.metrics.totalUsd < 0).length;
  criteria.push({
    name: "Пары",
    value: `в плюсе ${positive}, в минусе ${negative} из ${bySymbol.length}`,
    continueRule: `плюс минимум на ${CRITERIA.pairsContinue} из 3`,
    rejectRule: "минус на всех трёх",
    status:
      bySymbol.length === 0
        ? "unknown"
        : positive >= CRITERIA.pairsContinue
          ? "continue"
          : negative === 3
            ? "reject"
            : "between",
  });

  const statuses = criteria.map((criterion) => criterion.status);
  const code: VerdictCode = statuses.includes("reject")
    ? "REJECT"
    : statuses.every((status) => status === "continue")
      ? "CONTINUE"
      : "INCONCLUSIVE";

  const applies = strategy.startsWith("BreakoutRetestV1") && dataset === "test";
  let note: string;
  if (strategy === "TrendD1") {
    note = "К TrendD1 критерии раздела 10 не применяются: это базовая линия и проверка движка. Вердикт справочный.";
  } else if (dataset !== "test") {
    note = `Критерии раздела 10 заданы для набора test; на наборе ${dataset} вердикт справочный.`;
  } else {
    note = "Критерии раздела 10 применяются к этому прогону.";
  }
  return { code, criteria, applies, note };
}
