import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FEED_META, FEED_STALE_SECONDS, readTerminalFeed } from "../src/signals/terminal-feed";

const root = mkdtempSync(path.join(tmpdir(), "terminal-feed-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SYMBOL = {
  symbol: "SPX500",
  title: "S&P 500",
  file: "SPX500_D1.csv",
  digits: 2,
  tickSize: 0.1,
  tickValue: 1,
  lotMin: 0.01,
  lotStep: 0.01,
  lotMax: 100,
  dayOpen: true,
};
const META = { version: 1, serverTime: "2026.11.24 14:05:10", server: "Demo-Server", currency: "USD", balance: 6000, symbols: [SYMBOL] };

/** A feed folder holding this feed.json, written `ageSeconds` before `now`. */
function feedDir(content: string, ageSeconds = 0): { dir: string; now: number } {
  const dir = mkdtempSync(path.join(root, "feed-"));
  const file = path.join(dir, FEED_META);
  writeFileSync(file, content);
  return { dir, now: statSync(file).mtimeMs + ageSeconds * 1000 };
}

describe("readTerminalFeed", () => {
  it("reads the indicator's feed.json and says how old it is", () => {
    const { dir, now } = feedDir(JSON.stringify(META) + "\r\n", 12);
    const read = readTerminalFeed(dir, now);
    expect(read.kind).toBe("ok");
    if (read.kind !== "ok") return;
    expect(read.feed).toMatchObject({ dir, server: "Demo-Server", serverTime: "2026.11.24 14:05:10", currency: "USD", balance: 6000, ageSeconds: 12, stale: false });
    expect(read.feed.symbols).toEqual([SYMBOL]);
  });

  it("calls the feed stale once the indicator has stopped rewriting it", () => {
    const { dir, now } = feedDir(JSON.stringify(META));
    expect(readTerminalFeed(dir, now + FEED_STALE_SECONDS * 1000)).toMatchObject({ kind: "ok", feed: { stale: false } });
    expect(readTerminalFeed(dir, now + (FEED_STALE_SECONDS + 1) * 1000)).toMatchObject({ kind: "ok", feed: { stale: true, ageSeconds: FEED_STALE_SECONDS + 1 } });
    // A clock a little behind the file's time is not a negative age.
    expect(readTerminalFeed(dir, now - 5000)).toMatchObject({ kind: "ok", feed: { ageSeconds: 0 } });
  });

  it("reads a file with a byte order mark and an account with no currency", () => {
    const { dir, now } = feedDir("\uFEFF" + JSON.stringify({ ...META, currency: "", balance: 0, symbols: [] }));
    expect(readTerminalFeed(dir, now)).toMatchObject({ kind: "ok", feed: { currency: "USD", balance: 0, symbols: [] } });
  });

  it("is absent when the indicator has never written there", () => {
    expect(readTerminalFeed(path.join(root, "nothing-here"), Date.now())).toEqual({ kind: "absent" });
  });

  it("says what is wrong with a file that is not the feed", () => {
    const notJson = feedDir("{\"version\":1,");
    expect(readTerminalFeed(notJson.dir, notJson.now)).toMatchObject({ kind: "broken", problem: expect.stringContaining("не JSON") });
    const otherVersion = feedDir(JSON.stringify({ ...META, version: 2 }));
    expect(readTerminalFeed(otherVersion.dir, otherVersion.now)).toMatchObject({ kind: "broken", problem: expect.stringContaining("version") });
    const noTick = feedDir(JSON.stringify({ ...META, symbols: [{ ...SYMBOL, tickSize: 0 }] }));
    expect(readTerminalFeed(noTick.dir, noTick.now)).toMatchObject({ kind: "broken", problem: expect.stringContaining("tickSize") });
  });

  it("refuses a file name that is a path", () => {
    for (const file of ["..\\..\\secret_D1.csv", "sub/SPX500_D1.csv", "C:\\x_D1.csv", "SPX500_H1.csv", "SPX500_D1.csv.tmp"]) {
      const { dir, now } = feedDir(JSON.stringify({ ...META, symbols: [{ ...SYMBOL, file }] }));
      expect(readTerminalFeed(dir, now), file).toMatchObject({ kind: "broken", problem: expect.stringContaining("file") });
    }
  });

  it("keeps the age when the file's time is set back by hand", () => {
    const { dir } = feedDir(JSON.stringify(META));
    const file = path.join(dir, FEED_META);
    const hourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(file, hourAgo, hourAgo);
    const read = readTerminalFeed(dir, Date.now());
    expect(read).toMatchObject({ kind: "ok", feed: { stale: true } });
    if (read.kind === "ok") expect(read.feed.ageSeconds).toBeGreaterThanOrEqual(3599);
  });
});
