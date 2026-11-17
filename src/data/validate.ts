import { DateTime } from "luxon";
import {
  SYMBOLS,
  type Config,
  type SymbolName,
  type Timeframe,
} from "../config";
import { readAllSeries, type SeriesInput } from "./load";
import {
  formatInZone,
  nextZoneDay,
  startOfZoneDay,
  touchesFixedHoliday,
  weekendClosuresBetween,
} from "./time";
import { HOUR_MS, MINUTE_MS, TIMEFRAME_MINUTES, type Bar } from "./types";

/**
 * Share of weeks that must close exactly at Friday 17:00 New York for the
 * broker time zone to be accepted. Holiday weeks close early, so it is not 100%.
 */
export const TIME_ZONE_PASS_SHARE = 0.95;
/** With fewer weeks than this the time zone cannot be judged. */
export const MIN_WEEKS_FOR_TIME_ZONE_CHECK = 4;
/** A spread above this is reported as abnormal: 5 pips for all three pairs. */
export const WIDE_SPREAD_POINTS = 50;

const MAX_EXAMPLES = 5;

export type Severity = "error" | "warning" | "info";

export type IssueCode =
  | "missing-file"
  | "bad-format"
  | "bad-rows"
  | "empty"
  | "unsorted"
  | "duplicates"
  | "bad-candles"
  | "non-positive"
  | "gaps"
  | "zero-spread"
  | "wide-spread"
  | "time-zone"
  | "inconsistent"
  | "trimmed"
  | "no-common-range";

export interface Issue {
  readonly severity: Severity;
  readonly code: IssueCode;
  readonly symbol?: SymbolName;
  readonly timeframe?: Timeframe;
  readonly message: string;
  readonly examples: readonly string[];
}

/**
 * weekend: the week opened late or closed early;
 * holiday: the gap touches 25 December or 1 January;
 * intraweek: anything else.
 */
export type GapKind = "weekend" | "holiday" | "intraweek";

export interface Gap {
  /** Expected open time of the first missing bar, UTC ms. */
  readonly from: number;
  /** Open time of the first bar after the gap, UTC ms. */
  readonly to: number;
  readonly missingBars: number;
  readonly kind: GapKind;
}

export interface SpreadYear {
  readonly year: number;
  readonly bars: number;
  readonly meanPoints: number;
  readonly zeroShare: number;
}

export interface SpreadStats {
  readonly zeroCount: number;
  readonly zeroShare: number;
  readonly medianPoints: number;
  readonly p99Points: number;
  readonly maxPoints: number;
  readonly wideCount: number;
  readonly byYear: readonly SpreadYear[];
}

export interface WeekStats {
  /** Weekend closures found in the data. */
  readonly total: number;
  /** Weeks whose last bar closes exactly at Friday 17:00 New York. */
  readonly closeOk: number;
  /** Weeks whose first bar opens exactly at Sunday 17:00 New York. */
  readonly openOk: number;
}

export interface SeriesReport {
  readonly symbol: SymbolName;
  readonly timeframe: Timeframe;
  readonly file: string;
  readonly present: boolean;
  /** Bars read from the file. */
  readonly rows: number;
  readonly firstTime: number | null;
  readonly lastTime: number | null;
  /** Bars inside the common period; null when the series could not be used. */
  readonly usedRows: number | null;
  readonly trimmedAtStart: number;
  readonly trimmedAtEnd: number;
  readonly gaps: readonly Gap[];
  readonly missingBars: number;
  readonly missingShare: number;
  readonly spread: SpreadStats | null;
  /** Intraday series only. */
  readonly weeks: WeekStats | null;
}

export interface ConsistencyReport {
  readonly symbol: SymbolName;
  readonly lower: Timeframe;
  readonly higher: Timeframe;
  readonly compared: number;
  readonly mismatches: number;
  readonly higherWithoutLower: number;
  readonly lowerWithoutHigher: number;
}

export interface ValidationReport {
  /** True when there are no errors. Warnings do not block a backtest. */
  readonly ok: boolean;
  readonly brokerTimeZone: string;
  /** Period covered by every usable series: [start, end), UTC ms. */
  readonly commonRange: { readonly start: number; readonly end: number } | null;
  /** null when no intraday series could be checked. */
  readonly timeZoneOk: boolean | null;
  readonly series: readonly SeriesReport[];
  readonly consistency: readonly ConsistencyReport[];
  readonly issues: readonly Issue[];
}

function lowerBound(bars: readonly Bar[], time: number): number {
  let low = 0;
  let high = bars.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((bars[middle] as Bar).time < time) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function percent(share: number): string {
  return `${(share * 100).toFixed(share < 0.1 ? 2 : 1)}%`;
}

function checkOrder(bars: readonly Bar[]): {
  unsorted: number;
  duplicates: number;
  firstUnsorted: number[];
  firstDuplicates: number[];
} {
  let unsorted = 0;
  let duplicates = 0;
  const firstUnsorted: number[] = [];
  const firstDuplicates: number[] = [];
  let previous: Bar | undefined;
  for (const bar of bars) {
    if (previous !== undefined) {
      if (bar.time < previous.time) {
        unsorted++;
        if (firstUnsorted.length < MAX_EXAMPLES) firstUnsorted.push(bar.time);
      } else if (bar.time === previous.time) {
        duplicates++;
        if (firstDuplicates.length < MAX_EXAMPLES) {
          firstDuplicates.push(bar.time);
        }
      }
    }
    previous = bar;
  }
  return { unsorted, duplicates, firstUnsorted, firstDuplicates };
}

function checkCandles(bars: readonly Bar[]): {
  badCandles: number;
  nonPositive: number;
  firstBad: number[];
  firstNonPositive: number[];
} {
  let badCandles = 0;
  let nonPositive = 0;
  const firstBad: number[] = [];
  const firstNonPositive: number[] = [];
  for (const bar of bars) {
    const consistent =
      bar.low <= bar.open &&
      bar.low <= bar.close &&
      bar.open <= bar.high &&
      bar.close <= bar.high;
    if (!consistent) {
      badCandles++;
      if (firstBad.length < MAX_EXAMPLES) firstBad.push(bar.time);
    }
    if (!(bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0)) {
      nonPositive++;
      if (firstNonPositive.length < MAX_EXAMPLES) {
        firstNonPositive.push(bar.time);
      }
    }
  }
  return { badCandles, nonPositive, firstBad, firstNonPositive };
}

function findIntradayGaps(
  bars: readonly Bar[],
  stepMs: number,
): { gaps: Gap[]; weeks: WeekStats } {
  const gaps: Gap[] = [];
  let total = 0;
  let closeOk = 0;
  let openOk = 0;
  let previous: Bar | undefined;
  for (const bar of bars) {
    if (previous !== undefined && bar.time - previous.time > stepMs) {
      const from = previous.time + stepMs;
      const to = bar.time;
      const closures = weekendClosuresBetween(from, to);
      let closedMs = 0;
      closures.forEach((closure, index) => {
        closedMs +=
          Math.min(to, closure.end) - Math.max(from, closure.start);
        total++;
        if (index === 0 && from === closure.start) closeOk++;
        if (index === closures.length - 1 && to === closure.end) openOk++;
      });
      const missingBars = Math.round((to - from - closedMs) / stepMs);
      if (missingBars > 0) {
        gaps.push({
          from,
          to,
          missingBars,
          kind: touchesFixedHoliday(from, to)
            ? "holiday"
            : closures.length > 0
              ? "weekend"
              : "intraweek",
        });
      }
    }
    previous = bar;
  }
  return { gaps, weeks: { total, closeOk, openOk } };
}

function findDailyGaps(bars: readonly Bar[], zone: string): Gap[] {
  const gaps: Gap[] = [];
  let previous: Bar | undefined;
  for (const bar of bars) {
    if (previous !== undefined) {
      const firstMissing = DateTime.fromMillis(previous.time, { zone })
        .startOf("day")
        .plus({ days: 1 });
      const end = DateTime.fromMillis(bar.time, { zone }).startOf("day");
      let missingBars = 0;
      // Luxon weekdays: 6 = Saturday, 7 = Sunday.
      for (let day = firstMissing; day < end; day = day.plus({ days: 1 })) {
        if (day.weekday <= 5) missingBars++;
      }
      if (missingBars > 0) {
        const from = firstMissing.toMillis();
        gaps.push({
          from,
          to: bar.time,
          missingBars,
          kind: touchesFixedHoliday(from, bar.time) ? "holiday" : "intraweek",
        });
      }
    }
    previous = bar;
  }
  return gaps;
}

function spreadStats(bars: readonly Bar[]): SpreadStats {
  const sorted = new Float64Array(bars.length);
  const years = new Map<number, { bars: number; sum: number; zero: number }>();
  let zeroCount = 0;
  let wideCount = 0;
  bars.forEach((bar, index) => {
    sorted[index] = bar.spreadPoints;
    if (bar.spreadPoints === 0) zeroCount++;
    if (bar.spreadPoints > WIDE_SPREAD_POINTS) wideCount++;
    const year = new Date(bar.time).getUTCFullYear();
    let entry = years.get(year);
    if (entry === undefined) {
      entry = { bars: 0, sum: 0, zero: 0 };
      years.set(year, entry);
    }
    entry.bars++;
    entry.sum += bar.spreadPoints;
    if (bar.spreadPoints === 0) entry.zero++;
  });
  sorted.sort();
  const at = (share: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
  return {
    zeroCount,
    zeroShare: bars.length === 0 ? 0 : zeroCount / bars.length,
    medianPoints: at(0.5),
    p99Points: at(0.99),
    maxPoints: sorted[sorted.length - 1] ?? 0,
    wideCount,
    byYear: [...years.entries()]
      .sort(([a], [b]) => a - b)
      .map(([year, entry]) => ({
        year,
        bars: entry.bars,
        meanPoints: entry.sum / entry.bars,
        zeroShare: entry.zero / entry.bars,
      })),
  };
}

interface Aggregation {
  compared: number;
  mismatches: number;
  higherWithoutLower: number;
  lowerWithoutHigher: number;
  examples: string[];
}

/**
 * Rebuilds every higher-timeframe bar from the lower-timeframe bars inside its
 * window and compares open, high, low and close. Both inputs must be sorted.
 */
function checkAggregation(
  lower: readonly Bar[],
  higher: readonly Bar[],
  windowEnd: (start: number) => number,
  describe: (time: number) => string,
): Aggregation {
  const result: Aggregation = {
    compared: 0,
    mismatches: 0,
    higherWithoutLower: 0,
    lowerWithoutHigher: 0,
    examples: [],
  };
  const note = (text: string): void => {
    if (result.examples.length < MAX_EXAMPLES) result.examples.push(text);
  };

  let index = 0;
  for (const bar of higher) {
    while (index < lower.length && (lower[index] as Bar).time < bar.time) {
      result.lowerWithoutHigher++;
      index++;
    }
    const end = windowEnd(bar.time);
    let count = 0;
    let open = Number.NaN;
    let high = -Infinity;
    let low = Infinity;
    let close = Number.NaN;
    while (index < lower.length && (lower[index] as Bar).time < end) {
      const inner = lower[index] as Bar;
      if (count === 0) open = inner.open;
      high = Math.max(high, inner.high);
      low = Math.min(low, inner.low);
      close = inner.close;
      count++;
      index++;
    }
    if (count === 0) {
      result.higherWithoutLower++;
      note(`${describe(bar.time)}: внутри нет младших свечей`);
      continue;
    }
    result.compared++;
    if (
      open !== bar.open ||
      high !== bar.high ||
      low !== bar.low ||
      close !== bar.close
    ) {
      result.mismatches++;
      note(
        `${describe(bar.time)}: в файле ${bar.open}/${bar.high}/${bar.low}/${bar.close}, по младшим ${open}/${high}/${low}/${close}`,
      );
    }
  }
  result.lowerWithoutHigher += lower.length - index;
  return result;
}

interface Usable {
  readonly input: SeriesInput;
  readonly bars: readonly Bar[];
}

/**
 * Checks a set of series that has already been read. Pure: no file access.
 * `validateData` is the version that reads the files named in the config.
 */
export function validateSeries(
  inputs: readonly SeriesInput[],
  brokerTimeZone: string,
): ValidationReport {
  const zone = brokerTimeZone;
  const issues: Issue[] = [];
  const serverTime = (time: number): string =>
    `${formatInZone(time, zone)} (сервер)`;
  const add = (
    severity: Severity,
    code: IssueCode,
    input: SeriesInput | null,
    message: string,
    examples: readonly string[] = [],
  ): void => {
    issues.push({
      severity,
      code,
      ...(input === null
        ? {}
        : { symbol: input.id.symbol, timeframe: input.id.timeframe }),
      message,
      examples,
    });
  };

  // 1. Per-file checks on everything that was read.
  const usable: Usable[] = [];
  for (const input of inputs) {
    const { file, parsed } = input;
    if (parsed === null) {
      if (input.formatError === undefined) {
        add("error", "missing-file", input, `Нет файла ${file}.`);
      } else {
        add("error", "bad-format", input, `${file}: ${input.formatError}.`);
      }
      continue;
    }
    if (parsed.rowErrorCount > 0) {
      add(
        "error",
        "bad-rows",
        input,
        `${file}: не прочитано строк: ${parsed.rowErrorCount} из ${parsed.rowCount}.`,
        parsed.rowErrors
          .slice(0, MAX_EXAMPLES)
          .map((row) => `строка ${row.line}: ${row.message}`),
      );
    }
    const bars = parsed.bars;
    if (bars.length === 0) {
      add("error", "empty", input, `${file}: в файле нет свечей.`);
      continue;
    }

    const order = checkOrder(bars);
    if (order.unsorted > 0) {
      add(
        "error",
        "unsorted",
        input,
        `${file}: порядок времени нарушен в ${order.unsorted} местах.`,
        order.firstUnsorted.map(serverTime),
      );
    }
    if (order.duplicates > 0) {
      add(
        "error",
        "duplicates",
        input,
        `${file}: повторяется время у ${order.duplicates} свечей.`,
        order.firstDuplicates.map(serverTime),
      );
    }

    const candles = checkCandles(bars);
    if (candles.badCandles > 0) {
      add(
        "error",
        "bad-candles",
        input,
        `${file}: у ${candles.badCandles} свечей нарушено low <= open, close <= high.`,
        candles.firstBad.map(serverTime),
      );
    }
    if (candles.nonPositive > 0) {
      add(
        "error",
        "non-positive",
        input,
        `${file}: у ${candles.nonPositive} свечей цена не больше нуля.`,
        candles.firstNonPositive.map(serverTime),
      );
    }

    // The remaining checks walk the series in time order.
    if (order.unsorted === 0 && order.duplicates === 0) {
      usable.push({ input, bars });
    }
  }

  // 2. Common period. The last server day found in a file is dropped because
  // the export may have been taken before that day ended.
  let commonRange: { start: number; end: number } | null = null;
  if (usable.length > 0) {
    let start = -Infinity;
    let end = Infinity;
    for (const { bars } of usable) {
      const first = (bars[0] as Bar).time;
      const last = (bars[bars.length - 1] as Bar).time;
      const dayStart = startOfZoneDay(first, zone);
      start = Math.max(start, dayStart === first ? first : nextZoneDay(first, zone));
      end = Math.min(end, startOfZoneDay(last, zone));
    }
    if (start < end) {
      commonRange = { start, end };
    } else {
      add(
        "error",
        "no-common-range",
        null,
        "У файлов нет общего периода: проверьте, что они выгружены за одни и те же годы.",
      );
    }
  }

  // 3. Checks on the common period.
  const trimmed = new Map<SeriesInput, readonly Bar[]>();
  const reports = new Map<SeriesInput, SeriesReport>();
  let checkedTimeZone = 0;
  let failedTimeZone = 0;
  let droppedAtStart = 0;
  let droppedAtEnd = 0;

  for (const input of inputs) {
    const all = input.parsed?.bars ?? [];
    const base = {
      symbol: input.id.symbol,
      timeframe: input.id.timeframe,
      file: input.file,
      present: input.parsed !== null || input.formatError !== undefined,
      rows: all.length,
      firstTime: all[0]?.time ?? null,
      lastTime: all[all.length - 1]?.time ?? null,
    };
    const entry = usable.find((candidate) => candidate.input === input);
    if (entry === undefined || commonRange === null) {
      reports.set(input, {
        ...base,
        usedRows: null,
        trimmedAtStart: 0,
        trimmedAtEnd: 0,
        gaps: [],
        missingBars: 0,
        missingShare: 0,
        spread: null,
        weeks: null,
      });
      continue;
    }

    const from = lowerBound(entry.bars, commonRange.start);
    const to = lowerBound(entry.bars, commonRange.end);
    const bars = entry.bars.slice(from, to);
    trimmed.set(input, bars);
    droppedAtStart += from;
    droppedAtEnd += entry.bars.length - to;

    const { file } = input;
    const { timeframe } = input.id;
    const stepMs = TIMEFRAME_MINUTES[timeframe] * MINUTE_MS;

    let gaps: Gap[];
    let weeks: WeekStats | null = null;
    if (timeframe === "D1") {
      gaps = findDailyGaps(bars, zone);
    } else {
      ({ gaps, weeks } = findIntradayGaps(bars, stepMs));
    }
    const missingBars = gaps.reduce((sum, gap) => sum + gap.missingBars, 0);
    const missingShare =
      bars.length + missingBars === 0
        ? 0
        : missingBars / (bars.length + missingBars);
    if (gaps.length > 0) {
      const count = (kind: GapKind): number =>
        gaps.filter((gap) => gap.kind === kind).length;
      const largest = [...gaps]
        .filter((gap) => gap.kind === "intraweek")
        .sort((a, b) => b.missingBars - a.missingBars)
        .slice(0, MAX_EXAMPLES);
      add(
        "warning",
        "gaps",
        input,
        `${file}: пропущено свечей внутри торговой недели: ${missingBars} (${percent(missingShare)} от ожидаемых), разрывов ${gaps.length}. ` +
          `У выходных: ${count("weekend")}, Рождество и Новый год: ${count("holiday")}, остальные: ${count("intraweek")}.`,
        largest.map(
          (gap) =>
            `с ${formatInZone(gap.from, zone)} по ${serverTime(gap.to)}: нет ${gap.missingBars} св.`,
        ),
      );
    }

    const spread = spreadStats(bars);
    if (spread.zeroCount > 0) {
      add(
        "warning",
        "zero-spread",
        input,
        `${file}: нулевой спред у ${spread.zeroCount} свечей (${percent(spread.zeroShare)}).`,
      );
    }
    if (spread.wideCount > 0) {
      const widest = [...bars]
        .filter((bar) => bar.spreadPoints > WIDE_SPREAD_POINTS)
        .sort((a, b) => b.spreadPoints - a.spreadPoints)
        .slice(0, MAX_EXAMPLES);
      add(
        "warning",
        "wide-spread",
        input,
        `${file}: спред больше ${WIDE_SPREAD_POINTS} пунктов у ${spread.wideCount} свечей, максимум ${spread.maxPoints}.`,
        widest.map((bar) => `${serverTime(bar.time)}: ${bar.spreadPoints} п.`),
      );
    }

    if (weeks !== null) {
      if (weeks.total < MIN_WEEKS_FOR_TIME_ZONE_CHECK) {
        add(
          "warning",
          "time-zone",
          input,
          `${file}: в данных ${weeks.total} нед., этого мало, чтобы проверить часовой пояс.`,
        );
      } else {
        checkedTimeZone++;
        const share = weeks.closeOk / weeks.total;
        if (share < TIME_ZONE_PASS_SHARE) {
          failedTimeZone++;
          add(
            "error",
            "time-zone",
            input,
            `${file}: неделя закрывается в пятницу 17:00 по Нью-Йорку только в ${weeks.closeOk} из ${weeks.total} недель (${percent(share)}, нужно не меньше ${percent(TIME_ZONE_PASS_SHARE)}). ` +
              `brokerTimeZone "${zone}" задан неверно, тесты запускать нельзя.`,
          );
        }
      }
    }

    reports.set(input, {
      ...base,
      usedRows: bars.length,
      trimmedAtStart: from,
      trimmedAtEnd: entry.bars.length - to,
      gaps,
      missingBars,
      missingShare,
      spread,
      weeks,
    });
  }

  if (commonRange !== null && droppedAtStart + droppedAtEnd > 0) {
    add(
      "info",
      "trimmed",
      null,
      `Вне общего периода осталось свечей: ${droppedAtStart} в начале и ${droppedAtEnd} в конце. ` +
        `Последний день в файлах отброшен: экспорт мог идти до его закрытия.`,
    );
  }

  // 4. Timeframes must agree with each other inside the common period.
  const consistency: ConsistencyReport[] = [];
  const pairs: ReadonlyArray<readonly [Timeframe, Timeframe]> = [
    ["M15", "H1"],
    ["H1", "D1"],
  ];
  for (const symbol of SYMBOLS) {
    for (const [lowerTf, higherTf] of pairs) {
      const find = (timeframe: Timeframe): SeriesInput | undefined =>
        inputs.find(
          (input) =>
            input.id.symbol === symbol && input.id.timeframe === timeframe,
        );
      const lowerInput = find(lowerTf);
      const higherInput = find(higherTf);
      const lower = lowerInput && trimmed.get(lowerInput);
      const higher = higherInput && trimmed.get(higherInput);
      if (lower === undefined || higher === undefined) {
        continue;
      }
      const result = checkAggregation(
        lower,
        higher,
        higherTf === "D1"
          ? (start) => nextZoneDay(start, zone)
          : (start) => start + HOUR_MS,
        (time) => `${symbol} ${higherTf} ${serverTime(time)}`,
      );
      consistency.push({
        symbol,
        lower: lowerTf,
        higher: higherTf,
        compared: result.compared,
        mismatches: result.mismatches,
        higherWithoutLower: result.higherWithoutLower,
        lowerWithoutHigher: result.lowerWithoutHigher,
      });
      if (
        result.mismatches > 0 ||
        result.higherWithoutLower > 0 ||
        result.lowerWithoutHigher > 0
      ) {
        issues.push({
          severity: "error",
          code: "inconsistent",
          symbol,
          timeframe: higherTf,
          message:
            `${symbol}: ${higherTf} не согласован с ${lowerTf}. Расхождений по ценам: ${result.mismatches}, ` +
            `свечей ${higherTf} без ${lowerTf} внутри: ${result.higherWithoutLower}, свечей ${lowerTf} вне ${higherTf}: ${result.lowerWithoutHigher}.`,
          examples: result.examples,
        });
      }
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    brokerTimeZone: zone,
    commonRange,
    timeZoneOk: checkedTimeZone === 0 ? null : failedTimeZone === 0,
    series: inputs.map((input) => reports.get(input) as SeriesReport),
    consistency,
    issues,
  };
}

/** Reads the nine files named in the TZ from the data directory and checks them. */
export function validateData(config: Config): ValidationReport {
  return validateSeries(readAllSeries(config), config.brokerTimeZone);
}
