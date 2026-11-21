// The first minutes after the opens of Europe, London and New York on
// one-minute bars (TZ 17.30). EURUSD, GBPUSD and USDJPY: the pairs with M1
// files. Dev only: the files are read in pieces and nothing after 2021-12-08
// is parsed.
//
// Six clock times, each in its own local time (the server hour is found per
// date, so the weeks when Europe and the United States are on different
// summer time are handled):
//   07:00 and 08:00 London; 08:00, 08:30, 09:30 and 10:00 New York.
// Three measurements around each, all at the opens of one-minute bars (Bid):
//   A. the plain drift: the mean move of every window from an hour before to
//      four hours after;
//   B. the opening drive: the move of the first 5, 15 or 30 minutes and what
//      the next 15 minutes to 4 hours do in its direction;
//   C. the move of the last 30 or 60 minutes before the time and what the
//      next 15 minutes to 4 hours do in its direction.
// B and C are also shown for the moves larger than usual (1 and 2 times the
// mean size of the same window over the 60 days before). Moves are in basis
// points of the price before costs; the cost of one trade of the project
// (spread not below the floor, slippage on both fills, commission) is shown
// beside them. One number per day; t by days.
//
// Usage: node research/fx-open.mjs            the three measurements
//        node research/fx-open.mjs cell B|C <anchor 0-5> <minutes> <hold> <size 0|1|2>   one cell by pair, year, weekday
import { closeSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY"];
const FROM = "2015-02-02", TO = "2021-12-08", MID = "2018-07-01";
const ANCHORS = [
  { name: "07:00 London", zone: "Europe/London", h: 7, m: 0 },
  { name: "08:00 London", zone: "Europe/London", h: 8, m: 0 },
  { name: "08:00 New York", zone: "America/New_York", h: 8, m: 0 },
  { name: "08:30 New York", zone: "America/New_York", h: 8, m: 30 },
  { name: "09:30 New York", zone: "America/New_York", h: 9, m: 30 },
  { name: "10:00 New York", zone: "America/New_York", h: 10, m: 0 },
];
const EDGES = [-60, -30, -15, 0, 5, 15, 30, 60, 120, 240];
const FIRST = [5, 15, 30], BEFORE = [30, 60], HOLDS = [15, 30, 60, 120, 240], SIZES = [0, 1, 2];
const USUAL = 60; // days in the mean size of a window

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function tOf(xs) {
  if (xs.length < 3) return NaN;
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / (xs.length - 1)));
  return sd === 0 ? NaN : m / (sd / Math.sqrt(xs.length));
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const MONTHS = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.4375);

// ------------------------------------------------------------------ data
/** One-minute bars of a pair up to the end of dev; `idx` gives the bar of a minute of a day, or -1. */
function load(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const file = readdirSync(config.dataDir).find((n) => n.startsWith(`${symbol}_M1_`));
  const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  const cap = 2_800_000, maxDays = 2200;
  const o = new Float64Array(cap), h = new Float64Array(cap), l = new Float64Array(cap), c = new Float64Array(cap), spread = new Float32Array(cap);
  const idx = new Int32Array(maxDays * 1440).fill(-1), days = [];
  let n = 0;
  const fd = openSync(`${config.dataDir}/${file}`, "r"), buf = Buffer.alloc(1 << 24);
  let rest = "", done = false;
  while (!done) {
    const got = readSync(fd, buf, 0, buf.length, null);
    if (got === 0) break;
    const lines = (rest + buf.toString("latin1", 0, got)).split("\n");
    rest = lines.pop();
    for (const line of lines) {
      const p = line.split("\t");
      if (p.length < 9 || p[0].charCodeAt(0) === 60) continue; // the header starts with "<"
      const d = p[0].replaceAll(".", "-");
      if (d > TO) { done = true; break; } // nothing after the end of dev is parsed
      if (days.length === 0 || days[days.length - 1] !== d) days.push(d);
      idx[(days.length - 1) * 1440 + (+p[1].slice(0, 2)) * 60 + +p[1].slice(3, 5)] = n;
      o[n] = +p[2]; h[n] = +p[3]; l[n] = +p[4]; c[n] = +p[5]; spread[n] = Math.max(+p[8], floor) * point;
      n++;
    }
  }
  closeSync(fd);
  /** The first bar at that minute of the day or within the two minutes after it; -1 if there is none. */
  const at = (day, minute) => {
    if (minute < 0 || minute + 2 >= 1440) return -1;
    for (let k = 0; k <= 2; k++) { const i = idx[day * 1440 + minute + k]; if (i >= 0) return i; }
    return -1;
  };
  /** The cost of a trade in at bar i and out at bar j, in basis points of the price. */
  const cost = (i, j) => (((spread[i] + spread[j]) / 2 + 2 * config.costs.slippagePips * pip + (own.usdSide === "base" ? commission * o[i] : commission)) / o[i]) * 1e4;
  return { symbol, pip, n, o, h, l, c, days, at, cost };
}

/** How many hours the server clock is ahead of a zone on a date (taken at noon UTC: the clocks change at night). */
const hourFormat = new Map();
function hourIn(zone, ms) {
  if (!hourFormat.has(zone)) hourFormat.set(zone, new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }));
  return +hourFormat.get(zone).format(ms);
}
const aheadCache = new Map();
function ahead(date, zone) {
  const key = date + zone;
  if (!aheadCache.has(key)) { const ms = Date.parse(`${date}T12:00:00Z`); aheadCache.set(key, (hourIn(config.brokerTimeZone, ms) - hourIn(zone, ms) + 24) % 24); }
  return aheadCache.get(key);
}
const serverMinute = (date, a) => (a.h + ahead(date, a.zone)) * 60 + a.m;

const markets = PAIRS.map(load);
const dates = [...new Set(markets.flatMap((m) => m.days))].filter((d) => d >= FROM).sort();
const dayOf = markets.map((m) => new Map(m.days.map((d, i) => [d, i])));
/** ln of the price at the anchor plus `minutes`, or NaN; and the bar itself. */
function bar(mi, date, a, minutes) {
  const day = dayOf[mi].get(date);
  return day === undefined ? -1 : markets[mi].at(day, serverMinute(date, a) + minutes);
}
function move(mi, date, a, from, to) {
  const i = bar(mi, date, a, from), j = bar(mi, date, a, to);
  if (i < 0 || j < 0) return null;
  return { bp: Math.log(markets[mi].o[j] / markets[mi].o[i]) * 1e4, i, j };
}

// ------------------------------------------------------------------ signals of B and C, day by day
/**
 * kind "B": the signal is the move from the time to `minutes` after it, the outcome runs from there for `hold` minutes.
 * kind "C": the signal is the move of the `minutes` before the time, the outcome runs from the time for `hold` minutes.
 * Returns one record per pair and day: the outcome in the direction of the signal, the size of the signal against its usual size, the cost.
 */
function signals(kind, ai, minutes, hold) {
  const a = ANCHORS[ai], out = [];
  const [s0, s1] = kind === "B" ? [0, minutes] : [-minutes, 0];
  markets.forEach((m, mi) => {
    const past = []; // sizes of the same window on the days before
    for (const date of m.days) {
      const sig = move(mi, date, a, s0, s1);
      if (sig === null) continue;
      const usual = past.length >= USUAL ? mean(past.slice(-USUAL)) : NaN;
      past.push(Math.abs(sig.bp));
      if (date < FROM || !Number.isFinite(usual) || usual === 0 || sig.bp === 0) continue;
      const res = move(mi, date, a, s1, s1 + hold);
      if (res === null) continue;
      out.push({ pair: m.symbol, date, dir: Math.sign(sig.bp), size: Math.abs(sig.bp) / usual, signal: Math.abs(sig.bp), bp: Math.sign(sig.bp) * res.bp, cost: m.cost(res.i, res.j) });
    }
  });
  return out;
}
/** One number per day: the mean over the pairs that had a signal that day. */
function byDay(recs) {
  const days = new Map();
  for (const r of recs) { if (!days.has(r.date)) days.set(r.date, []); days.get(r.date).push(r.bp); }
  return [...days.entries()].map(([date, xs]) => ({ date, bp: mean(xs) }));
}
function summary(recs) {
  const days = byDay(recs);
  const half = (keep) => mean(days.filter((d) => keep(d.date)).map((d) => d.bp));
  return {
    n: recs.length, perMonth: recs.length / MONTHS, mean: mean(recs.map((r) => r.bp)), t: tOf(days.map((d) => d.bp)),
    first: half((d) => d < MID), second: half((d) => d >= MID), cost: mean(recs.map((r) => r.cost)), signal: mean(recs.map((r) => r.signal)),
    pairs: PAIRS.map((p) => mean(recs.filter((r) => r.pair === p).map((r) => r.bp))),
  };
}
const HEAD = `${pad("", 46)} ${lpad("n", 6)} ${lpad("a mo", 6)} ${lpad("signal", 6)} | ${lpad("move", 6)} ${lpad("t", 5)} | ${lpad("halves", 13)} | ${lpad("EUR", 6)} ${lpad("GBP", 6)} ${lpad("JPY", 6)} | ${lpad("cost", 5)} ${lpad("left", 6)}`;
function row(label, s) {
  return `${pad(label, 46)} ${lpad(s.n, 6)} ${lpad(s.perMonth.toFixed(1), 6)} ${lpad(s.signal.toFixed(1), 6)} | ${lpad(f(s.mean), 6)} ${lpad(f(s.t, 1), 5)} | ${lpad(f(s.first), 6)} ${lpad(f(s.second), 6)} | ${s.pairs.map((x) => lpad(f(x), 6)).join(" ")} | ${lpad(s.cost.toFixed(2), 5)} ${lpad(f(Math.abs(s.mean) - s.cost), 6)}`;
}

const [mode = "scan", kindArg, aArg, mArg, hArg, zArg] = process.argv.slice(2);
console.log(`dev ${FROM}..${TO}: ${dates.length} days; moves in basis points of the price, before costs; t by days`);
console.log("signal: the mean size of the move that gives the direction; move: what follows in that direction (minus = the other way); left: |move| minus the cost of one trade\n");

if (mode === "scan") {
  // ---------------------------------------------------------------- A. the plain drift
  console.log("=== A. the mean move of every window around the time (mean, and t by days in brackets); a star at |t| of 3 and more ===");
  for (const [ai, a] of ANCHORS.entries()) {
    console.log(`--- ${a.name}`);
    console.log(`${pad("", 8)} ${EDGES.slice(0, -1).map((e, k) => lpad(`${e}..${EDGES[k + 1]}`, 15)).join("")}`);
    markets.forEach((m, mi) => {
      const cells = EDGES.slice(0, -1).map((e, k) => {
        const xs = [];
        for (const date of dates) { const r = move(mi, date, a, e, EDGES[k + 1]); if (r !== null) xs.push(r.bp); }
        const t = tOf(xs);
        return lpad(`${f(mean(xs))} (${f(t, 1)})${Math.abs(t) >= 3 ? "*" : " "}`, 15);
      });
      console.log(`${pad(m.symbol, 8)} ${cells.join("")}`);
    });
  }
  // ---------------------------------------------------------------- B and C
  for (const [kind, list, title] of [["B", FIRST, "B. the first minutes after the time and what follows in their direction"], ["C", BEFORE, "C. the minutes before the time and what follows in their direction"]]) {
    const cells = [];
    for (const [ai, a] of ANCHORS.entries()) for (const minutes of list) for (const hold of HOLDS) {
      const recs = signals(kind, ai, minutes, hold);
      for (const size of SIZES) {
        const part = recs.filter((r) => r.size >= size);
        if (part.length < 30) continue;
        cells.push({ label: `${a.name}  ${kind === "B" ? "first" : "last"} ${minutes}  then ${hold}  size ${size}+`, s: summary(part) });
      }
    }
    cells.sort((x, y) => Math.abs(y.s.t) - Math.abs(x.s.t));
    console.log(`\n=== ${title}: ${cells.length} cells, the 25 with the largest |t| ===`);
    console.log(HEAD);
    for (const c of cells.slice(0, 25)) console.log(row(c.label, c.s));
    const above = cells.filter((c) => Math.abs(c.s.mean) > c.s.cost);
    console.log(`cells where the move is larger than the cost of a trade: ${above.length} of ${cells.length}; with |t| of 2 and more: ${cells.filter((c) => Math.abs(c.s.t) >= 2).length}; of 3 and more: ${cells.filter((c) => Math.abs(c.s.t) >= 3).length}`);
    for (const c of above.sort((x, y) => Math.abs(y.s.t) - Math.abs(x.s.t)).slice(0, 15)) console.log(row(`  > cost: ${c.label}`.slice(0, 46), c.s));
  }
} else {
  const ai = +aArg, minutes = +mArg, hold = +hArg, size = +zArg;
  const recs = signals(kindArg, ai, minutes, hold).filter((r) => r.size >= size);
  console.log(`=== ${kindArg}: ${ANCHORS[ai].name}, ${kindArg === "B" ? "first" : "last"} ${minutes} minutes, then ${hold}, size ${size}+ ===`);
  console.log(HEAD);
  console.log(row("all", summary(recs)));
  for (let y = 2015; y <= 2021; y++) console.log(row(String(y), summary(recs.filter((r) => r.date.startsWith(String(y))))));
  for (const [wd, name] of [[1, "Monday"], [2, "Tuesday"], [3, "Wednesday"], [4, "Thursday"], [5, "Friday"]]) console.log(row(name, summary(recs.filter((r) => new Date(`${r.date}T00:00:00Z`).getUTCDay() === wd))));
  console.log(row("signal up", summary(recs.filter((r) => r.dir > 0))));
  console.log(row("signal down", summary(recs.filter((r) => r.dir < 0))));
  for (const [lo, hi] of [[0, 0.5], [0.5, 1], [1, 1.5], [1.5, 2], [2, 3], [3, Infinity]]) console.log(row(`size ${lo} to ${hi}`, summary(signals(kindArg, ai, minutes, hold).filter((r) => r.size >= lo && r.size < hi))));
}
