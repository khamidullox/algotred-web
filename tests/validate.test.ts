import { describe, expect, it } from "vitest";
import type { SeriesInput } from "../src/data/load";
import {
  validateSeries,
  type Issue,
  type IssueCode,
  type ValidationReport,
} from "../src/data/validate";
import { formatValidationReport } from "../src/data/validate-report";
import { makeWeeks, toInput, toInputs, type SyntheticSet } from "./helpers/synthetic";

const ZONE = "Europe/Athens";
// Six full weeks in May and June 2024: Europe and the US are both on summer time,
// so Monday 00:00 server time is Sunday 17:00 New York.
const FIRST_MONDAY = "2024-05-06";
const WEEKS = 6;

const clone = (set: SyntheticSet): SyntheticSet => ({
  m15: set.m15.map((row) => ({ ...row })),
  h1: set.h1.map((row) => ({ ...row })),
  d1: set.d1.map((row) => ({ ...row })),
});

function validate(set: SyntheticSet, zone = ZONE): ValidationReport {
  return validateSeries(toInputs("EURUSD", set, zone), zone);
}

function issuesOf(report: ValidationReport, code: IssueCode): Issue[] {
  return report.issues.filter((issue) => issue.code === code);
}

const errors = (report: ValidationReport): Issue[] =>
  report.issues.filter((issue) => issue.severity === "error");

describe("validateSeries on clean data", () => {
  const set = makeWeeks(FIRST_MONDAY, WEEKS);
  const report = validate(set);

  it("finds no errors and no warnings", () => {
    expect(errors(report)).toEqual([]);
    expect(report.issues.filter((issue) => issue.severity === "warning")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("confirms the time zone from the weekly close", () => {
    expect(report.timeZoneOk).toBe(true);
    const m15 = report.series.find((series) => series.timeframe === "M15");
    // The last day is dropped, so five weekend closures remain between six weeks.
    expect(m15?.weeks).toEqual({ total: 5, closeOk: 5, openOk: 5 });
  });

  it("drops the last server day and nothing else", () => {
    const m15 = report.series.find((series) => series.timeframe === "M15");
    const d1 = report.series.find((series) => series.timeframe === "D1");
    expect(m15?.rows).toBe(WEEKS * 5 * 96);
    expect(m15?.usedRows).toBe((WEEKS * 5 - 1) * 96);
    expect(m15?.trimmedAtEnd).toBe(96);
    expect(d1?.usedRows).toBe(WEEKS * 5 - 1);
    expect(issuesOf(report, "trimmed")).toHaveLength(1);
  });

  it("rebuilds H1 from M15 and D1 from H1 without differences", () => {
    expect(report.consistency).toEqual([
      {
        symbol: "EURUSD",
        lower: "M15",
        higher: "H1",
        compared: (WEEKS * 5 - 1) * 24,
        mismatches: 0,
        higherWithoutLower: 0,
        lowerWithoutHigher: 0,
      },
      {
        symbol: "EURUSD",
        lower: "H1",
        higher: "D1",
        compared: WEEKS * 5 - 1,
        mismatches: 0,
        higherWithoutLower: 0,
        lowerWithoutHigher: 0,
      },
    ]);
  });

  it("prints a report that says the data can be used", () => {
    const text = formatValidationReport(report);
    expect(text).toContain("EURUSD_M15.csv");
    expect(text).toContain("Часовой пояс: подтверждён.");
    expect(text).toContain("ошибок нет");
  });
});

describe("validateSeries time zone check", () => {
  it("rejects data read with the wrong broker time zone", () => {
    const set = makeWeeks(FIRST_MONDAY, WEEKS);
    for (const wrongZone of ["UTC", "Europe/London", "Asia/Tashkent"]) {
      const report = validate(set, wrongZone);
      expect(report.timeZoneOk).toBe(false);
      expect(report.ok).toBe(false);
      const [issue] = issuesOf(report, "time-zone");
      expect(issue?.severity).toBe("error");
      expect(issue?.message).toContain("тесты запускать нельзя");
    }
  });

  it("accepts a week that opens an hour late while only the US is on summer time", () => {
    // 11-29 March 2024: the US has changed its clocks, Europe has not. The real
    // server then closes at Friday 23:00 server time and still opens Monday 00:00.
    const set = makeWeeks("2024-03-04", 5);
    const lateFriday = new Set(["2024.03.15", "2024.03.22", "2024.03.29"]);
    const cut = (rows: SyntheticSet["m15"]): SyntheticSet["m15"] =>
      rows.filter((row) => !(lateFriday.has(row.date) && row.time >= "23:00:00"));
    const report = validateSeries(
      [toInput("EURUSD", "H1", cut(set.h1), ZONE), toInput("EURUSD", "M15", cut(set.m15), ZONE)],
      ZONE,
    );
    expect(report.timeZoneOk).toBe(true);
    const m15 = report.series.find((series) => series.timeframe === "M15");
    expect(m15?.weeks).toEqual({ total: 4, closeOk: 4, openOk: 1 });
    // The missing first hour of those weeks is reported as a gap next to the weekend.
    expect(m15?.gaps.filter((gap) => gap.kind === "weekend")).toHaveLength(3);
    expect(m15?.gaps.every((gap) => gap.missingBars === 4)).toBe(true);
  });

  it("does not judge the time zone from too little data", () => {
    const report = validate(makeWeeks(FIRST_MONDAY, 2));
    expect(report.timeZoneOk).toBeNull();
    expect(issuesOf(report, "time-zone").every((issue) => issue.severity === "warning")).toBe(true);
  });
});

describe("validateSeries on an export taken in the middle of a day", () => {
  it("drops the unfinished last day instead of reporting a mismatch", () => {
    const set = clone(makeWeeks(FIRST_MONDAY, WEEKS));
    const lastDate = set.d1[set.d1.length - 1]?.date ?? "";
    set.m15 = set.m15.filter((row) => !(row.date === lastDate && row.time > "12:00:00"));
    set.h1 = set.h1.filter((row) => !(row.date === lastDate && row.time > "12:00:00"));
    const lastDaily = set.d1[set.d1.length - 1];
    if (lastDaily) lastDaily.close += 37; // a D1 bar that was still forming
    const report = validate(set);
    expect(errors(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("validateSeries problems", () => {
  const base = makeWeeks(FIRST_MONDAY, WEEKS);

  it("reports a missing file", () => {
    const inputs: SeriesInput[] = [
      ...toInputs("EURUSD", base, ZONE),
      { id: { symbol: "GBPUSD", timeframe: "M15" }, file: "GBPUSD_M15.csv", parsed: null },
    ];
    const report = validateSeries(inputs, ZONE);
    expect(report.ok).toBe(false);
    expect(issuesOf(report, "missing-file")[0]?.message).toContain("GBPUSD_M15.csv");
    expect(report.series.find((series) => series.symbol === "GBPUSD")?.present).toBe(false);
  });

  it("reports a file that is not an MT5 export", () => {
    const inputs: SeriesInput[] = [
      ...toInputs("EURUSD", base, ZONE),
      {
        id: { symbol: "GBPUSD", timeframe: "H1" },
        file: "GBPUSD_H1.csv",
        parsed: null,
        formatError: "Заголовок не похож на экспорт баров MT5",
      },
    ];
    const report = validateSeries(inputs, ZONE);
    expect(issuesOf(report, "bad-format")).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it("reports duplicated and unsorted bars", () => {
    const duplicated = clone(base);
    duplicated.h1.splice(10, 0, { ...(duplicated.h1[10] as SyntheticSet["h1"][number]) });
    expect(issuesOf(validate(duplicated), "duplicates")).toHaveLength(1);

    const unsorted = clone(base);
    const [moved] = unsorted.h1.splice(20, 1);
    if (moved) unsorted.h1.splice(15, 0, moved);
    const report = validate(unsorted);
    expect(issuesOf(report, "unsorted")).toHaveLength(1);
    expect(report.ok).toBe(false);
  });

  it("reports candles that break low <= open, close <= high", () => {
    const set = clone(base);
    const bar = set.m15[100];
    if (bar) bar.low = bar.open + 1;
    const report = validate(set);
    const [issue] = issuesOf(report, "bad-candles");
    expect(issue?.message).toContain("у 1 свечей");
    expect(report.ok).toBe(false);
  });

  it("reports non-positive prices", () => {
    const set = clone(base);
    const bar = set.m15[100];
    if (bar) bar.low = 0;
    expect(issuesOf(validate(set), "non-positive")).toHaveLength(1);
  });

  it("reports unreadable rows", () => {
    const inputs = toInputs("EURUSD", base, ZONE).map((input) =>
      input.id.timeframe === "H1" && input.parsed
        ? {
            ...input,
            parsed: {
              ...input.parsed,
              rowErrorCount: 2,
              rowErrors: [{ line: 7, message: "в числовой колонке не число" }],
            },
          }
        : input,
    );
    const [issue] = issuesOf(validateSeries(inputs, ZONE), "bad-rows");
    expect(issue?.examples[0]).toContain("строка 7");
  });

  it("counts bars missing inside a trading week as a warning, not an error", () => {
    const set = clone(base);
    // Wednesday of the first week, 10:00-12:00 server time.
    const hole = (row: SyntheticSet["m15"][number]): boolean =>
      row.date === "2024.05.08" && row.time >= "10:00:00" && row.time < "12:00:00";
    set.m15 = set.m15.filter((row) => !hole(row));
    const report = validateSeries([toInput("EURUSD", "M15", set.m15, ZONE)], ZONE);
    const [series] = report.series;
    expect(series?.gaps).toHaveLength(1);
    expect(series?.gaps[0]).toMatchObject({ missingBars: 8, kind: "intraweek" });
    expect(series?.missingBars).toBe(8);
    expect(issuesOf(report, "gaps")[0]?.severity).toBe("warning");
    expect(report.ok).toBe(true);
  });

  it("counts a missing weekday in D1", () => {
    const set = clone(base);
    set.d1 = set.d1.filter((row) => row.date !== "2024.05.08");
    const report = validateSeries([toInput("EURUSD", "D1", set.d1, ZONE)], ZONE);
    expect(report.series[0]?.gaps).toHaveLength(1);
    expect(report.series[0]?.gaps[0]).toMatchObject({ missingBars: 1, kind: "intraweek" });
  });

  it("marks a gap over 25 December as a holiday", () => {
    const set = clone(makeWeeks("2023-12-11", 4));
    set.h1 = set.h1.filter((row) => row.date !== "2023.12.25");
    const report = validateSeries([toInput("EURUSD", "H1", set.h1, ZONE)], ZONE);
    const kinds = report.series[0]?.gaps.map((gap) => gap.kind);
    expect(kinds).toContain("holiday");
  });

  it("reports zero and abnormally wide spreads", () => {
    const set = clone(base);
    set.m15.slice(0, 10).forEach((row) => (row.spread = 0));
    const wide = set.m15[500];
    if (wide) wide.spread = 300;
    const report = validateSeries([toInput("EURUSD", "M15", set.m15, ZONE)], ZONE);
    expect(issuesOf(report, "zero-spread")[0]?.message).toContain("у 10 свечей");
    expect(issuesOf(report, "wide-spread")[0]?.message).toContain("максимум 300");
    expect(report.series[0]?.spread).toMatchObject({ zeroCount: 10, wideCount: 1, maxPoints: 300 });
    expect(report.ok).toBe(true);
  });

  it("reports a higher timeframe that disagrees with the lower one", () => {
    const set = clone(base);
    const bar = set.h1[30];
    // Far above every other price, so it is also above that day's D1 high.
    if (bar) bar.high += 50_000;
    const report = validate(set);
    const mismatched = issuesOf(report, "inconsistent");
    // H1 no longer matches M15, and D1 no longer matches the altered H1.
    expect(mismatched.map((issue) => issue.timeframe)).toEqual(["H1", "D1"]);
    expect(report.consistency[0]).toMatchObject({ mismatches: 1 });
    expect(report.ok).toBe(false);
  });

  it("reports bars that exist on one timeframe only", () => {
    const set = clone(base);
    set.h1 = set.h1.filter((row) => !(row.date === "2024.05.08" && row.time === "10:00:00"));
    const report = validate(set);
    expect(report.consistency[0]).toMatchObject({ lowerWithoutHigher: 4 });
    expect(issuesOf(report, "inconsistent").length).toBeGreaterThan(0);
  });

  it("reports series that do not overlap in time", () => {
    const early = makeWeeks("2024-01-08", 2);
    const late = makeWeeks("2024-05-06", 2);
    const report = validateSeries(
      [toInput("EURUSD", "H1", early.h1, ZONE), toInput("EURUSD", "M15", late.m15, ZONE)],
      ZONE,
    );
    expect(issuesOf(report, "no-common-range")).toHaveLength(1);
    expect(report.commonRange).toBeNull();
    expect(report.ok).toBe(false);
  });
});

describe("validateSeries common period", () => {
  it("starts at the latest first day across series", () => {
    const eur = makeWeeks(FIRST_MONDAY, WEEKS);
    const gbp = makeWeeks("2024-05-13", WEEKS - 1);
    const report = validateSeries(
      [...toInputs("EURUSD", eur, ZONE), ...toInputs("GBPUSD", gbp, ZONE)],
      ZONE,
    );
    const eurM15 = report.series.find((s) => s.symbol === "EURUSD" && s.timeframe === "M15");
    const gbpM15 = report.series.find((s) => s.symbol === "GBPUSD" && s.timeframe === "M15");
    expect(eurM15?.trimmedAtStart).toBe(5 * 96);
    expect(gbpM15?.trimmedAtStart).toBe(0);
    expect(eurM15?.usedRows).toBe(gbpM15?.usedRows);
    expect(report.ok).toBe(true);
  });
});
