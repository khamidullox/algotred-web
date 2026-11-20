import { describe, expect, it } from "vitest";
import { parseReason } from "../src/app/_lib/trade-reason";

const ZONE = "Europe/Athens";
const utc = (iso: string): number => Date.parse(iso) / 1000;

describe("parseReason", () => {
  it("reads the level and the moments of BreakoutRetestV1", () => {
    const marks = parseReason(
      "L 1.52098; ATR(14) 0.00261; пробой 2015-02-04 14:00 close 1.52369; ретест 2015-02-04 16:00 low 1.52105; подтверждение 2015-02-04 17:00",
      ZONE,
    );
    expect(marks.level).toBe(1.52098);
    expect(marks.levelFrom).toBeNull();
    // Athens is UTC+2 in February.
    expect(marks.moments).toEqual([
      { label: "пробой", time: utc("2015-02-04T12:00:00Z") },
      { label: "ретест", time: utc("2015-02-04T14:00:00Z") },
      { label: "подтверждение", time: utc("2015-02-04T15:00:00Z") },
    ]);
    expect(marks.trendLine).toBeNull();
  });

  it("reads where a StrongLevelD1 level came from, on a summer date", () => {
    const marks = parseReason(
      "L 1.55516 от 2015-06-26, касаний 3; ATR(14) D1 0.01631; пробой 2015-07-11 close 1.55847; ретест 2015-07-12 low 1.55565",
      ZONE,
    );
    expect(marks.level).toBe(1.55516);
    expect(marks.levelFrom).toBe(utc("2015-06-25T21:00:00Z"));
    expect(marks.moments.map((moment) => moment.label)).toEqual(["пробой", "ретест"]);
  });

  it("reads the level of FailedBreakoutV1 and its failure", () => {
    const marks = parseReason(
      "L 1.50048 (low 2015-02-02 14:00); ATR(14) 0.00200; пробой вниз 2015-02-03 09:00 close 1.49987; провал 2015-02-03 10:00 close 1.50081; min 1.49883",
      ZONE,
    );
    expect(marks.level).toBe(1.50048);
    expect(marks.levelFrom).toBe(utc("2015-02-02T12:00:00Z"));
    expect(marks.moments.map((moment) => moment.label)).toEqual(["пробой вниз", "провал"]);
  });

  it("reads the trend line of ThreeTouchTrendD1", () => {
    const marks = parseReason(
      "линия по минимумам 2021-01-06 0.87577 — 2021-02-16 0.88710; касание 2021-04-29 при линии 0.90742; тейк 0.94727; ATR(14) 0.00573",
      ZONE,
    );
    expect(marks.level).toBeNull();
    expect(marks.trendLine).toEqual([
      { time: utc("2021-01-05T22:00:00Z"), price: 0.87577 },
      { time: utc("2021-02-15T22:00:00Z"), price: 0.8871 },
      { time: utc("2021-04-28T21:00:00Z"), price: 0.90742 },
    ]);
    expect(marks.moments).toEqual([{ label: "касание", time: utc("2021-04-28T21:00:00Z") }]);
  });

  it("reads the order level, the two bottoms and the order of DoubleBottomH1", () => {
    const marks = parseReason(
      "L 1.19911 (high 2024-05-07 10:00); середина 1.19900; дно 2024-05-07 06:00 1.19400; дно 2024-05-07 15:00 1.19420; ордер 2024-05-07 21:00; ATR(14) 0.00111; стоп 1.19389",
      ZONE,
    );
    expect(marks.level).toBe(1.19911);
    // Athens is UTC+3 in May.
    expect(marks.levelFrom).toBe(utc("2024-05-07T07:00:00Z"));
    expect(marks.moments).toEqual([
      { label: "дно", time: utc("2024-05-07T03:00:00Z") },
      { label: "дно", time: utc("2024-05-07T12:00:00Z") },
      { label: "ордер", time: utc("2024-05-07T18:00:00Z") },
    ]);
    const top = parseReason("L 1.20089 (low 2024-05-07 10:00); середина 1.20100; вершина 2024-05-07 06:00 1.20600; вершина 2024-05-07 15:00 1.20580; ордер 2024-05-07 21:00", ZONE);
    expect(top.moments.map((moment) => moment.label)).toEqual(["вершина", "вершина", "ордер"]);
  });

  it("reads moments as whole words only", () => {
    const marks = parseReason("L 1.10000; одно 2024-05-07 06:00; середина 2024-05-07 07:00", ZONE);
    expect(marks.moments).toEqual([]);
  });

  it("finds nothing in reasons without levels", () => {
    const marks = parseReason("RSI(2) 3.1 < 5, close 1.1050 > SMA(200) 1.0900", ZONE);
    expect(marks).toEqual({ level: null, levelFrom: null, moments: [], trendLine: null });
  });
});
