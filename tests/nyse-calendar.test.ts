import { describe, expect, it } from "vitest";
import {
  easterSunday,
  isNyseTradingDay,
  nextNyseTradingDay,
  nyseHolidays,
  nyseTradingDaysOfMonth,
} from "../src/data/nyse-calendar";

/** NYSE full-day closures as the exchange published them, 2015-2026. */
const PUBLISHED: Readonly<Record<number, readonly string[]>> = {
  2015: ["01-01", "01-19", "02-16", "04-03", "05-25", "07-03", "09-07", "11-26", "12-25"],
  2016: ["01-01", "01-18", "02-15", "03-25", "05-30", "07-04", "09-05", "11-24", "12-26"],
  2017: ["01-02", "01-16", "02-20", "04-14", "05-29", "07-04", "09-04", "11-23", "12-25"],
  2018: ["01-01", "01-15", "02-19", "03-30", "05-28", "07-04", "09-03", "11-22", "12-05", "12-25"],
  2019: ["01-01", "01-21", "02-18", "04-19", "05-27", "07-04", "09-02", "11-28", "12-25"],
  2020: ["01-01", "01-20", "02-17", "04-10", "05-25", "07-03", "09-07", "11-26", "12-25"],
  2021: ["01-01", "01-18", "02-15", "04-02", "05-31", "07-05", "09-06", "11-25", "12-24"],
  2022: ["01-17", "02-21", "04-15", "05-30", "06-20", "07-04", "09-05", "11-24", "12-26"],
  2023: ["01-02", "01-16", "02-20", "04-07", "05-29", "06-19", "07-04", "09-04", "11-23", "12-25"],
  2024: ["01-01", "01-15", "02-19", "03-29", "05-27", "06-19", "07-04", "09-02", "11-28", "12-25"],
  2025: ["01-01", "01-09", "01-20", "02-17", "04-18", "05-26", "06-19", "07-04", "09-01", "11-27", "12-25"],
  2026: ["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"],
};

describe("NYSE calendar (TZ 17.6)", () => {
  for (const [year, dates] of Object.entries(PUBLISHED)) {
    it(`matches the published closures of ${year}`, () => {
      expect([...nyseHolidays(Number(year))].sort()).toEqual(dates.map((date) => `${year}-${date}`));
    });
  }

  it("computes Easter", () => {
    expect(easterSunday(2015).toISODate()).toBe("2015-04-05");
    expect(easterSunday(2019).toISODate()).toBe("2019-04-21");
    expect(easterSunday(2024).toISODate()).toBe("2024-03-31");
  });

  it("keeps the exchange open on December 31 when New Year's Day is a Saturday", () => {
    expect(isNyseTradingDay("2021-12-31")).toBe(true);
    expect(isNyseTradingDay("2022-01-03")).toBe(true);
  });

  it("knows weekends and holidays", () => {
    expect(isNyseTradingDay("2024-05-25")).toBe(false); // Saturday
    expect(isNyseTradingDay("2024-05-27")).toBe(false); // Memorial Day
    expect(isNyseTradingDay("2024-05-28")).toBe(true);
  });

  it("lists the trading days of a month and finds the next one", () => {
    const may2021 = nyseTradingDaysOfMonth(2021, 5);
    expect(may2021.at(-1)).toBe("2021-05-28"); // May 31 is Memorial Day
    expect(may2021).toHaveLength(20);
    expect(nyseTradingDaysOfMonth(2015, 1).slice(0, 3)).toEqual(["2015-01-02", "2015-01-05", "2015-01-06"]);
    expect(nextNyseTradingDay("2015-12-31")).toBe("2016-01-04");
    expect(nextNyseTradingDay("2021-05-28")).toBe("2021-06-01");
  });
});
