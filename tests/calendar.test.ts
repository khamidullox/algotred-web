import { describe, expect, it } from "vitest";
import { CalendarFormatError, eventsBetween, parseCalendar, symbolCurrencies } from "../src/data/calendar";
import { decodeMt5File } from "../src/data/mt5-csv";

const HEADER_100 = "<DATE>\t<TIME>\t<VALUE_ID>\t<EVENT_ID>\t<EVENT_CODE>\t<NAME>\t<COUNTRY>\t<CURRENCY>\t<IMPORTANCE>\t<TYPE>\t<TIMEMODE>\t<UNIT>\t<MULTIPLIER>\t<ACTUAL>\t<FORECAST>\t<PREVIOUS>\t<REVISED_PREVIOUS>\t<IMPACT>\t<PERIOD>\t<REVISION>";
const HEADER_101 = HEADER_100.replace("<TIME>\t", "<TIME>\t<UTC>\t");

// Two NFP releases at 08:30 New York: one in summer (12:30 UTC), one in winter (13:30 UTC).
// An export made in winter (server UTC+2) writes both with +2 hours.
const SUMMER_100 = "2024.07.05\t14:30\t1\t840030016\tnonfarm-payrolls\tNonfarm Payrolls\tUS\tUSD\tHIGH\tINDICATOR\tDATETIME\t4\t1\t206.000\t190.000\t218.000\t\t0\t2024.06.01\t0";
const WINTER_100 = "2024.01.05\t15:30\t2\t840030016\tnonfarm-payrolls\tNonfarm Payrolls\tUS\tUSD\tHIGH\tINDICATOR\tDATETIME\t4\t1\t216.000\t170.000\t173.000\t\t0\t2023.12.01\t0";
const LOW_EUR = "2024.01.05\t11:00\tx\t1\tretail-sales\tRetail Sales\tEU\tEUR\tLOW\tINDICATOR\tTENTATIVE\t1\t0\t\t-0.300\t0.100\t\t0\t2023.11.01\t0";

describe("parseCalendar", () => {
  it("undoes the one export offset MT5 applies to the whole history", () => {
    const events = parseCalendar([HEADER_100, SUMMER_100, WINTER_100].join("\r\n"), 2);
    expect(events.map((event) => new Date(event.time).toISOString())).toEqual([
      "2024-01-05T13:30:00.000Z",
      "2024-07-05T12:30:00.000Z",
    ]);
    expect(events[1]).toMatchObject({ currency: "USD", code: "nonfarm-payrolls", importance: "HIGH", actual: 206, forecast: 190, previous: 218, revisedPrevious: null });
  });

  it("uses the <UTC> column of script 1.01", () => {
    const line = SUMMER_100.replace("14:30\t", "14:30\t2024.07.05 12:30\t");
    const [event] = parseCalendar([HEADER_101, line].join("\n"));
    expect(new Date(event?.time ?? 0).toISOString()).toBe("2024-07-05T12:30:00.000Z");
  });

  it("refuses an export without <UTC> when the offset is not given", () => {
    expect(() => parseCalendar([HEADER_100, SUMMER_100].join("\n"))).toThrow(CalendarFormatError);
  });

  it("reads the UTF-16 file MT5 writes", () => {
    const text = [HEADER_100, WINTER_100].join("\r\n");
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
    expect(parseCalendar(decodeMt5File(bytes), 2)).toHaveLength(1);
  });
});

describe("eventsBetween", () => {
  const events = parseCalendar([HEADER_100, SUMMER_100, WINTER_100, LOW_EUR].join("\n"), 2);

  it("filters by time, currency, importance and exact time", () => {
    const from = Date.parse("2024-01-05T00:00:00Z");
    const to = Date.parse("2024-01-06T00:00:00Z");
    expect(eventsBetween(events, from, to).map((event) => event.code)).toEqual(["nonfarm-payrolls"]);
    expect(eventsBetween(events, from, to, { exactTime: false }).map((event) => event.currency)).toEqual(["EUR", "USD"]);
    expect(eventsBetween(events, from, to, { exactTime: false, minImportance: "HIGH" }).map((event) => event.currency)).toEqual(["USD"]);
    expect(eventsBetween(events, from, to, { currencies: ["EUR"] })).toEqual([]);
  });
});

describe("symbolCurrencies", () => {
  it("knows pairs, metals and US indices", () => {
    expect(symbolCurrencies("EURUSD")).toEqual(["EUR", "USD"]);
    expect(symbolCurrencies("USDJPY")).toEqual(["USD", "JPY"]);
    expect(symbolCurrencies("XAUUSD")).toEqual(["USD"]);
    expect(symbolCurrencies("US500")).toEqual(["USD"]);
    expect(symbolCurrencies("US2000")).toEqual(["USD"]);
  });
});
