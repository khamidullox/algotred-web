// Event study for the two "fixing" ideas of TZ 17.21, dev only.
//
// A. The Tokyo fixing (9:55 Tokyo time) on "gotobi" days, the 5th, 10th, ...
//    30th of a month, when Japanese importers settle in dollars: USDJPY is
//    said to rise into the fixing and to fall back after it (Bessho, Sugimoto
//    and Suzuki 2023). Measured on the M1 file of USDJPY.
// B. The dollar around the fixings on every day (Krohn, Mueller and Whelan):
//    its average move by the hour, on the seven dollar pairs.
// C. The London 4 p.m. fixing on the last day of a month: after a month in
//    which US shares rose, the dollar is said to weaken before the fixing
//    (Melvin and Prins 2015).
//
// Reads the MT5 files and the exchange index files directly; no engine.
// Usage: node research/fix-study.mjs
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const DEV_START = "2015.02.02";
const DEV_END = config.datasets.testStart.replaceAll("-", ".");
const HOUR = 3600e3, MIN = 60e3, DAY = 86400e3;
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];

// --- time
const athens = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Athens", hour: "2-digit", hour12: false });
const offsets = new Map();
function serverToUtc(date, time) {
  let offset = offsets.get(date);
  if (offset === undefined) {
    const noon = Date.parse(`${date}T12:00:00Z`);
    for (const hours of [2, 3]) if (+athens.format(new Date(noon - hours * HOUR)) % 24 === 12) offset = hours * HOUR;
    offsets.set(date, offset);
  }
  return Date.parse(`${date}T${time}:00Z`) - offset;
}
const london = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false });
/** UTC ms of a London wall-clock time on a calendar date (yyyy-mm-dd). */
function londonToUtc(date, hour, minute = 0) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  // London is UTC or UTC+1: the hour London shows at the guessed instant tells which.
  const shown = +london.format(new Date(guess)) % 24;
  return guess - ((shown - hour + 24) % 24) * HOUR;
}
/** UTC ms of a Tokyo wall-clock time: Japan has no summer time. */
const tokyoToUtc = (date, hour, minute = 0) => Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) - 9 * HOUR;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, n) => iso(Date.parse(`${date}T00:00:00Z`) + n * DAY);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

// --- stats
const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function stat(xs) {
  const list = xs.filter((x) => x !== null && Number.isFinite(x));
  const m = mean(list);
  const sd = Math.sqrt(mean(list.map((x) => (x - m) ** 2)) * (list.length / Math.max(1, list.length - 1)));
  return { n: list.length, m, t: m / (sd / Math.sqrt(Math.max(1, list.length))) };
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const cell = (xs, d = 2) => { const s = stat(xs); return `${f(s.m, d)} (t ${f(s.t, 1)}, n ${s.n})`; };

// --- files
function readTable(file) {
  const buffer = readFileSync(file);
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  const head = lines[0].split("\t").map((name) => name.replace(/[<>]/g, "").trim());
  return lines.slice(1).map((line) => { const cells = line.split("\t"); return Object.fromEntries(head.map((name, i) => [name, cells[i]])); });
}
/** Open prices of an M15 file by UTC time, dev only. */
function loadM15(symbol) {
  const map = new Map();
  for (const r of readTable(path.join(config.dataDir, `${symbol}_M15.csv`))) {
    if (r.DATE < DEV_START || r.DATE >= DEV_END) continue;
    map.set(serverToUtc(r.DATE.replaceAll(".", "-"), r.TIME.slice(0, 5)), { open: +r.OPEN, spread: +r.SPREAD });
  }
  return map;
}
/** Daily closes of an exchange index by its own date (yyyy-mm-dd), from research/fetch-yahoo.mjs. */
function loadIndex(name) {
  const file = path.join("data/raw/research-yahoo", `${name}_D1.csv`);
  if (!existsSync(file)) return null;
  return readTable(file).map((r) => ({ date: r.DATE.replaceAll(".", "-"), close: +r.CLOSE }));
}

// ============================================================ A. Tokyo fixing
console.log("A. USDJPY around the Tokyo fixing (9:55 Tokyo time), M1 data, dev. Moves in pips; a pip of USDJPY is 0.01.");
// Japanese public holidays: the fixing is not made on them and a gotobi day moves to the business day before.
const HOLIDAY_CACHE = "data/raw/research-yahoo/jp-holidays.json";
let holidays = new Set();
try {
  if (!existsSync(HOLIDAY_CACHE)) {
    const all = {};
    for (let year = 2015; year <= 2021; year++) {
      const response = await fetch(`https://holidays-jp.github.io/api/v1/${year}/date.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${year}`);
      Object.assign(all, await response.json());
    }
    writeFileSync(HOLIDAY_CACHE, JSON.stringify(all));
  }
  holidays = new Set(Object.keys(JSON.parse(readFileSync(HOLIDAY_CACHE, "utf8"))));
  console.log(`  Japanese holidays 2015-2021: ${holidays.size} (holidays-jp.github.io)`);
} catch (error) {
  console.log(`  Japanese holidays could not be loaded (${error.message}): weekdays only`);
}
// Banks in Japan are also shut on 31 December and 2-3 January.
const bankHoliday = (date) => holidays.has(date) || /-(12-31|01-0[123])$/.test(date);
const businessDay = (date) => weekday(date) >= 1 && weekday(date) <= 5 && !bankHoliday(date);
const gotobi = new Set();
const monthEnd = new Set();
for (let t = Date.parse("2015-02-01T00:00:00Z"); t < Date.parse("2021-12-31T00:00:00Z"); t += DAY) {
  const date = iso(t);
  const dayOfMonth = +date.slice(8, 10);
  const lastOfMonth = iso(t + DAY).slice(5, 7) !== date.slice(5, 7);
  if (dayOfMonth % 5 !== 0 && !lastOfMonth) continue;
  // Moved to the business day before when it falls on a day the banks are shut.
  let d = date;
  while (!businessDay(d)) d = addDays(d, -1);
  if (dayOfMonth % 5 === 0) gotobi.add(d);
  if (lastOfMonth) monthEnd.add(d);
}

const MARKS = [[7, 0], [8, 0], [9, 0], [9, 30], [9, 55], [10, 0], [10, 30], [11, 0], [12, 0], [15, 0]];
const need = new Map();
const tokyoDays = [];
for (let t = Date.parse("2015-02-02T00:00:00Z"); t < Date.parse(`${config.datasets.testStart}T00:00:00Z`) - DAY; t += DAY) {
  const date = iso(t);
  if (!businessDay(date)) continue;
  tokyoDays.push(date);
  for (const [h, m] of MARKS) need.set(tokyoToUtc(date, h, m), null);
}
{
  const file = readdirSync(config.dataDir).find((name) => name.startsWith("USDJPY_M1_"));
  const lines = createInterface({ input: createReadStream(path.join(config.dataDir, file), { encoding: "utf8" }) });
  let first = true;
  for await (const line of lines) {
    if (first) { first = false; continue; }
    const date = line.slice(0, 10);
    if (date < "2015.02.01" || date >= DEV_END) continue;
    const cells = line.split("\t");
    const time = serverToUtc(date.replaceAll(".", "-"), cells[1].slice(0, 5));
    if (need.has(time)) need.set(time, { open: +cells[2], spread: +cells[8] });
  }
}
const at = (date, h, m) => need.get(tokyoToUtc(date, h, m))?.open ?? null;
const move = (date, from, to) => { const a = at(date, ...from), b = at(date, ...to); return a === null || b === null ? null : (b - a) / 0.01; };
const WINDOWS = [
  ["7:00 to 9:55", [7, 0], [9, 55]],
  ["8:00 to 9:55", [8, 0], [9, 55]],
  ["9:00 to 9:55", [9, 0], [9, 55]],
  ["9:30 to 9:55", [9, 30], [9, 55]],
  ["9:55 to 10:30", [9, 55], [10, 30]],
  ["9:55 to 11:00", [9, 55], [11, 0]],
  ["9:55 to 12:00", [9, 55], [12, 0]],
  ["9:55 to 15:00", [9, 55], [15, 0]],
];
const groupsA = [
  ["gotobi days", tokyoDays.filter((d) => gotobi.has(d))],
  ["other days", tokyoDays.filter((d) => !gotobi.has(d))],
  ["last day of the month", tokyoDays.filter((d) => monthEnd.has(d))],
  ["gotobi, not month end", tokyoDays.filter((d) => gotobi.has(d) && !monthEnd.has(d))],
];
console.log(`  business days ${tokyoDays.length}, gotobi ${groupsA[0][1].length}, month ends ${groupsA[2][1].length}`);
for (const [label, from, to] of WINDOWS) {
  console.log(`  ${label.padEnd(14)} ${groupsA.map(([name, days]) => `${name}: ${cell(days.map((d) => move(d, from, to)))}`).join(" | ")}`);
}
const spreads = tokyoDays.filter((d) => gotobi.has(d)).map((d) => need.get(tokyoToUtc(d, 9, 0))?.spread).filter((x) => x !== undefined).sort((a, b) => a - b);
console.log(`  spread at 9:00 on gotobi days (points, the minimum inside the minute): median ${spreads[Math.floor(spreads.length / 2)]}, 90% ${spreads[Math.floor(spreads.length * 0.9)]}; a round trip costs about 2 pips with commission and slippage`);
console.log("  gotobi days by year, the two legs:");
for (let y = 2015; y <= 2021; y++) {
  const days = tokyoDays.filter((d) => gotobi.has(d) && d.startsWith(String(y)));
  console.log(`    ${y}: 9:00 to 9:55 ${cell(days.map((d) => move(d, [9, 0], [9, 55])))} | 9:55 to 11:00 ${cell(days.map((d) => move(d, [9, 55], [11, 0])))}`);
}
console.log("  gotobi days by the day of the month, 9:00 to 9:55:");
for (const dom of [5, 10, 15, 20, 25, 30]) {
  // The day itself or the business day it was moved to.
  const days = tokyoDays.filter((d) => gotobi.has(d) && (() => { let x = `${d.slice(0, 8)}${String(dom).padStart(2, "0")}`; if (Number.isNaN(Date.parse(`${x}T00:00:00Z`)) || iso(Date.parse(`${x}T00:00:00Z`)) !== x) return false; while (!businessDay(x)) x = addDays(x, -1); return x === d; })());
  console.log(`    ${String(dom).padStart(2)}th: ${cell(days.map((d) => move(d, [9, 0], [9, 55])))}`);
}

// ============================================================ B. the dollar by the hour
console.log("\nB. The dollar against the basket of seven, by the hour, every weekday of dev. Moves in basis points (0.01%); plus is a stronger dollar.");
const m15 = Object.fromEntries(PAIRS.map((symbol) => [symbol, loadM15(symbol)]));
/** The dollar's move from one instant to another, averaged over the pairs that have both prices; null when under four have. */
function dollar(from, to) {
  const moves = [];
  for (const symbol of PAIRS) {
    const a = m15[symbol].get(from), b = m15[symbol].get(to);
    if (a === undefined || b === undefined) continue;
    const r = Math.log(b.open / a.open) * 1e4;
    moves.push(symbol.startsWith("USD") ? r : -r);
  }
  return moves.length >= 4 ? mean(moves) : null;
}
const londonDays = [];
for (let t = Date.parse("2015-02-02T00:00:00Z"); t < Date.parse(`${config.datasets.testStart}T00:00:00Z`) - DAY; t += DAY) if (weekday(iso(t)) >= 1 && weekday(iso(t)) <= 5) londonDays.push(iso(t));
const hourly = [];
for (let h = 0; h < 24; h++) hourly.push(`${String(h).padStart(2, "0")}h ${f(stat(londonDays.map((d) => dollar(londonToUtc(d, h), londonToUtc(d, h) + HOUR))).m)}(t ${f(stat(londonDays.map((d) => dollar(londonToUtc(d, h), londonToUtc(d, h) + HOUR))).t, 1)})`);
console.log("  by the London hour: " + hourly.join("  "));
const FIX_WINDOWS = [
  ["Tokyo fixing: 8:00 to 10:00 Tokyo", (d) => dollar(tokyoToUtc(d, 8), tokyoToUtc(d, 10))],
  ["after it: 10:00 to 12:00 Tokyo", (d) => dollar(tokyoToUtc(d, 10), tokyoToUtc(d, 12))],
  ["Frankfurt fixing: 11:15 to 13:15 London", (d) => dollar(londonToUtc(d, 11, 15), londonToUtc(d, 13, 15))],
  ["after it: 13:15 to 15:15 London", (d) => dollar(londonToUtc(d, 13, 15), londonToUtc(d, 15, 15))],
  ["London fixing: 14:00 to 16:00 London", (d) => dollar(londonToUtc(d, 14), londonToUtc(d, 16))],
  ["after it: 16:00 to 18:00 London", (d) => dollar(londonToUtc(d, 16), londonToUtc(d, 18))],
];
for (const [label, of] of FIX_WINDOWS) console.log(`  ${label.padEnd(42)} ${cell(londonDays.map(of))}`);
console.log("  a round trip on a major pair costs about 1.5 to 2 basis points.");

// ============================================================ C. month end
console.log("\nC. The last weekday of the month before the London 4 p.m. fixing. Moves of the dollar in basis points.");
const spx = loadIndex("SPXCASH");
const LOCAL = { EURUSD: "EU50", GBPUSD: "UK100", USDJPY: "JP225", AUDUSD: "AUS200" };
const local = Object.fromEntries(Object.entries(LOCAL).map(([symbol, name]) => [symbol, loadIndex(name)]));
/** Return of an index from the last close of the previous month to the last close before `date`. */
function monthToDate(series, date) {
  if (series === null) return null;
  const month = date.slice(0, 7);
  const before = series.filter((r) => r.date < date);
  const last = before.at(-1);
  const base = before.filter((r) => r.date.slice(0, 7) < month).at(-1);
  if (last === undefined || base === undefined || last.date.slice(0, 7) !== month) return null;
  return last.close / base.close - 1;
}
const lastDays = londonDays.filter((d, i) => londonDays[i + 1] === undefined || londonDays[i + 1].slice(0, 7) !== d.slice(0, 7)).slice(0, -1);
const rowsC = lastDays.map((date) => {
  const us = monthToDate(spx, date);
  return {
    date, us,
    pre2: dollar(londonToUtc(date, 14), londonToUtc(date, 16)),
    pre4: dollar(londonToUtc(date, 12), londonToUtc(date, 16)),
    pre7: dollar(londonToUtc(date, 9), londonToUtc(date, 16)),
    post2: dollar(londonToUtc(date, 16), londonToUtc(date, 18)),
    post4: dollar(londonToUtc(date, 16), londonToUtc(date, 20)),
  };
}).filter((r) => r.us !== null);
console.log(`  month ends ${rowsC.length}; US shares were up in ${rowsC.filter((r) => r.us > 0).length} of the months`);
const KEYS = [["9:00 to 16:00", "pre7"], ["12:00 to 16:00", "pre4"], ["14:00 to 16:00", "pre2"], ["16:00 to 18:00", "post2"], ["16:00 to 20:00", "post4"]];
for (const [label, key] of KEYS) {
  const signed = rowsC.map((r) => (r[key] === null ? null : -Math.sign(r.us) * r[key]));
  console.log(`  ${label.padEnd(15)} dollar, plain: ${cell(rowsC.map((r) => r[key]))} | against the month of US shares (plus = as the paper says): ${cell(signed)} | months of 3% and more: ${cell(rowsC.filter((r) => Math.abs(r.us) >= 0.03).map((r) => (r[key] === null ? null : -Math.sign(r.us) * r[key])))}`);
}
console.log("  by pair, 12:00 to 16:00, signed by which share market did better in the month (plus = the currency of the better market weakened, as the paper says):");
for (const [symbol, series] of Object.entries(local)) {
  if (series === null) { console.log(`    ${symbol}: no index file`); continue; }
  const values = lastDays.map((date) => {
    const us = monthToDate(spx, date), other = monthToDate(series, date);
    const a = m15[symbol].get(londonToUtc(date, 12)), b = m15[symbol].get(londonToUtc(date, 16));
    if (us === null || other === null || a === undefined || b === undefined) return null;
    const usd = (symbol.startsWith("USD") ? 1 : -1) * Math.log(b.open / a.open) * 1e4;
    // The US market did better: the dollar should weaken.
    return -Math.sign(us - other) * usd;
  });
  console.log(`    ${symbol}: ${cell(values)}`);
}
console.log("  the same windows on every other weekday, for comparison: " + KEYS.map(([label, key]) => {
  const span = { pre7: [9, 16], pre4: [12, 16], pre2: [14, 16], post2: [16, 18], post4: [16, 20] }[key];
  const others = londonDays.filter((d) => !lastDays.includes(d));
  return `${label} ${f(stat(others.map((d) => dollar(londonToUtc(d, span[0]), londonToUtc(d, span[1])))).m)}`;
}).join(", "));
