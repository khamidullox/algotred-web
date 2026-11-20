// What happens on the days after an unusually large daily move of a dollar
// pair: TZ 17.23, the lead the scan (fx-scan.mjs) gave. Dev only.
// A measurement, not a strategy: the mean move after the signal by hour, by
// size of the signal, by year and by pair, with dates as the unit of counting
// (seven dollar pairs move together, so one day is one observation).
//
// Usage: node research/fx-shock.mjs
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const FROM = "2015-02-02", TO = "2021-12-08";

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function stat(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return { n: xs.length, m, sd, t: m / (sd / Math.sqrt(Math.max(1, xs.length))) };
}
/** Mean over all rows and a t-value counted over dates: rows of one date are averaged first. */
function byDate(rows, value) {
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.date)) groups.set(r.date, []); groups.get(r.date).push(value(r)); }
  const st = stat([...groups.values()].map(mean));
  return { n: rows.length, dates: groups.size, m: mean(rows.map(value)), t: st.t };
}
const f = (x, d = 1) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function spec(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits;
  return {
    symbol, point, pip: point * 10, base: own.usdSide === "base", contract: own.contractSize,
    minSpread: own.minSpreadPoints ?? config.costs.minSpreadPoints,
    slip: config.costs.slippagePips * point * 10,
    commission: own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip,
    swapLong: own.swapLongPips * point * 10, swapShort: own.swapShortPips * point * 10,
  };
}
function costOf(s, bar) {
  const commission = s.base ? (s.commission / s.contract) * bar.o : s.commission / s.contract;
  return Math.max(bar.spread, s.minSpread) * s.point + 2 * s.slip + commission;
}
function load(symbol, tf) {
  const lines = readFileSync(`${config.dataDir}/${symbol}_${tf}.csv`, "utf8").split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 8) continue;
    const date = p[0].replaceAll(".", "-");
    if (tf === "D1") rows.push({ date, o: +p[1], h: +p[2], l: +p[3], c: +p[4], spread: +p[7] });
    else rows.push({ date, hour: +p[1].slice(0, 2), o: +p[2], h: +p[3], l: +p[4], c: +p[5], spread: +p[8] });
  }
  return rows;
}

// Events: one row for a pair and a day whose close-to-close move is `z` sigmas (sigma of the 20 days before).
const events = [];
const spreadByHour = new Map();
for (const symbol of PAIRS) {
  const s = spec(symbol);
  const daily = load(symbol, "D1").filter((b) => b.date <= TO);
  const h1 = load(symbol, "H1").filter((b) => b.date <= TO);
  const hours = new Map();
  for (const b of h1) { if (!hours.has(b.date)) hours.set(b.date, new Map()); hours.get(b.date).set(b.hour, b); }
  for (const b of h1) if (b.date >= FROM) { const k = `${symbol}|${b.hour}`; if (!spreadByHour.has(k)) spreadByHour.set(k, []); spreadByHour.get(k).push(b.spread); }
  const ret = daily.map((b, i) => (i === 0 ? 0 : Math.log(b.c / daily[i - 1].c)));
  const tr = daily.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - daily[i - 1].c), Math.abs(b.l - daily[i - 1].c))));
  for (let i = 25; i + 4 < daily.length; i++) {
    const day = daily[i];
    if (day.date < FROM) continue;
    const sigma = Math.sqrt(mean(ret.slice(i - 20, i).map((x) => x * x)));
    const z = ret[i] / sigma;
    const atr = mean(tr.slice(i - 20, i));
    const next = [1, 2, 3].map((k) => hours.get(daily[i + k].date));
    if (next.some((m) => m === undefined)) continue;
    // Hourly path after the signal: the open of each hour of the next three days.
    const path = [];
    for (let k = 0; k < 3; k++) for (let hh = 0; hh < 24; hh++) path.push(next[k].get(hh)?.o ?? NaN);
    const lastClose = next[2].get(23)?.c ?? NaN;
    events.push({ symbol, s, date: day.date, year: day.date.slice(0, 4), z, dir: Math.sign(z), close: day.c, atr, path, lastClose, next, range: (day.h - day.l) / atr, body: Math.abs(day.c - day.o) / atr });
  }
}

console.log("== 0. Mean spread column by server hour, points (is the daily open expensive?) ==");
for (const symbol of PAIRS) {
  const line = [0, 1, 2, 3, 9, 16, 22, 23].map((hh) => `${String(hh).padStart(2, "0")}h ${mean(spreadByHour.get(`${symbol}|${hh}`)).toFixed(1)}`).join("  ");
  console.log(`   ${pad(symbol, 7)} ${line}   floor ${spec(symbol).minSpread}`);
}

/** Move from the open of hour `a` to the open of hour `b` of the path (hours counted from the first hour after the signal day), in the direction of the signal, basis points. */
const leg = (e, a, b) => e.dir * Math.log((b >= 72 ? e.lastClose : e.path[b]) / e.path[a]) * 1e4;
/** Costs of a trade from hour a to hour b in basis points: one round trip and the swaps of the nights passed. */
function costs(e, a, b) {
  const bar = e.next[Math.floor(a / 24)].get(a % 24);
  let c = costOf(e.s, bar);
  const nights = Math.floor((b - 0.5) / 24) - Math.floor(a / 24);
  const swap = e.dir > 0 ? e.s.swapLong : e.s.swapShort;
  c += -swap * nights * 1.4; // 1.4: the triple night once a week on average
  return (c / bar.o) * 1e4;
}

console.log("\n== 1. By size of the day: move of the following hours in the direction of the day, basis points (dates as the unit) ==");
console.log("   in = open of 02:00 server on the next day (19:00 New York), out: 23:00 same day (no night) | 23:00 a day later | 23:00 two days later");
const bands = [[0.5, 1], [1, 1.5], [1.5, 2], [2, 2.5], [2.5, 3.5], [3.5, 99], [1.5, 99], [2, 99]];
console.log("   |z| band     rows  dates a month | day 1: move  t  cost | 2 days: move  t  cost | 3 days: move  t  cost | close -> 02:00");
for (const [lo, hi] of bands) {
  const rows = events.filter((e) => Math.abs(e.z) >= lo && Math.abs(e.z) < hi && [2, 23, 47, 71].every((h) => Number.isFinite(e.path[h])));
  const parts = [23, 47, 71].map((out) => { const r = byDate(rows, (e) => leg(e, 2, out)); return `${lpad(f(r.m), 6)} ${lpad(f(r.t), 5)} ${mean(rows.map((e) => costs(e, 2, out))).toFixed(1)}`; });
  const pre = byDate(rows, (e) => e.dir * Math.log(e.path[2] / e.close) * 1e4);
  const one = byDate(rows, (e) => 0);
  console.log(`   ${pad(`${lo}-${hi === 99 ? "" : hi}`, 9)} ${lpad(rows.length, 6)} ${lpad(one.dates, 6)} ${lpad((rows.length / 82).toFixed(1), 6)} | ${parts.join(" | ")} | ${f(pre.m)} (t ${f(pre.t)})`);
}

const big = events.filter((e) => Math.abs(e.z) >= 2 && [2, 23, 47, 71].every((h) => Number.isFinite(e.path[h])));
console.log(`\n== 2. Days of two sigmas and more (${big.length} rows): where in the next three days the move comes, basis points summed from 00:00 of the next day ==`);
{
  const marks = [1, 2, 4, 6, 9, 12, 15, 17, 19, 21, 23, 26, 33, 39, 47, 57, 63, 71, 72];
  console.log("   hour  " + marks.map((h) => lpad(h, 6)).join(""));
  console.log("   move  " + marks.map((h) => lpad(f(byDate(big.filter((e) => Number.isFinite(e.path[0]) && (h >= 72 || Number.isFinite(e.path[h]))), (e) => leg(e, 0, h)).m), 6)).join(""));
  console.log("   t     " + marks.map((h) => lpad(f(byDate(big.filter((e) => Number.isFinite(e.path[0]) && (h >= 72 || Number.isFinite(e.path[h]))), (e) => leg(e, 0, h)).t), 6)).join(""));
}

console.log("\n== 3. The same days by year, by pair, by side (in 02:00, out 23:00 a day later; basis points, costs with one night) ==");
const show = (label, rows) => { const r = byDate(rows, (e) => leg(e, 2, 47)); const d1 = byDate(rows, (e) => leg(e, 2, 23)); console.log(`   ${pad(label, 14)} rows ${lpad(rows.length, 4)} dates ${lpad(r.dates, 4)} | 2 days ${lpad(f(r.m), 6)} (t ${f(r.t)}) cost ${mean(rows.map((e) => costs(e, 2, 47))).toFixed(1)} | day 1 only ${lpad(f(d1.m), 6)} (t ${f(d1.t)}) cost ${mean(rows.map((e) => costs(e, 2, 23))).toFixed(1)}`); };
for (const year of [...new Set(big.map((e) => e.year))].sort()) show(year, big.filter((e) => e.year === year));
for (const symbol of PAIRS) show(symbol, big.filter((e) => e.symbol === symbol));
show("pair went up", big.filter((e) => e.dir > 0));
show("pair went down", big.filter((e) => e.dir < 0));
const usdUp = (e) => (e.s.base ? e.dir > 0 : e.dir < 0);
show("dollar up", big.filter(usdUp));
show("dollar down", big.filter((e) => !usdUp(e)));
// How many pairs moved that day: a dollar-wide day or the move of one currency.
const perDate = new Map();
for (const e of big) perDate.set(e.date, (perDate.get(e.date) ?? 0) + 1);
show("1 pair that day", big.filter((e) => perDate.get(e.date) === 1));
show("2-3 pairs", big.filter((e) => perDate.get(e.date) >= 2 && perDate.get(e.date) <= 3));
show("4+ pairs", big.filter((e) => perDate.get(e.date) >= 4));
// The shape of the day: did it close near its extreme?
show("range >= 1.5 ATR", big.filter((e) => e.range >= 1.5));
show("range < 1.5 ATR", big.filter((e) => e.range < 1.5));
