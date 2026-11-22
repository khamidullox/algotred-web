// Tick volume on currencies (TZ 17.34): does the number of price changes in a
// bar say anything about where the pair goes next? Seven dollar pairs, M15
// bars, dev only: nothing after 2021-12-08 is read.
//
// The tick count of the files changes its level from year to year (the feed,
// not the market), so a volume is always "relative": divided by the mean
// volume of the same stretch of the day over the 20 trading days before.
// A move is made relative the same way: divided by its usual size.
//
// Prices are taken only at bar opens from 02:00 to 22:00 by the server.
//
// 0. describe  what the tick count is: its level by year, how closely it
//              follows the size of the bar, how persistent it is.
// A. days      a day's direction, its relative volume and its relative size ->
//              the next day and the next five days in that direction.
// B. hours     an hour's direction, relative volume and relative size ->
//              the next hour, four hours, the rest of the day.
// C. climax    a quarter-hour with 3 and more usual volumes -> what follows,
//              split by whether it came after a run the same way.
// D. vwap      the price against the day's volume-weighted average price, and
//              against the plain time average as a control -> the rest of the
//              day; the same for yesterday's averages at 02:00.
// E. sessions  a session's direction, relative volume and size -> the next
//              session.
// F. profile   yesterday's price of the largest volume as a level the price
//              comes back to, against yesterday's plain average price.
// G. heavy     a closer look at the days of very large volume (done after
//              the grid was read, so its cells are counted too).
//
// Every textbook claim about volume has its control without volume beside it:
// the same cell by the size of the move alone. Moves are in basis points of
// the price before costs; the cost of the project (spread not below the floor,
// slippage, commission, swaps) is shown beside them. t by days (by weeks for
// the daily part): one number a period, the sum of the period's trades.
//
// Usage: node research/fx-volume.mjs [describe|days|hours|climax|vwap|sessions|profile|heavy]
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const FROM = "2015-02-02", TO = "2021-12-08", MID = "2018-07-01";
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const OPEN = 2 * 60, CLOSE = 22 * 60, Q = (CLOSE - OPEN) / 15; // 80 quarter-hours between the first and the last price of a day
const HOURS = Q / 4;
const BACK = 20, MIN_BACK = 10; // trading days behind every "usual" figure
const MIN_BARS = 72; // a day with fewer quarter-hours is a holiday
const SESSIONS = [["Asia", 0, 28], ["Europe", 28, 52], ["America", 52, 80]];

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function tOf(xs) {
  if (xs.length < 3) return NaN;
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / (xs.length - 1)));
  return sd === 0 ? NaN : m / (sd / Math.sqrt(xs.length));
}
function corr(xs, ys) {
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const dayNumber = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400e3;
const weekdayOf = (day) => (day + 4) % 7; // 1970-01-01 was a Thursday; 0 is Sunday
const weekOf = (date) => Math.floor((dayNumber(date) + 3) / 7); // Monday to Sunday
const clock = (k) => { const m = OPEN + k * 15; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
const MONTHS = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.4375);
/** The name of the band [from, to) a value falls into, or null. */
const band = (bands, x) => { for (const [a, b, name] of bands) if (x >= a && x < b) return name; return null; };

// ------------------------------------------------------------------ data
/** Trading days of a pair to the end of dev: 81 opens from 02:00 to 22:00, and the 80 bars between them. */
function load(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  const usdBase = own.usdSide === "base";
  const swapLong = own.swapLongPips * pip, swapShort = own.swapShortPips * pip;
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const all = [];
  let cur = null;
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after the end of dev is read
    const minute = +p[1].slice(0, 2) * 60 + +p[1].slice(3, 5);
    if (minute < OPEN || minute > CLOSE || minute % 15 !== 0) continue;
    const k = (minute - OPEN) / 15, o = +p[2];
    if (cur === null || cur.date !== date) {
      cur = {
        date, day: dayNumber(date), bars: 0,
        o: new Float64Array(Q + 1).fill(NaN), half: new Float64Array(Q + 1).fill(NaN),
        h: new Float64Array(Q).fill(NaN), l: new Float64Array(Q).fill(NaN), c: new Float64Array(Q).fill(NaN), v: new Float64Array(Q),
      };
      all.push(cur);
    }
    cur.o[k] = o;
    cur.half[k] = (Math.max(+p[8], floor) * point) / 2 / o;
    if (k < Q) { cur.h[k] = +p[3]; cur.l[k] = +p[4]; cur.c[k] = +p[5]; cur.v[k] = +p[6]; cur.bars++; }
  }
  const days = all.filter((d) => Number.isFinite(d.o[0]) && Number.isFinite(d.o[Q]) && d.bars >= MIN_BARS && weekdayOf(d.day) >= 1 && weekdayOf(d.day) <= 5);

  // What a day is by itself: volume, squared quarter-hour moves, range; the same for its hours and sessions.
  const span = (d, a, b) => {
    let vol = 0, hi = -Infinity, lo = Infinity;
    for (let k = a; k < b; k++) { vol += d.v[k]; if (d.h[k] > hi) hi = d.h[k]; if (d.l[k] < lo) lo = d.l[k]; }
    return { vol, move: Math.log(d.o[b] / d.o[a]) * 1e4, range: hi > 0 && lo < Infinity ? Math.log(hi / lo) * 1e4 : NaN };
  };
  for (const d of days) {
    let sq = 0;
    for (let k = 0; k < Q; k++) if (Number.isFinite(d.c[k])) sq += Math.log(d.c[k] / d.o[k]) ** 2;
    Object.assign(d, span(d, 0, Q), { sq });
    d.hour = Array.from({ length: HOURS }, (_, h) => span(d, 4 * h, 4 * h + 4));
    d.session = SESSIONS.map(([, a, b]) => span(d, a, b));
  }
  // What is usual for it: the same figures over the 20 trading days before.
  const back = (i, get) => {
    const xs = [];
    for (let j = Math.max(0, i - BACK); j < i; j++) { const x = get(days[j]); if (Number.isFinite(x)) xs.push(x); }
    return xs.length >= MIN_BACK ? xs : null;
  };
  const ratio = (x, xs) => (xs === null ? NaN : x / mean(xs)); // against the usual level
  const rms = (xs) => (xs === null ? NaN : Math.sqrt(mean(xs.map((x) => x * x)))); // the usual size of a move
  const relative = (i, x, get) => {
    x.relVol = ratio(x.vol, back(i, (d) => get(d).vol));
    x.relRange = ratio(x.range, back(i, (d) => get(d).range));
    x.usual = rms(back(i, (d) => get(d).move));
  };
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    d.relVol = ratio(d.vol, back(i, (x) => x.vol));
    d.relRange = ratio(d.range, back(i, (x) => x.range));
    const sq = back(i, (x) => x.sq);
    d.usual = sq === null ? NaN : Math.sqrt(mean(sq)) * 1e4; // the usual move of a day, from quarter-hour moves
    for (let h = 0; h < HOURS; h++) relative(i, d.hour[h], (x) => x.hour[h]);
    for (let s = 0; s < SESSIONS.length; s++) relative(i, d.session[s], (x) => x.session[s]);
    d.qRelVol = new Float64Array(Q);
    for (let k = 0; k < Q; k++) d.qRelVol[k] = ratio(d.v[k], back(i, (x) => x.v[k]));
  }
  const fixed = (o) => (2 * config.costs.slippagePips * pip + (usdBase ? commission * o : commission)) / o;
  /** The cost of a long (side +1) or a short (side -1) between two opens, in basis points. */
  function cost(a, ka, b, kb, side) {
    let nights = 0;
    for (let x = a.day; x < b.day; x++) { const wd = weekdayOf(x); if (wd >= 1 && wd <= 5) nights += wd === 3 ? 3 : 1; }
    const swap = (-(side > 0 ? swapLong : swapShort) * nights) / a.o[ka];
    return (a.half[ka] + b.half[kb] + fixed(a.o[ka]) + swap) * 1e4;
  }
  return { symbol, days, cost };
}
const data = new Map(PAIRS.map((s) => [s, load(s)]));

/** A trade from open ka of day i to open kb of day j in the given direction, or null when a price is missing. */
function trade(P, i, ka, j, kb, side) {
  const a = P.days[i], b = P.days[j];
  if (a === undefined || b === undefined || a.date < FROM || side === 0) return null;
  const x = a.o[ka], y = b.o[kb];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { date: a.date, pair: P.symbol, bp: side * Math.log(y / x) * 1e4, cost: P.cost(a, ka, b, kb, side) };
}

// ------------------------------------------------------------------ summaries
/** A cell of trades { date, pair, bp, cost }: t by periods, the period's number being the sum of its trades. */
function summary(recs, period) {
  const sums = new Map();
  for (const r of recs) { const key = period(r.date); sums.set(key, (sums.get(key) ?? 0) + r.bp); }
  const names = [...new Set(recs.map((r) => r.pair))];
  const years = [...new Set(recs.map((r) => r.date.slice(0, 4)))];
  const m = mean(recs.map((r) => r.bp));
  const part = (keep) => mean(recs.filter((r) => keep(r)).map((r) => r.bp));
  return {
    n: recs.length, perMonth: recs.length / MONTHS, mean: m, t: tOf([...sums.values()]), cost: mean(recs.map((r) => r.cost)),
    first: part((r) => r.date < MID), second: part((r) => r.date >= MID),
    years: years.filter((y) => Math.sign(part((r) => r.date.startsWith(y))) === Math.sign(m)).length, ofYears: years.length,
    pairs: names.filter((p) => Math.sign(part((r) => r.pair === p)) === Math.sign(m)).length, ofPairs: names.length,
  };
}
const HEAD = `${pad("", 58)} ${lpad("n", 6)} ${lpad("a mo", 6)} | ${lpad("move", 7)} ${lpad("t", 5)} | ${lpad("halves", 15)} | ${lpad("years", 5)} ${lpad("pairs", 5)} | ${lpad("cost", 5)} ${lpad("left", 7)}`;
const row = (label, s) => `${pad(label, 58)} ${lpad(s.n, 6)} ${lpad(s.perMonth.toFixed(1), 6)} | ${lpad(f(s.mean), 7)} ${lpad(f(s.t, 1), 5)} | ${lpad(f(s.first), 7)} ${lpad(f(s.second), 7)} | ${lpad(`${s.years}/${s.ofYears}`, 5)} ${lpad(`${s.pairs}/${s.ofPairs}`, 5)} | ${lpad(s.cost.toFixed(2), 5)} ${lpad(f(Math.abs(s.mean) - s.cost), 7)}`;

let counted = 0;
/** Prints every cell of a part in the order it was filled, then the count of the notable ones. */
function report(title, cells, period, note) {
  const list = [...cells].filter(([, recs]) => recs.length >= 30).map(([label, recs]) => ({ label, s: summary(recs, period) }));
  counted += list.length;
  console.log(`--- ${title}: ${list.length} cells. ${note}`);
  console.log(HEAD);
  for (const c of list) console.log(row(c.label, c.s));
  const two = list.filter((c) => Math.abs(c.s.t) >= 2), three = list.filter((c) => Math.abs(c.s.t) >= 3);
  const paid = list.filter((c) => Math.abs(c.s.mean) > c.s.cost);
  console.log(`    |t| of 2 and more: ${two.length} of ${list.length} (by chance about ${(list.length * 0.0455).toFixed(0)}); of 3 and more: ${three.length} (by chance about ${(list.length * 0.0027).toFixed(1)}); the move is larger than the cost in ${paid.length}`);
  for (const c of paid.sort((a, b) => Math.abs(b.s.t) - Math.abs(a.s.t)).slice(0, 10)) console.log(row(`  > cost: ${c.label}`, c.s));
  console.log("");
}
const cellsOf = () => {
  const cells = new Map();
  return { cells, put(label, rec) { if (rec === null) return; let c = cells.get(label); if (c === undefined) cells.set(label, (c = [])); c.push(rec); } };
};
const byDay = (date) => date, byWeek = (date) => weekOf(date);

// ------------------------------------------------------------------ 0. what the tick count is
function describe() {
  console.log("--- 0. The tick count of the files (dev, 02:00-22:00)");
  const years = ["2015", "2016", "2017", "2018", "2019", "2020", "2021"];
  console.log(`${pad("mean ticks in a quarter-hour", 30)} ${years.map((y) => lpad(y, 6)).join(" ")}`);
  for (const P of data.values()) {
    console.log(`${pad(P.symbol, 30)} ${years.map((y) => lpad(mean(P.days.filter((d) => d.date.startsWith(y)).map((d) => d.vol / Q)).toFixed(0), 6)).join(" ")}`);
  }
  console.log("");
  console.log(`${pad("how closely volume follows size (correlation of logs)", 56)} ${lpad("days", 6)} ${lpad("hours", 6)} | ${lpad("day to next day", 16)} ${lpad("range to next", 14)}`);
  for (const P of data.values()) {
    const dv = [], dr = [], hv = [], hr = [], v0 = [], v1 = [], r0 = [], r1 = [];
    P.days.forEach((d, i) => {
      if (d.relVol > 0 && d.relRange > 0) { dv.push(Math.log(d.relVol)); dr.push(Math.log(d.relRange)); }
      for (const h of d.hour) if (h.relVol > 0 && h.relRange > 0) { hv.push(Math.log(h.relVol)); hr.push(Math.log(h.relRange)); }
      const next = P.days[i + 1];
      if (next !== undefined && d.relVol > 0 && next.relVol > 0 && d.relRange > 0 && next.relRange > 0) {
        v0.push(Math.log(d.relVol)); v1.push(Math.log(next.relVol)); r0.push(Math.log(d.relRange)); r1.push(Math.log(next.relRange));
      }
    });
    console.log(`${pad(P.symbol, 56)} ${lpad(corr(dv, dr).toFixed(2), 6)} ${lpad(corr(hv, hr).toFixed(2), 6)} | ${lpad(corr(v0, v1).toFixed(2), 16)} ${lpad(corr(r0, r1).toFixed(2), 14)}`);
  }
  console.log("");
}

// ------------------------------------------------------------------ A. days
const DAY_VOL = [[0, 0.75, "vol <0.75"], [0.75, 1, "vol 0.75-1"], [1, 1.33, "vol 1-1.33"], [1.33, 1.75, "vol 1.33-1.75"], [1.75, Infinity, "vol 1.75+"]];
const DAY_SIZE = [[0, 0.5, "size <0.5"], [0.5, 1, "size 0.5-1"], [1, 1.5, "size 1-1.5"], [1.5, Infinity, "size 1.5+"]];
const DAY_OWN = [[0, 0.85, "own vol <0.85"], [0.85, 1.15, "own vol 0.85-1.15"], [1.15, 1.4, "own vol 1.15-1.4"], [1.4, Infinity, "own vol 1.4+"]];
/** The median relative volume of the pairs on every date that at least five of them have. */
function medianVolume() {
  const by = new Map(), out = new Map();
  for (const P of data.values()) for (const d of P.days) if (Number.isFinite(d.relVol)) { let xs = by.get(d.date); if (xs === undefined) by.set(d.date, (xs = [])); xs.push(d.relVol); }
  for (const [date, xs] of by) {
    if (xs.length < 5) continue;
    xs.sort((a, b) => a - b);
    out.set(date, xs.length % 2 === 1 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2);
  }
  return out;
}
function days() {
  const one = cellsOf(), both = cellsOf(), own = cellsOf(), median = medianVolume();
  for (const P of data.values()) for (let i = 0; i < P.days.length; i++) {
    const d = P.days[i];
    if (!Number.isFinite(d.relVol) || !Number.isFinite(d.usual) || d.move === 0) continue;
    const side = Math.sign(d.move), vol = band(DAY_VOL, d.relVol), size = band(DAY_SIZE, Math.abs(d.move) / d.usual);
    for (const [hold, j] of [["next day", i + 1], ["next 5 days", i + 5]]) {
      const r = trade(P, i + 1, 0, j, Q, side);
      one.put(`${hold} | ${vol}`, r);
      one.put(`${hold} | ${size}`, r);
      both.put(`${hold} | ${size} | ${vol}`, r);
      const m = median.get(d.date);
      if (m !== undefined) own.put(`${hold} | ${band(DAY_OWN, d.relVol / m)}`, r);
    }
  }
  const sorted = (m) => new Map([...m].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })));
  report("A1. After a day, in its direction: by its volume alone and by its size alone", sorted(one.cells), byWeek, "02:00 of the next day to 22:00 of that day or of the fifth day; t by weeks");
  report("A2. The same, size and volume together", sorted(both.cells), byWeek, "t by weeks");
  report("A3. The same, by the pair's volume against the median volume of the seven pairs that day", sorted(own.cells), byWeek, "t by weeks");
}

// ------------------------------------------------------------------ B. hours
const HOUR_SIZE = [[0, 0.5, "size <0.5"], [0.5, 1.5, "size 0.5-1.5"], [1.5, 2.5, "size 1.5-2.5"], [2.5, Infinity, "size 2.5+"]];
const HOUR_VOL = [[0, 0.8, "vol <0.8"], [0.8, 1.25, "vol 0.8-1.25"], [1.25, 2, "vol 1.25-2"], [2, Infinity, "vol 2+"]];
function hours() {
  const { cells, put } = cellsOf();
  for (const hold of ["1 h", "4 h", "to 22:00"]) for (const [, , size] of HOUR_SIZE) for (const [, , vol] of HOUR_VOL) cells.set(`${hold} | ${size} | ${vol}`, []);
  for (const P of data.values()) for (let i = 0; i < P.days.length; i++) {
    const d = P.days[i];
    for (let h = 0; h < HOURS - 1; h++) {
      const x = d.hour[h];
      if (!Number.isFinite(x.move) || x.move === 0 || !Number.isFinite(x.usual) || !Number.isFinite(x.relVol)) continue;
      const side = Math.sign(x.move), size = band(HOUR_SIZE, Math.abs(x.move) / x.usual), vol = band(HOUR_VOL, x.relVol), k = 4 * h + 4;
      if (k + 4 <= Q) put(`1 h | ${size} | ${vol}`, trade(P, i, k, i, k + 4, side));
      if (k + 16 <= Q) put(`4 h | ${size} | ${vol}`, trade(P, i, k, i, k + 16, side));
      if (k <= Q - 8) put(`to 22:00 | ${size} | ${vol}`, trade(P, i, k, i, Q, side));
    }
  }
  report("B. After an hour, in its direction: by its size and its volume", cells, byDay, "entry at the open of the next hour; t by days");
}

// ------------------------------------------------------------------ C. climax
const CLIMAX = [[3, 5, "vol 3-5"], [5, Infinity, "vol 5+"]];
function climax() {
  const { cells, put } = cellsOf();
  for (const hold of ["1 h", "4 h", "to 22:00"]) for (const [, , vol] of CLIMAX) for (const kind of ["all", "after a run the same way", "against the run before"]) cells.set(`${hold} | ${vol} | ${kind}`, []);
  for (const P of data.values()) for (let i = 0; i < P.days.length; i++) {
    const d = P.days[i];
    for (let k = 0; k < Q - 4; k++) {
      const vol = band(CLIMAX, d.qRelVol[k]);
      if (vol === null) continue;
      const side = Math.sign(Math.log(d.o[k + 1] / d.o[k]));
      if (!Number.isFinite(side) || side === 0) continue;
      const run = k >= 16 ? Math.sign(Math.log(d.o[k] / d.o[k - 16])) : NaN; // the four hours before the bar
      const kinds = ["all"];
      if (Number.isFinite(run) && run !== 0) kinds.push(run === side ? "after a run the same way" : "against the run before");
      for (const kind of kinds) {
        put(`1 h | ${vol} | ${kind}`, trade(P, i, k + 1, i, k + 5, side));
        if (k + 17 <= Q) put(`4 h | ${vol} | ${kind}`, trade(P, i, k + 1, i, k + 17, side));
        if (k + 1 <= Q - 8) put(`to 22:00 | ${vol} | ${kind}`, trade(P, i, k + 1, i, Q, side));
      }
    }
  }
  report("C. After a quarter-hour with 3 and more usual volumes, in its direction", cells, byDay, "entry at the open of the next quarter-hour; t by days");
}

// ------------------------------------------------------------------ D. the volume-weighted average price
const AWAY = [[0.25, 0.5, "away 0.25-0.5"], [0.5, 1, "away 0.5-1"], [1, Infinity, "away 1+"]];
const APART = [[0.03, 0.06, "apart 0.03-0.06"], [0.06, Infinity, "apart 0.06+"]];
/** The volume-weighted and the plain average of the typical prices of the bars [0, to) of a day. */
function averages(d, to) {
  let pv = 0, v = 0, p = 0, n = 0;
  for (let k = 0; k < to; k++) {
    if (!Number.isFinite(d.c[k])) continue;
    const typical = (d.h[k] + d.l[k] + d.c[k]) / 3;
    pv += typical * d.v[k]; v += d.v[k]; p += typical; n++;
  }
  return { vwap: v > 0 ? pv / v : NaN, twap: n > 0 ? p / n : NaN };
}
function vwap() {
  const { cells, put } = cellsOf();
  for (const P of data.values()) for (let i = 1; i < P.days.length; i++) {
    const d = P.days[i];
    if (!Number.isFinite(d.usual)) continue;
    const measure = (price, level) => (Math.log(price / level) * 1e4) / d.usual; // in usual days
    for (const T of [28, 40, 52, 64]) {
      const a = averages(d, T), price = d.o[T];
      if (!Number.isFinite(price) || !Number.isFinite(a.vwap)) continue;
      for (const [name, level] of [["VWAP", a.vwap], ["time average", a.twap]]) {
        const x = measure(price, level), away = band(AWAY, Math.abs(x));
        if (away !== null) put(`${clock(T)} back to the ${name} | ${away}`, trade(P, i, T, i, Q, -Math.sign(x)));
      }
      const gap = measure(a.vwap, a.twap), apart = band(APART, Math.abs(gap));
      if (apart !== null) put(`${clock(T)} towards the VWAP from the time average | ${apart}`, trade(P, i, T, i, Q, Math.sign(gap)));
    }
    const y = averages(P.days[i - 1], Q);
    if (!Number.isFinite(y.vwap) || !Number.isFinite(d.o[0])) continue;
    for (const [name, level] of [["VWAP", y.vwap], ["time average", y.twap]]) {
      const x = measure(d.o[0], level), away = band(AWAY, Math.abs(x));
      if (away !== null) put(`02:00 back to yesterday's ${name} | ${away}`, trade(P, i, 0, i, Q, -Math.sign(x)));
    }
  }
  const sorted = new Map([...cells].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })));
  report("D. The price against the day's volume-weighted average price (VWAP), to 22:00", sorted, byDay, "distance in usual days; t by days");
}

// ------------------------------------------------------------------ E. sessions
const SESSION_VOL = [[0, 0.85, "vol <0.85"], [0.85, 1.2, "vol 0.85-1.2"], [1.2, Infinity, "vol 1.2+"]];
function sessions() {
  const { cells, put } = cellsOf();
  const NEXT = [
    [0, "Asia -> Europe", 0, 28, 52], [0, "Asia -> rest of the day", 0, 28, 80], [1, "Europe -> America", 0, 52, 80],
    [2, "America -> next Asia", 1, 0, 28], [2, "America -> next day", 1, 0, 80],
  ];
  for (const [, name] of NEXT) for (const size of ["small", "big"]) for (const [, , vol] of SESSION_VOL) cells.set(`${name} | ${size} | ${vol}`, []);
  for (const P of data.values()) for (let i = 0; i < P.days.length; i++) {
    const d = P.days[i];
    for (const [s, name, shift, ka, kb] of NEXT) {
      const x = d.session[s];
      if (!Number.isFinite(x.move) || x.move === 0 || !Number.isFinite(x.usual) || !Number.isFinite(x.relVol)) continue;
      const size = Math.abs(x.move) / x.usual >= 1 ? "big" : "small";
      put(`${name} | ${size} | ${band(SESSION_VOL, x.relVol)}`, trade(P, i + shift, ka, i + shift, kb, Math.sign(x.move)));
    }
  }
  report("E. After a session, in its direction: by its size (big is 1 usual and more) and its volume", cells, byDay, "t by days");
}

// ------------------------------------------------------------------ F. yesterday's price of the largest volume
const BIN = 0.05; // the width of a price step of the profile, in usual days
/** The middle of the price step that took the most volume of the day: a bar's volume is spread evenly from its low to its high. */
function largestVolumePrice(d) {
  const step = (d.usual / 1e4) * BIN, at = (price) => Math.floor(Math.log(price) / step);
  const steps = new Map();
  for (let k = 0; k < Q; k++) {
    if (!Number.isFinite(d.c[k]) || d.v[k] === 0) continue;
    const a = at(d.l[k]), b = at(d.h[k]), share = d.v[k] / (b - a + 1);
    for (let x = a; x <= b; x++) steps.set(x, (steps.get(x) ?? 0) + share);
  }
  let best = NaN, most = 0;
  for (const [x, v] of steps) if (v > most) { most = v; best = x; }
  return Number.isFinite(best) ? Math.exp((best + 0.5) * step) : NaN;
}
/** From 02:00 towards a level: out at the level when a bar reaches it, otherwise at 22:00. */
function towards(P, i, level) {
  const d = P.days[i], entry = d.o[0], side = Math.sign(level - entry);
  if (d.date < FROM || side === 0) return null;
  for (let k = 0; k < Q; k++) {
    if (!Number.isFinite(d.c[k])) continue;
    if (side > 0 ? d.h[k] >= level : d.l[k] <= level) {
      return { date: d.date, pair: P.symbol, bp: side * Math.log(level / entry) * 1e4, cost: P.cost(d, 0, d, k, side), reached: true };
    }
  }
  return { date: d.date, pair: P.symbol, bp: side * Math.log(d.o[Q] / entry) * 1e4, cost: P.cost(d, 0, d, Q, side), reached: false };
}
function profile() {
  const { cells, put } = cellsOf();
  for (const P of data.values()) for (let i = 1; i < P.days.length; i++) {
    const d = P.days[i], y = P.days[i - 1];
    if (!Number.isFinite(d.usual) || !Number.isFinite(y.usual)) continue;
    const levels = [["yesterday's price of the largest volume", largestVolumePrice(y)], ["yesterday's time average", averages(y, Q).twap]];
    for (const [name, level] of levels) {
      if (!Number.isFinite(level)) continue;
      const away = band(AWAY, Math.abs(Math.log(d.o[0] / level) * 1e4) / d.usual);
      if (away !== null) put(`02:00 towards ${name} | ${away}`, towards(P, i, level));
    }
  }
  const sorted = new Map([...cells].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })));
  report("F. From 02:00 towards yesterday's price of the largest volume, out at the level or at 22:00", sorted, byDay, "distance in usual days; t by days");
  for (const [label, recs] of sorted) console.log(`    ${pad(label, 62)} the level is reached in ${((100 * recs.filter((r) => r.reached).length) / recs.length).toFixed(0)}% of the days`);
  console.log("");
}

// ------------------------------------------------------------------ G. the days of very large volume
function heavy() {
  const { cells, put } = cellsOf();
  const all = [];
  for (const P of data.values()) for (let i = 0; i < P.days.length; i++) {
    const d = P.days[i];
    if (!Number.isFinite(d.relVol) || !Number.isFinite(d.usual) || d.move === 0) continue;
    const side = Math.sign(d.move), one = trade(P, i + 1, 0, i + 1, Q, side), five = trade(P, i + 1, 0, i + 5, Q, side);
    for (const from of [1.5, 1.75, 2, 2.5]) {
      if (d.relVol < from) continue;
      put(`next day | vol ${from} and more`, one);
      put(`next 5 days | vol ${from} and more`, five);
      if (d.date.slice(0, 7) !== "2020-03") { put(`next day | vol ${from} and more, without March 2020`, one); put(`next 5 days | vol ${from} and more, without March 2020`, five); }
    }
    if (d.relVol >= 1.75 && five !== null) all.push({ ...five, signal: d.date });
  }
  const sorted = new Map([...cells].sort((a, b) => a[0].localeCompare(b[0], "en", { numeric: true })));
  report("G. After a day of very large volume, in its direction", sorted, byWeek, "t by weeks");
  // Where the five-day result of "1.75 and more" comes from.
  const total = all.reduce((a, r) => a + r.bp, 0);
  const weeks = new Map(), dates = new Set(all.map((r) => r.signal));
  for (const r of all) { const key = weekOf(r.date); const w = weeks.get(key) ?? { sum: 0, n: 0, first: r.signal }; w.sum += r.bp; w.n++; weeks.set(key, w); }
  const top = [...weeks.values()].sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum)).slice(0, 6);
  console.log(`    "vol 1.75 and more", next 5 days: ${all.length} trades on ${dates.size} dates in ${weeks.size} weeks; the sum of all trades is ${f(total, 0)} bp`);
  for (const w of top) console.log(`      the week of the signal of ${w.first}: ${w.n} trades, ${f(w.sum, 0)} bp (${((100 * w.sum) / total).toFixed(0)}% of the sum)`);
  const years = [...new Set(all.map((r) => r.date.slice(0, 4)))].sort();
  console.log(`      by year: ${years.map((y) => { const xs = all.filter((r) => r.date.startsWith(y)); return `${y} ${f(mean(xs.map((r) => r.bp)), 1)} (${xs.length})`; }).join("; ")}`);
  console.log("");
}

const parts = { describe, days, hours, climax, vwap, sessions, profile, heavy };
const wanted = process.argv[2];
if (wanted !== undefined && parts[wanted] === undefined) { console.error("Usage: node research/fx-volume.mjs [describe|days|hours|climax|vwap|sessions|profile|heavy]"); process.exit(1); }
console.log(`Tick volume, dev ${FROM}..${TO}, ${PAIRS.length} dollar pairs. Moves in basis points before costs.`);
console.log("");
for (const [name, run] of Object.entries(parts)) if (wanted === undefined || wanted === name) run();
if (counted > 0) console.log(`Cells counted in this run: ${counted}`);
