// Windowed reading of very large MT5 exports (M1, M5) for the chart. Such a
// file is 250+ MB, so it is never parsed whole: one pass records where every
// line starts, and each request reads and parses only its window of bars.
// Server-side only.
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { AnyTimeframe } from "../../config";
import { parseMt5Csv } from "../../data/mt5-csv";
import type { ServerTimeConverter } from "../../data/time";
import type { Bar } from "../../data/types";

const SCAN_CHUNK = 16 * 1024 * 1024;

export interface LineIndex {
  readonly file: string;
  readonly size: number;
  readonly utf16: boolean;
  /** Header line, BOM and line break removed. */
  readonly header: string;
  /** Byte offset where each bar line starts, in file order. */
  readonly starts: Uint32Array;
  /** Number of bar lines. */
  readonly count: number;
}

/**
 * The export for a symbol and timeframe in the data directory: the TZ name
 * (EURUSD_M1.csv) or the name MT5 gives it (EURUSD_M1_201501050000_202611132359.csv).
 * When there are several, the largest. Null when there is none.
 */
export function findExport(dataDir: string, symbol: string, timeframe: AnyTimeframe): string | null {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return null;
  }
  const pattern = new RegExp(`^${symbol}_${timeframe}(?:_\\d{12}_\\d{12})?\\.csv$`, "i");
  const found = names
    .filter((name) => pattern.test(name))
    .map((name) => ({ name, size: statSync(path.join(dataDir, name)).size }))
    .sort((a, b) => b.size - a.size)[0];
  return found === undefined ? null : path.join(dataDir, found.name);
}

/** One pass over the file in chunks, recording where every line starts. */
export function buildLineIndex(file: string): LineIndex {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(SCAN_CHUNK, Math.max(size, 1)));
    let starts = new Uint32Array(1 << 16);
    let total = 0;
    const push = (offset: number): void => {
      if (total === starts.length) {
        const grown = new Uint32Array(starts.length * 2);
        grown.set(starts);
        starts = grown;
      }
      starts[total++] = offset;
    };

    let utf16 = false;
    for (let position = 0; position < size; position += SCAN_CHUNK) {
      const length = readSync(fd, buffer, 0, Math.min(SCAN_CHUNK, size - position), position);
      if (position === 0) utf16 = length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
      let at = buffer.indexOf(0x0a, 0);
      while (at !== -1 && at < length) {
        const absolute = position + at;
        // In UTF-16LE a line break is the code unit 0x000A: its low byte sits at an even offset.
        if (!utf16 || absolute % 2 === 0) push(absolute + (utf16 ? 2 : 1));
        at = buffer.indexOf(0x0a, at + 1);
      }
    }

    // The first recorded start is the first bar line; a start at the very end is no line.
    const firstBar = total > 0 ? (starts[0] as number) : size;
    let count = total;
    if (count > 0 && (starts[count - 1] as number) >= size) count--;
    const headerBytes = Buffer.alloc(firstBar);
    readSync(fd, headerBytes, 0, firstBar, 0);
    const header = headerBytes
      .toString(utf16 ? "utf16le" : "utf8")
      .replace(/^﻿/, "")
      .replace(/\r?\n$/, "");
    return { file, size, utf16, header, starts: starts.slice(0, count), count };
  } finally {
    closeSync(fd);
  }
}

/** Parses bar lines [from, to) of the file. Lines MT5 wrote badly are skipped, as on a full read. */
export function readBars(
  index: LineIndex,
  from: number,
  to: number,
  options: { timeframe: AnyTimeframe; toUtc: ServerTimeConverter },
): Bar[] {
  const first = Math.max(0, from);
  const last = Math.min(index.count, to);
  if (first >= last) return [];
  const start = index.starts[first] as number;
  const end = last < index.count ? (index.starts[last] as number) : index.size;
  const bytes = Buffer.alloc(end - start);
  const fd = openSync(index.file, "r");
  try {
    readSync(fd, bytes, 0, bytes.length, start);
  } finally {
    closeSync(fd);
  }
  const text = bytes.toString(index.utf16 ? "utf16le" : "utf8");
  return parseMt5Csv(`${index.header}\n${text}`, options).bars;
}

const cache = new Map<string, { key: string; index: LineIndex }>();
const MAX_CACHED = 4;

/** The line index of a file, rebuilt only when the file changes on disk. */
export function getLineIndex(file: string): LineIndex {
  const stat = statSync(file);
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = cache.get(file);
  if (cached?.key === key) return cached.index;
  const index = buildLineIndex(file);
  cache.delete(file);
  cache.set(file, { key, index });
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return index;
}
