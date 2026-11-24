// The live feed the MT5 indicator tools/mt5/Rsi2IndexSignal.mq5 writes for the
// "Signals" page: daily bars of every index in the MT5 export format and one
// feed.json with the broker's contract facts. Server-side only. The files are
// data from a program on this computer: they are parsed, never trusted to
// name a path.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** The folder inside the terminal's common Files folder. */
export const FEED_FOLDER = "algotred_feed";
export const FEED_META = "feed.json";
/** The indicator rewrites the feed every 30 seconds; older than this it has stopped. */
export const FEED_STALE_SECONDS = 180;

const symbolSchema = z.object({
  symbol: z.string().min(1).max(40),
  title: z.string().max(40),
  /** A plain name inside the feed folder, never a path. */
  file: z.string().regex(/^[0-9A-Za-z_]{1,40}_D1\.csv$/),
  digits: z.number().int().min(0).max(8),
  tickSize: z.number().positive(),
  /** 0 when the broker did not give it: the lot cannot be counted then. */
  tickValue: z.number().nonnegative(),
  lotMin: z.number().nonnegative(),
  lotStep: z.number().nonnegative(),
  lotMax: z.number().nonnegative(),
  /** True when the last row of the file is a day still trading. */
  dayOpen: z.boolean(),
});

const feedSchema = z.object({
  version: z.literal(1),
  serverTime: z.string().max(40),
  server: z.string().max(80),
  currency: z.string().max(12),
  balance: z.number().nonnegative(),
  symbols: z.array(symbolSchema).max(20),
});

export type FeedSymbol = z.infer<typeof symbolSchema>;

export interface TerminalFeed {
  readonly dir: string;
  readonly server: string;
  /** The server's clock when the feed was written, as the terminal prints it. */
  readonly serverTime: string;
  readonly currency: string;
  /** 0 when the terminal was not connected to an account. */
  readonly balance: number;
  readonly symbols: readonly FeedSymbol[];
  /** Seconds since feed.json was written, by this computer's clock. */
  readonly ageSeconds: number;
  readonly stale: boolean;
}

export type FeedRead =
  /** No feed.json: the indicator has never written here. */
  | { readonly kind: "absent" }
  | { readonly kind: "broken"; readonly problem: string }
  | { readonly kind: "ok"; readonly feed: TerminalFeed };

/** Where the indicator writes on this computer; null outside Windows. */
export function defaultFeedDir(): string | null {
  const appData = process.env.APPDATA;
  if (appData === undefined || appData === "") return null;
  return path.join(appData, "MetaQuotes", "Terminal", "Common", "Files", FEED_FOLDER);
}

export function readTerminalFeed(dir: string, now: number): FeedRead {
  const file = path.join(dir, FEED_META);
  let text: string;
  let written: number;
  try {
    written = statSync(file).mtimeMs;
    text = readFileSync(file, "utf8");
  } catch {
    return { kind: "absent" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { kind: "broken", problem: `Файл ${FEED_META} от индикатора не читается: это не JSON.` };
  }
  const parsed = feedSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined ? "" : ` (${issue.path.join(".")}: ${issue.message})`;
    return { kind: "broken", problem: `Файл ${FEED_META} от индикатора не того вида${where}.` };
  }
  const ageSeconds = Math.max(0, Math.round((now - written) / 1000));
  return {
    kind: "ok",
    feed: {
      dir,
      server: parsed.data.server,
      serverTime: parsed.data.serverTime,
      currency: parsed.data.currency === "" ? "USD" : parsed.data.currency,
      balance: parsed.data.balance,
      symbols: parsed.data.symbols,
      ageSeconds,
      stale: ageSeconds > FEED_STALE_SECONDS,
    },
  };
}
