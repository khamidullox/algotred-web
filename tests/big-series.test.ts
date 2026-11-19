import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildLineIndex, findExport, readBars } from "../src/app/_lib/big-series";
import { createServerTimeConverter } from "../src/data/time";

const HEADER = "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>";
const LINES = Array.from({ length: 7 }, (_, minute) => {
  const price = (1.1 + minute / 10000).toFixed(5);
  return `2024.01.08\t10:0${minute}:00\t${price}\t${price}\t${price}\t${price}\t10\t0\t3`;
});
const options = { timeframe: "M1" as const, toUtc: createServerTimeConverter("Europe/Athens") };
const directory = mkdtempSync(path.join(tmpdir(), "big-series-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function write(name: string, text: string, utf16 = false): string {
  const file = path.join(directory, name);
  writeFileSync(file, utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]) : text);
  return file;
}

describe("line index of a large MT5 export", () => {
  for (const utf16 of [false, true]) {
    it(`reads any window of bars (${utf16 ? "UTF-16, as MT5 exports by default" : "UTF-8"})`, () => {
      const file = write(`EURUSD_M1_${utf16 ? "16" : "8"}.csv`, [HEADER, ...LINES].join("\r\n") + "\r\n", utf16);
      const index = buildLineIndex(file);
      expect(index.count).toBe(7);
      expect(index.header).toBe(HEADER);
      const window = readBars(index, 2, 5, options);
      expect(window.map((bar) => bar.close)).toEqual([1.1002, 1.1003, 1.1004]);
      // Athens is UTC+2 in January: 10:02 server time is 08:02 UTC.
      expect(window[0]?.time).toBe(Date.parse("2024-01-08T08:02:00Z"));
      expect(readBars(index, 6, 99, options).map((bar) => bar.close)).toEqual([1.1006]);
      expect(readBars(index, 7, 9, options)).toEqual([]);
    });
  }

  it("reads the last line when the file does not end with a line break", () => {
    const index = buildLineIndex(write("USDJPY_M1.csv", [HEADER, ...LINES].join("\n")));
    expect(index.count).toBe(7);
    expect(readBars(index, 0, 7, options)).toHaveLength(7);
  });
});

describe("findExport", () => {
  it("finds the MT5 export name and prefers the largest file", () => {
    const dir = mkdtempSync(path.join(directory, "find-"));
    writeFileSync(path.join(dir, "GBPUSD_M1_201502020000_202001010000.csv"), "x");
    writeFileSync(path.join(dir, "GBPUSD_M1_201502020000_202611132359.csv"), "xxxx");
    writeFileSync(path.join(dir, "GBPUSD_M15.csv"), "xxxxxxxx");
    expect(findExport(dir, "GBPUSD", "M1")).toBe(path.join(dir, "GBPUSD_M1_201502020000_202611132359.csv"));
    expect(findExport(dir, "GBPUSD", "M5")).toBeNull();
  });
});
