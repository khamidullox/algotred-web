import { DateTime } from "luxon";
import type { Dataset } from "../config";
import { barsInSpan } from "./bars";
import type { TimeSpan } from "./time";
import type { Bar } from "./types";

/** The holdout is the last 24 calendar months of the common period (TZ section 6). */
export const HOLDOUT_MONTHS = 24;
/** `dev` is the first 70% of the days before the holdout, `test` is the rest. */
export const DEV_SHARE_PERCENT = 70;

/**
 * Half-open spans [start, end) in UTC ms. Every boundary is the start of a
 * server-time day, so no daily bar is cut in two and the same boundaries work
 * for every pair and timeframe.
 */
export type DatasetSplit = Readonly<Record<Dataset, TimeSpan>>;

export class SplitError extends Error {
  override name = "SplitError";
}

export class HoldoutGuardError extends Error {
  override name = "HoldoutGuardError";
}

/**
 * Dataset boundaries fixed in the config (TZ 17.2): server-time dates
 * (yyyy-MM-dd) on which `test` and `holdout` begin. Once set, adding or
 * re-exporting files no longer moves them.
 */
export interface FrozenBoundaries {
  readonly testStart: string;
  readonly holdoutStart: string;
}

/**
 * Splits the common period of the data into dev, test and holdout.
 *
 * With `frozen` boundaries: dev runs from the start of the common period to
 * `testStart`, test to `holdoutStart`, holdout to the end of the common period.
 *
 * Without them (TZ 6): the holdout starts 24 calendar months before the end of
 * the period, and the days before it are split 70/30 by calendar days, rounded
 * down in favour of test.
 */
export function splitCommonRange(
  common: TimeSpan,
  zone: string,
  frozen?: FrozenBoundaries,
): DatasetSplit {
  const start = DateTime.fromMillis(common.start, { zone });
  const end = DateTime.fromMillis(common.end, { zone });
  if (
    start.startOf("day").toMillis() !== common.start ||
    end.startOf("day").toMillis() !== common.end
  ) {
    throw new SplitError(
      "Общий период должен начинаться и заканчиваться в начале дня сервера.",
    );
  }

  if (frozen !== undefined) {
    const day = (iso: string): number => {
      const parsed = DateTime.fromISO(iso, { zone });
      if (!parsed.isValid || parsed.toFormat("yyyy-LL-dd") !== iso) {
        throw new SplitError(`Граница набора "${iso}" должна быть датой ГГГГ-ММ-ДД.`);
      }
      return parsed.startOf("day").toMillis();
    };
    const testStart = day(frozen.testStart);
    const holdoutStart = day(frozen.holdoutStart);
    if (!(common.start < testStart && testStart < holdoutStart && holdoutStart < common.end)) {
      throw new SplitError(
        `Закреплённые границы (test с ${frozen.testStart}, holdout с ${frozen.holdoutStart}) не помещаются в общий период данных ` +
          `${start.toFormat("yyyy-LL-dd")} — ${end.toFormat("yyyy-LL-dd")}: каждый набор должен получить хотя бы один день.`,
      );
    }
    return {
      dev: { start: common.start, end: testStart },
      test: { start: testStart, end: holdoutStart },
      holdout: { start: holdoutStart, end: common.end },
    };
  }

  const holdoutStart = end.minus({ months: HOLDOUT_MONTHS }).startOf("day");
  const daysBeforeHoldout = Math.round(holdoutStart.diff(start, "days").days);
  // Integer arithmetic: 0.7 has no exact binary form and could lose a day.
  const devDays = Math.floor((daysBeforeHoldout * DEV_SHARE_PERCENT) / 100);
  if (devDays < 1 || daysBeforeHoldout - devDays < 1) {
    const totalDays = Math.round(end.diff(start, "days").days);
    throw new SplitError(
      `В общем периоде ${totalDays} дн. Этого мало: последние ${HOLDOUT_MONTHS} месяца уходят в holdout, ` +
        `а оставшиеся дни нужно разделить на dev и test.`,
    );
  }
  const testStart = start.plus({ days: devDays }).startOf("day");

  return {
    dev: { start: common.start, end: testStart.toMillis() },
    test: { start: testStart.toMillis(), end: holdoutStart.toMillis() },
    holdout: { start: holdoutStart.toMillis(), end: common.end },
  };
}

export interface DatasetAccess {
  /** True only when the caller explicitly confirmed a holdout run. */
  readonly holdoutAcknowledged: boolean;
}

/**
 * The one place that decides whether a dataset may be used. The CLI and the
 * site both go through it, so the holdout cannot be opened by accident.
 */
export function assertDatasetAccess(
  dataset: Dataset,
  access: DatasetAccess,
): void {
  if (dataset === "holdout" && !access.holdoutAcknowledged) {
    throw new HoldoutGuardError(
      `Набор holdout закрыт. Это последние ${HOLDOUT_MONTHS} месяца данных: их можно использовать один раз, ` +
        `для финальной проверки одного кандидата (раздел 6 ТЗ). ` +
        `Если это она, добавьте флаг --i-understand-holdout. Запуск будет записан в EXPERIMENTS.md.`,
    );
  }
}

/** Span of a dataset. Throws HoldoutGuardError for an unconfirmed holdout. */
export function datasetSpan(
  split: DatasetSplit,
  dataset: Dataset,
  access: DatasetAccess,
): TimeSpan {
  assertDatasetAccess(dataset, access);
  return split[dataset];
}

/** Bars of one series that belong to a dataset. Bars must be sorted. */
export function datasetBars(
  bars: readonly Bar[],
  split: DatasetSplit,
  dataset: Dataset,
  access: DatasetAccess,
): Bar[] {
  return barsInSpan(bars, datasetSpan(split, dataset, access));
}

export interface SpanDays {
  /** First server-time day of the span, yyyy-MM-dd. */
  readonly firstDay: string;
  /** Last server-time day inside the span, yyyy-MM-dd. */
  readonly lastDay: string;
  readonly days: number;
}

/** Calendar days of a span whose boundaries are server-day starts. */
export function describeSpan(span: TimeSpan, zone: string): SpanDays {
  const start = DateTime.fromMillis(span.start, { zone });
  const end = DateTime.fromMillis(span.end, { zone });
  return {
    firstDay: start.toFormat("yyyy-LL-dd"),
    lastDay: end.minus({ days: 1 }).toFormat("yyyy-LL-dd"),
    days: Math.round(end.diff(start, "days").days),
  };
}
