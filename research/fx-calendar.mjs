// Calendar patterns on currencies (TZ 17.32): the day of the week, the place of
// the day in the month, and the days of central-bank decisions. Seven dollar
// pairs, M15 bars, dev only: nothing after 2021-12-08 is read.
//
// Prices are taken only at bar opens from 02:00 to 22:00 by the server (wide
// spreads in between). A server day is cut into
//   night    22:00 of the trading day before -> 02:00   (a swap is paid)
//   Asia     02:00 -> 09:00
//   Europe   09:00 -> 15:00
//   America  15:00 -> 22:00
//   day      02:00 -> 22:00
// "The dollar" is the mean move of the seven pairs in the dollar's direction.
//
// A. Day of the week: the mean move of every part of the day on every weekday,
//    and whether a day continues or reverses the day before, by weekday.
// B. Place in the month: the last five and the first five trading days, one
//    day at a time and as holds of three days.
// C. Decisions of the eight central banks (dates and times from the MT5
//    calendar): what the bank's own currency does before, through and after
//    the decision, and whether the first reaction is continued for the next
//    4 hours to 5 days. For the Fed the "own pair" is all seven pairs.
//
// Moves are in basis points of the price before costs; the cost of one trade
// of the project (spread not below the floor, slippage, commission, swaps for
// the nights held) is shown beside them. t by days: one number a day, the sum
// of the day's trades where a cell holds several.
//
// Usage: node research/fx-calendar.mjs            everything
//        node research/fx-calendar.mjs week|month|banks
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const FROM = "2015-02-02", TO = "2021-12-08", MID = "2018-07-01";
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const OPEN = 2 * 60, CLOSE = 22 * 60; // minutes of the server day between which a price may be taken
const MAX_GAP = 5 * 96; // quarter-hours: a price further than five days from the wanted moment is no price
const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri"];
const SEGMENTS = ["night", "Asia", "Europe", "America", "day"];
const USUAL_DAYS = 20;

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
const dayNumber = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400e3;
const weekdayOf = (day) => (day + 4) % 7; // 1970-01-01 was a Thursday; 0 is Sunday
const MONTHS = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.4375);

// ------------------------------------------------------------------ data
/** M15 bars of a pair to the end of dev, with what is needed to price a trade between two bar opens. */
function load(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  const usdBase = own.usdSide === "base";
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const rows = [], squares = new Map();
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after the end of dev is read
    const hh = +p[1].slice(0, 2), mm = +p[1].slice(3, 5), o = +p[2], day = dayNumber(date), minute = hh * 60 + mm;
    rows.push({ date, day, minute, slot: day * 96 + Math.floor(minute / 15), o, half: (Math.max(+p[8], floor) * point) / 2 / o });
    if (minute >= OPEN && minute < CLOSE) squares.set(date, (squares.get(date) ?? 0) + Math.log(+p[5] / o) ** 2);
  }
  // The usual move of a day (02:00-22:00), in basis points: from the quarter-hour moves of the 20 trading days before.
  const dates = [...squares.keys()], usual = new Map();
  for (let d = 0; d < dates.length; d++) {
    const back = dates.slice(Math.max(0, d - USUAL_DAYS), d).map((k) => squares.get(k));
    if (back.length >= USUAL_DAYS / 2) usual.set(dates[d], Math.sqrt(mean(back)) * 1e4);
  }
  const bySlot = new Map(rows.map((b, i) => [b.slot, i]));
  const ok = (b) => b.minute >= OPEN && b.minute <= CLOSE;
  /** First index whose slot is not below the given one. */
  function lower(slot) { let lo = 0, hi = rows.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].slot < slot) lo = mid + 1; else hi = mid; } return lo; }
  return {
    symbol, rows, usual, dollar: usdBase ? 1 : -1,
    swapLong: own.swapLongPips * pip, swapShort: own.swapShortPips * pip,
    fixed: (o) => (2 * config.costs.slippagePips * pip + (usdBase ? commission * o : commission)) / o,
    exact: (slot) => { const i = bySlot.get(slot); return i === undefined ? -1 : i; },
    /** The last allowed price at or before the moment, the first at or after it; -1 when there is none within five days. */
    atOrBefore(slot) { let i = lower(slot + 1) - 1; while (i >= 0 && !ok(rows[i])) i--; return i < 0 || slot - rows[i].slot > MAX_GAP ? -1 : i; },
    atOrAfter(slot) { let i = lower(slot); while (i < rows.length && !ok(rows[i])) i++; return i >= rows.length || rows[i].slot - slot > MAX_GAP ? -1 : i; },
  };
}
const data = new Map(PAIRS.map((s) => [s, load(s)]));

/** Rollovers between two bars: one for the end of every weekday, three for the end of Wednesday. */
function nights(a, b) {
  let n = 0;
  for (let d = a.day; d < b.day; d++) { const wd = weekdayOf(d); if (wd >= 1 && wd <= 5) n += wd === 3 ? 3 : 1; }
  return n;
}
/** The pair's move from the open of bar i to the open of bar j, in basis points. */
const move = (P, i, j) => Math.log(P.rows[j].o / P.rows[i].o) * 1e4;
/** The cost of a long (side +1) or a short (side -1) between the same two opens, in basis points. */
function cost(P, i, j, side) {
  const a = P.rows[i], b = P.rows[j];
  const swap = (-(side > 0 ? P.swapLong : P.swapShort) * nights(a, b)) / a.o;
  return (a.half + b.half + P.fixed(a.o) + swap) * 1e4;
}

// ------------------------------------------------------------------ summaries
/** A cell that is not conditioned on anything: one record { date, v, long, short } a day; the side is the sign of the mean. */
function plain(recs) {
  const m = mean(recs.map((r) => r.v));
  const years = [...new Set(recs.map((r) => r.date.slice(0, 4)))];
  const c = mean(recs.map((r) => (m >= 0 ? r.long : r.short)));
  return {
    n: recs.length, mean: m, t: tOf(recs.map((r) => r.v)), cost: c, left: Math.abs(m) - c,
    first: mean(recs.filter((r) => r.date < MID).map((r) => r.v)), second: mean(recs.filter((r) => r.date >= MID).map((r) => r.v)),
    same: years.filter((y) => Math.sign(mean(recs.filter((r) => r.date.startsWith(y)).map((r) => r.v))) === Math.sign(m)).length, of: years.length,
  };
}
const PLAIN_HEAD = `${pad("", 34)} ${lpad("n", 5)} | ${lpad("move", 7)} ${lpad("t", 5)} | ${lpad("halves", 15)} | ${lpad("years", 5)} | ${lpad("cost", 5)} ${lpad("left", 6)}`;
const plainRow = (label, s) => `${pad(label, 34)} ${lpad(s.n, 5)} | ${lpad(f(s.mean), 7)} ${lpad(f(s.t, 1), 5)} | ${lpad(f(s.first), 7)} ${lpad(f(s.second), 7)} | ${lpad(`${s.same}/${s.of}`, 5)} | ${lpad(s.cost.toFixed(2), 5)} ${lpad(f(s.left), 6)}`;

/** A cell of trades { date, bp, cost, pair }: t by days, the day's number being the sum of its trades. */
function traded(recs) {
  const days = new Map();
  for (const r of recs) days.set(r.date, (days.get(r.date) ?? 0) + r.bp);
  const names = [...new Set(recs.map((r) => r.pair))];
  const part = (keep) => mean(recs.filter((r) => keep(r.date)).map((r) => r.bp));
  const c = mean(recs.map((r) => r.cost));
  return {
    n: recs.length, perMonth: recs.length / MONTHS, mean: mean(recs.map((r) => r.bp)), t: tOf([...days.values()]), cost: c,
    first: part((d) => d < MID), second: part((d) => d >= MID),
    plus: names.filter((p) => mean(recs.filter((r) => r.pair === p).map((r) => r.bp)) > 0).length, of: names.length,
  };
}
const TRADED_HEAD = `${pad("", 46)} ${lpad("n", 5)} ${lpad("a mo", 5)} | ${lpad("move", 7)} ${lpad("t", 5)} | ${lpad("halves", 15)} | ${lpad("pairs+", 6)} | ${lpad("cost", 5)} ${lpad("left", 7)}`;
const tradedRow = (label, s) => `${pad(label, 46)} ${lpad(s.n, 5)} ${lpad(s.perMonth.toFixed(1), 5)} | ${lpad(f(s.mean), 7)} ${lpad(f(s.t, 1), 5)} | ${lpad(f(s.first), 7)} ${lpad(f(s.second), 7)} | ${lpad(`${s.plus}/${s.of}`, 6)} | ${lpad(s.cost.toFixed(2), 5)} ${lpad(f(s.mean - s.cost), 7)}`;

function report(title, head, cells, row, isAbove, top = 16) {
  const list = cells.filter((c) => c.s.n >= 20).sort((a, b) => Math.abs(b.s.t) - Math.abs(a.s.t));
  console.log(`--- ${title}: ${list.length} cells, the ${Math.min(top, list.length)} with the largest |t|`);
  console.log(head);
  for (const c of list.slice(0, top)) console.log(row(c.label, c.s));
  const above = list.filter((c) => isAbove(c.s));
  console.log(`    |t| of 2 and more: ${list.filter((c) => Math.abs(c.s.t) >= 2).length} of ${list.length} (by chance about ${(list.length * 0.0455).toFixed(0)}); of 3 and more: ${list.filter((c) => Math.abs(c.s.t) >= 3).length} (by chance about ${(list.length * 0.0027).toFixed(1)}); the move is larger than the cost in ${above.length}`);
  for (const c of above.sort((a, b) => Math.abs(b.s.t) - Math.abs(a.s.t)).slice(0, 12)) console.log(row(`  > cost: ${c.label}`, c.s));
  console.log("");
  return list;
}

// ------------------------------------------------------------------ the parts of every day
/** For every pair: date -> the bar indexes at 02:00, 09:00, 15:00, 22:00 and at 22:00 of the trading day before. */
const marks = new Map();
for (const [symbol, P] of data) {
  const m = new Map();
  for (let i = 0; i < P.rows.length; i++) {
    const b = P.rows[i];
    if (b.minute !== OPEN && b.minute !== 9 * 60 && b.minute !== 15 * 60 && b.minute !== CLOSE) continue;
    if (!m.has(b.date)) m.set(b.date, { day: b.day });
    m.get(b.date)[b.minute] = i;
  }
  let before;
  for (const [, x] of m) { if (before !== undefined && before[CLOSE] !== undefined && x.day - before.day <= 4) x.prev = before[CLOSE]; before = x; }
  marks.set(symbol, m);
}
const ENDS = { night: ["prev", OPEN], Asia: [OPEN, 9 * 60], Europe: [9 * 60, 15 * 60], America: [15 * 60, CLOSE], day: [OPEN, CLOSE], full: ["prev", CLOSE] };
/** One pair, one date, one part of the day: { v, long, short } or null. */
function part(symbol, date, segment) {
  const x = marks.get(symbol).get(date);
  if (x === undefined) return null;
  const [a, b] = ENDS[segment], i = x[a], j = x[b];
  if (i === undefined || j === undefined) return null;
  const P = data.get(symbol);
  return { v: move(P, i, j), long: cost(P, i, j, 1), short: cost(P, i, j, -1) };
}
/** The dollar against all seven on one date and part of the day; long means long the dollar. */
function dollarPart(date, segment) {
  let v = 0, long = 0, short = 0;
  for (const symbol of PAIRS) {
    const x = part(symbol, date, segment);
    if (x === null) return null;
    const side = data.get(symbol).dollar;
    v += side * x.v; long += side > 0 ? x.long : x.short; short += side > 0 ? x.short : x.long;
  }
  return { v: v / PAIRS.length, long: long / PAIRS.length, short: short / PAIRS.length };
}
const anyPart = (name, date, segment) => (name === "dollar" ? dollarPart(date, segment) : part(name, date, segment));
const NAMES = ["dollar", ...PAIRS];
const DATES = [...marks.get("EURUSD").keys()].filter((d) => d >= FROM);

const mode = process.argv[2] ?? "all";
console.log(`dev ${FROM}..${TO}; moves in basis points of the price before costs; t by days; left = the move minus the cost of one trade`);
console.log("night = 22:00 the day before to 02:00, Asia 02-09, Europe 09-15, America 15-22, day 02-22, by the server; the dollar = the seven pairs in the dollar's direction\n");

// ------------------------------------------------------------------ A. the day of the week
if (mode === "all" || mode === "week") {
  console.log("=== A. The day of the week ===");
  const cells = [];
  for (const name of NAMES) for (let wd = 1; wd <= 5; wd++) for (const segment of SEGMENTS) {
    const recs = [];
    for (const date of DATES) { if (weekdayOf(dayNumber(date)) !== wd) continue; const x = anyPart(name, date, segment); if (x !== null) recs.push({ date, ...x }); }
    cells.push({ label: `${name} ${WEEKDAYS[wd]} ${segment}`, name, wd, segment, vs: recs.map((r) => r.v), s: plain(recs) });
  }
  report("mean move of a part of the day on a weekday", PLAIN_HEAD, cells, plainRow, (s) => s.left > 0, 20);
  // Every part of the day: the five weekdays, all days together, and whether the weekdays differ from one another at all.
  // F compares the spread of the five weekday means with the spread inside a weekday: above 2.4 the weekdays differ
  // (one chance in twenty to see that with no difference), above 3.3 one chance in a hundred.
  let differ = 0;
  for (const segment of SEGMENTS) {
    console.log(`--- ${segment}: move and t by weekday; all days; F for "the weekdays differ"`);
    console.log(`${pad("", 8)} ${[1, 2, 3, 4, 5].map((wd) => lpad(WEEKDAYS[wd], 14)).join("")} ${lpad("all days", 14)} ${lpad("F", 6)}`);
    for (const name of NAMES) {
      const five = [1, 2, 3, 4, 5].map((wd) => cells.find((c) => c.name === name && c.wd === wd && c.segment === segment));
      const all = five.flatMap((c) => c.vs), grand = mean(all);
      const between = five.reduce((a, c) => a + c.vs.length * (mean(c.vs) - grand) ** 2, 0) / 4;
      const within = five.reduce((a, c) => { const m = mean(c.vs); return a + c.vs.reduce((b, v) => b + (v - m) ** 2, 0); }, 0) / (all.length - 5);
      const F = between / within;
      if (F >= 2.38) differ++;
      console.log(`${pad(name, 8)} ${five.map((c) => lpad(`${f(c.s.mean, 1)} (${f(c.s.t, 1)})`, 14)).join("")} ${lpad(`${f(grand, 1)} (${f(tOf(all), 1)})`, 14)} ${lpad(F.toFixed(2), 6)}`);
    }
    console.log("");
  }
  console.log(`    the weekdays differ (F of 2.38 and more) in ${differ} of ${SEGMENTS.length * NAMES.length} rows; by chance about ${(SEGMENTS.length * NAMES.length * 0.05).toFixed(0)}\n`);

  // Does the day (02-22) go the way of the day before? By the weekday of the second day; a trade in the direction of the day before.
  const follow = [];
  for (const group of ["all seven", ...PAIRS]) for (let wd = 1; wd <= 5; wd++) {
    const recs = [];
    for (const symbol of group === "all seven" ? PAIRS : [group]) {
      const P = data.get(symbol), m = marks.get(symbol);
      let before = null;
      for (const date of DATES) {
        const x = m.get(date);
        if (x === undefined || x[OPEN] === undefined || x[CLOSE] === undefined) continue;
        const today = move(P, x[OPEN], x[CLOSE]);
        if (before !== null && before.v !== 0 && x.day - before.day <= 4 && weekdayOf(x.day) === wd) {
          const dir = Math.sign(before.v);
          recs.push({ date, pair: symbol, bp: dir * today, cost: cost(P, x[OPEN], x[CLOSE], dir) });
        }
        before = { v: today, day: x.day };
      }
    }
    follow.push({ label: `${group}: ${WEEKDAYS[wd]} in the direction of the day before`, s: traded(recs) });
  }
  report("a day after a day, by weekday (minus = the day turns back)", TRADED_HEAD, follow, tradedRow, (s) => Math.abs(s.mean) > s.cost, 10);
}

// One weekday of one pair hour by hour, against the other four weekdays, and its European hours year by year.
if (mode === "hours") {
  const name = process.argv[3], wd = +process.argv[4];
  const P = data.get(name);
  const hourly = new Map(); // hour -> { own: [], rest: [] }
  for (let i = 0; i < P.rows.length; i++) {
    const b = P.rows[i];
    if (b.date < FROM || b.minute % 60 !== 0 || b.minute < OPEN || b.minute >= CLOSE) continue;
    const j = P.exact(b.slot + 4);
    if (j < 0) continue;
    const h = b.minute / 60;
    if (!hourly.has(h)) hourly.set(h, { own: [], rest: [] });
    hourly.get(h)[weekdayOf(b.day) === wd ? "own" : "rest"].push(move(P, i, j));
  }
  console.log(`=== ${name}: every hour of ${WEEKDAYS[wd]} against the same hour of the other four weekdays (server hours) ===`);
  console.log(`${pad("hour", 6)} ${lpad(WEEKDAYS[wd], 8)} ${lpad("t", 6)} | ${lpad("others", 8)} ${lpad("t", 6)}`);
  for (const [h, x] of [...hourly].sort((a, b) => a[0] - b[0])) console.log(`${pad(`${String(h).padStart(2, "0")}:00`, 6)} ${lpad(f(mean(x.own)), 8)} ${lpad(f(tOf(x.own), 1), 6)} | ${lpad(f(mean(x.rest)), 8)} ${lpad(f(tOf(x.rest), 1), 6)}`);
  console.log(`\n=== ${name}, Europe 09-15: ${WEEKDAYS[wd]} and the other weekdays, year by year ===`);
  for (let y = 2015; y <= 2021; y++) {
    const own = [], rest = [];
    for (const date of DATES) { if (!date.startsWith(String(y))) continue; const x = part(name, date, "Europe"); if (x !== null) (weekdayOf(dayNumber(date)) === wd ? own : rest).push(x.v); }
    console.log(`${y}  ${WEEKDAYS[wd]} ${lpad(f(mean(own)), 7)} (n ${own.length}, t ${f(tOf(own), 1)})   others ${lpad(f(mean(rest)), 7)} (n ${rest.length}, t ${f(tOf(rest), 1)})`);
  }
}

// ------------------------------------------------------------------ B. the place of the day in the month
if (mode === "all" || mode === "month") {
  console.log("=== B. The place of the day in the month ===");
  const byMonth = new Map();
  for (const date of DATES) { const k = date.slice(0, 7); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(date); }
  const lastWhole = TO.slice(0, 7); // the last month is cut by the end of dev: its last days are not the month's last days
  /** position (+1..+5 from the start, -1..-5 from the end) -> dates */
  const places = new Map();
  for (const [month, dates] of byMonth) for (let k = 1; k <= 5; k++) {
    if (!places.has(k)) { places.set(k, []); places.set(-k, []); }
    if (dates.length >= 15 || month === lastWhole) places.get(k).push(dates[k - 1]);
    if (month !== lastWhole) places.get(-k).push(dates[dates.length - k]);
  }
  const cells = [];
  for (const name of NAMES) for (const k of [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]) for (const segment of ["day", "full"]) {
    const recs = [];
    for (const date of places.get(k)) { const x = anyPart(name, date, segment); if (x !== null) recs.push({ date, ...x }); }
    cells.push({ label: `${name} day ${k > 0 ? "+" : ""}${k} ${segment === "full" ? "with the night" : "02-22"}`, name, k, segment, s: plain(recs) });
  }
  report("mean move of one day by its place in the month (-1 = the last trading day, +1 = the first)", PLAIN_HEAD, cells, plainRow, (s) => s.left > 0, 16);
  console.log("--- day 02-22: move and t by the place in the month");
  console.log(`${pad("", 8)} ${[-5, -4, -3, -2, -1, 1, 2, 3, 4, 5].map((k) => lpad(k > 0 ? `+${k}` : k, 13)).join("")}`);
  for (const name of NAMES) console.log(`${pad(name, 8)} ${[-5, -4, -3, -2, -1, 1, 2, 3, 4, 5].map((k) => { const s = cells.find((c) => c.name === name && c.k === k && c.segment === "day").s; return lpad(`${f(s.mean, 1)} (${f(s.t, 1)})`, 13); }).join("")}`);
  console.log("");

  // Holds of three days: from 02:00 of the first to 22:00 of the last, swaps of two nights paid.
  const holds = [["the last three days", -3, -1], ["the first three days", 1, 3], ["the last day and the first", -1, 1]];
  const held = [];
  for (const name of NAMES) for (const [title, a, b] of holds) {
    const recs = [];
    for (const [month, dates] of byMonth) {
      let first, last;
      if (a < 0 && b < 0) { if (month === lastWhole) continue; first = dates[dates.length + a]; last = dates[dates.length + b]; }
      else if (a > 0) { first = dates[a - 1]; last = dates[b - 1]; }
      else { if (month === lastWhole) continue; first = dates[dates.length - 1]; const next = [...byMonth.keys()]; last = byMonth.get(next[next.indexOf(month) + 1])?.[0]; }
      if (first === undefined || last === undefined) continue;
      let v = 0, long = 0, short = 0, n = 0;
      for (const symbol of name === "dollar" ? PAIRS : [name]) {
        const P = data.get(symbol), m = marks.get(symbol), i = m.get(first)?.[OPEN], j = m.get(last)?.[CLOSE];
        if (i === undefined || j === undefined) { n = -99; break; }
        const side = name === "dollar" ? P.dollar : 1;
        v += side * move(P, i, j); long += cost(P, i, j, side); short += cost(P, i, j, -side); n++;
      }
      if (n > 0) recs.push({ date: first, v: v / n, long: long / n, short: short / n });
    }
    held.push({ label: `${name}: ${title}`, s: plain(recs) });
  }
  report("holds around the turn of the month (one number a month)", PLAIN_HEAD, held, plainRow, (s) => s.left > 0, 10);
}

// ------------------------------------------------------------------ C. decisions of the central banks
if (["all", "banks", "reaction", "fade", "before"].includes(mode)) {
  const grid = mode === "all" || mode === "banks";
  console.log("=== C. Decisions of the central banks ===");
  const BANKS = [
    { name: "Fed", currency: "USD", code: "fed-interest-rate-decision", pairs: PAIRS },
    { name: "ECB", currency: "EUR", code: "ecb-interest-rate-decision", pairs: ["EURUSD"] },
    { name: "Bank of England", currency: "GBP", code: "boe-interest-rate-decision", pairs: ["GBPUSD"] },
    // The Bank of Japan has no fixed minute (the calendar marks it as tentative): the decision is taken to fall between 11:00 and 15:00 Tokyo.
    { name: "Bank of Japan", currency: "JPY", code: "boj-interest-rate-decision", pairs: ["USDJPY"], utcWindow: [2, 6] },
    // For Australia the row of the decision itself carries a time two hours early; the statement published with it has the right one.
    { name: "Reserve Bank of Australia", currency: "AUD", code: "rba-rate-statement", pairs: ["AUDUSD"] },
    { name: "Bank of Canada", currency: "CAD", code: "boc-interest-rate-decision", pairs: ["USDCAD"] },
    { name: "Swiss National Bank", currency: "CHF", code: "snb-interest-rate-decision", pairs: ["USDCHF"] },
    { name: "Reserve Bank of New Zealand", currency: "NZD", code: "rbnz-interest-rate-decision", pairs: ["NZDUSD"] },
  ];
  /** Decisions outside the announced schedule (March 2020): nobody could stand in front of them, so they are left out of every window that starts before the decision. */
  const UNSCHEDULED = new Set(["USD 2020-03-03", "USD 2020-03-15", "GBP 2020-03-11", "GBP 2020-03-19", "CAD 2020-03-13", "CAD 2020-03-27", "AUD 2020-03-19", "NZD 2020-03-15", "NZD 2020-03-16", "JPY 2020-03-16"]);

  // The calendar: UTF-16, tab-separated; the first export has no UTC column and carries one offset for every row.
  const buffer = readFileSync(config.calendar.file);
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = lines[0].split("\t").map((n) => n.replace(/[<>]/g, "").trim());
  const col = (n) => head.indexOf(n);
  const hasUtc = col("UTC") >= 0, shift = (config.calendar.exportOffsetHours ?? 0) * 3600e3;
  const athens = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  /** A moment in UTC as a quarter-hour of the server clock. */
  function serverSlot(utc) {
    const p = Object.fromEntries(athens.formatToParts(new Date(utc)).map((x) => [x.type, +x.value]));
    return dayNumber(`${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`) * 96 + Math.floor((p.hour * 60 + p.minute) / 15);
  }
  const events = [];
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const bank = BANKS.find((b) => b.code === c[col("EVENT_CODE")] && b.currency === c[col("CURRENCY")]);
    if (bank === undefined) continue;
    const [date, clock] = hasUtc ? c[col("UTC")].split(" ") : [c[col("DATE")], c[col("TIME")]];
    const utc = Date.parse(`${date.replaceAll(".", "-")}T${clock.slice(0, 5)}:00Z`) - (hasUtc ? 0 : shift);
    const utcDate = new Date(utc).toISOString().slice(0, 10);
    if (utcDate < FROM || utcDate > TO) continue;
    const from = bank.utcWindow ? Date.parse(`${utcDate}T00:00:00Z`) + bank.utcWindow[0] * 3600e3 : utc;
    const to = bank.utcWindow ? Date.parse(`${utcDate}T00:00:00Z`) + bank.utcWindow[1] * 3600e3 : utc;
    events.push({ bank, utcDate, from: serverSlot(from), to: serverSlot(to), scheduled: !UNSCHEDULED.has(`${bank.currency} ${utcDate}`) });
  }
  // One decision a bank and date (the calendar repeats a few).
  const seen = new Set();
  const decisions = events.filter((e) => { const k = `${e.bank.currency} ${e.utcDate}`; if (seen.has(k)) return false; seen.add(k); return true; });
  console.log("decisions found in the calendar, the server time of the decision, and the move of the own pair from 15 minutes before to 1 hour after against the usual move of a day:");
  for (const bank of BANKS) {
    const list = decisions.filter((e) => e.bank === bank), times = new Map(), ratio = [];
    for (const e of list) {
      const m = (e.from % 96) * 15, label = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      times.set(label, (times.get(label) ?? 0) + 1);
      const P = data.get(bank.pairs[0]), i = P.atOrBefore(e.from - 1), j = P.atOrAfter(e.to + 4);
      if (i >= 0 && j >= 0 && P.usual.has(P.rows[j].date)) ratio.push(Math.abs(move(P, i, j)) / P.usual.get(P.rows[j].date));
    }
    console.log(`  ${pad(bank.name, 28)} ${lpad(list.length, 3)}, not scheduled ${list.filter((e) => !e.scheduled).length}; at ${[...times].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, n]) => `${t} x${n}`).join(", ")}; the reaction is ${mean(ratio).toFixed(2)} of a usual day`);
  }
  console.log("");

  /** Everything about one decision and one pair: the bars before, at the entry after R minutes, and the sign that makes the bank's own currency rise. */
  function frame(e, symbol, R) {
    const P = data.get(symbol);
    const own = symbol.startsWith(e.bank.currency) ? 1 : -1;
    const before = P.atOrBefore(e.from - 1); // a quarter of an hour before the decision, or the last allowed price before that
    const entry = P.atOrAfter(e.to + R / 15);
    return before < 0 || entry < 0 || entry <= before ? null : { P, own, before, entry };
  }

  // C1. Not conditioned: the own currency before, through and after its decision.
  const WINDOWS = [
    { name: "24 h before -> 15 min before", scheduledOnly: true, ends: (x) => [x.P.atOrBefore(x.P.rows[x.before].slot - 96), x.before] },
    { name: "6 h before -> 15 min before", scheduledOnly: true, ends: (x) => [x.P.atOrBefore(x.P.rows[x.before].slot - 24), x.before] },
    { name: "15 min before -> 2 h after", scheduledOnly: true, ends: (x) => [x.before, x.entry] },
    { name: "2 h after -> a day later", scheduledOnly: false, ends: (x) => [x.entry, x.P.atOrAfter(x.P.rows[x.entry].slot + 96)] },
  ];
  const c1 = [];
  for (const w of grid ? WINDOWS : []) {
    const all = [];
    for (const bank of BANKS) {
      const recs = [];
      for (const e of decisions) {
        if (e.bank !== bank || (w.scheduledOnly && !e.scheduled)) continue;
        let v = 0, long = 0, short = 0, n = 0, date;
        for (const symbol of bank.pairs) {
          const x = frame(e, symbol, 120);
          if (x === null) continue;
          const [i, j] = w.ends(x);
          if (i < 0 || j < 0 || j <= i) continue;
          v += x.own * move(x.P, i, j); long += cost(x.P, i, j, x.own); short += cost(x.P, i, j, -x.own); n++; date = x.P.rows[x.before].date;
        }
        if (n === bank.pairs.length) recs.push({ date, v: v / n, long: long / n, short: short / n });
      }
      c1.push({ label: `${bank.currency}: ${w.name}`, s: plain(recs) });
      all.push(...recs);
    }
    // All banks together: two banks on one day make one number, the sum.
    const days = new Map();
    for (const r of all) { const d = days.get(r.date) ?? { date: r.date, v: 0, long: 0, short: 0, n: 0 }; d.v += r.v; d.long += r.long; d.short += r.short; d.n++; days.set(r.date, d); }
    const s = plain([...days.values()].map((d) => ({ date: d.date, v: d.v, long: d.long / d.n, short: d.short / d.n })));
    s.mean = mean(all.map((r) => r.v)); s.n = all.length; s.left = Math.abs(s.mean) - s.cost;
    c1.push({ label: `all eight: ${w.name}`, s });
  }
  if (grid) report("the bank's own currency around its decision (plus = it rises; for the Fed, the dollar against all seven)", PLAIN_HEAD, c1, plainRow, (s) => s.left > 0, 36);

  // C2. The first reaction and what follows it.
  const RS = [60, 120], HS = [240, 1440, 2880, 7200], SIZES = [0, 0.5, 1];
  const GROUPS = [["all eight banks", () => true], ["the Fed, seven pairs", (b) => b.currency === "USD"], ["the other seven banks", (b) => b.currency !== "USD"]];
  const reaction = new Map(); // "R|H" -> records
  /** Every decision and pair: the first reaction over R minutes and the move of the next H minutes in its direction. */
  function reactions(R, H) {
    if (reaction.has(`${R}|${H}`)) return reaction.get(`${R}|${H}`);
    const recs = [];
    for (const e of decisions) for (const symbol of e.bank.pairs) {
      const x = frame(e, symbol, R);
      if (x === null) continue;
      const first = move(x.P, x.before, x.entry), usual = x.P.usual.get(x.P.rows[x.entry].date);
      if (first === 0 || usual === undefined) continue;
      const exit = x.P.atOrAfter(x.P.rows[x.entry].slot + H / 15);
      if (exit < 0 || exit <= x.entry) continue;
      const dir = Math.sign(first);
      recs.push({ date: x.P.rows[x.entry].date, pair: symbol, bank: e.bank, size: Math.abs(first) / usual, bp: dir * move(x.P, x.entry, exit), cost: cost(x.P, x.entry, exit, dir) });
    }
    reaction.set(`${R}|${H}`, recs);
    return recs;
  }
  const hold = (H) => (H < 1440 ? `${H / 60} h` : `${H / 1440} d`);
  for (const [title, keep] of grid ? GROUPS : []) {
    const cells = [];
    for (const R of RS) for (const H of HS) for (const size of SIZES) cells.push({ label: `reaction ${R} min, size ${size}+, then ${hold(H)}`, s: traded(reactions(R, H).filter((r) => keep(r.bank) && r.size >= size)) });
    report(`after the first reaction, in its direction: ${title}`, TRADED_HEAD, cells, tradedRow, (s) => Math.abs(s.mean) > s.cost, 24);
  }
  if (grid) {
    console.log("--- by bank: the reaction of 120 minutes, any size, then a day; and of half a usual day and more, then a day");
    console.log(TRADED_HEAD);
    for (const bank of BANKS) for (const size of [0, 0.5]) console.log(tradedRow(`${bank.name}, size ${size}+`, traded(reactions(120, 1440).filter((r) => r.bank === bank && r.size >= size))));
    console.log("");
  }

  // C3. Does the move before the decision tell the side of the reaction? In at 15 minutes before, out 2 hours after.
  const c3 = [];
  for (const [title, keep] of grid ? GROUPS : []) for (const [name, back] of [["24 h", 96], ["6 h", 24]]) {
    const recs = [];
    for (const e of decisions) {
      if (!e.scheduled || !keep(e.bank)) continue;
      for (const symbol of e.bank.pairs) {
        const x = frame(e, symbol, 120);
        if (x === null) continue;
        const start = x.P.atOrBefore(x.P.rows[x.before].slot - back);
        if (start < 0 || start >= x.before) continue;
        const pre = move(x.P, start, x.before);
        if (pre === 0) continue;
        recs.push({ date: x.P.rows[x.before].date, pair: symbol, bp: Math.sign(pre) * move(x.P, x.before, x.entry), cost: cost(x.P, x.before, x.entry, Math.sign(pre)) });
      }
    }
    c3.push({ label: `${title}: the side of the last ${name}`, s: traded(recs) });
  }
  if (grid) report("through the decision in the direction of the move before it", TRADED_HEAD, c3, tradedRow, (s) => Math.abs(s.mean) > s.cost, 6);

  // The cell "after the first reaction" looked at from every side: neighbours, the size of the reaction, years, banks.
  if (mode === "reaction") {
    const cellText = (recs) => { const s = traded(recs); return lpad(`${f(s.mean, 1)} (${f(s.t, 1)})`, 13); };
    for (const [title, keep] of GROUPS) for (const size of [0, 0.5]) {
      console.log(`--- ${title}, the reaction of ${size} of a usual day and more: move and t; rows = minutes of the reaction, columns = the hold after it`);
      console.log(`${pad("", 8)} ${[120, 240, 480, 1440].map((H) => lpad(hold(H), 13)).join("")}`);
      for (const R of [60, 120, 180, 240]) console.log(`${pad(`${R} min`, 8)} ${[120, 240, 480, 1440].map((H) => cellText(reactions(R, H).filter((r) => keep(r.bank) && r.size >= size))).join("")}`);
      console.log("");
    }
    console.log("--- the reaction of 120 minutes, then 4 hours: by the size of the reaction, by year, by bank");
    console.log(TRADED_HEAD);
    const base = reactions(120, 240);
    for (const [title, keep] of GROUPS) {
      for (const [lo, hi] of [[0, 0.25], [0.25, 0.5], [0.5, 1], [1, 1.5], [1.5, Infinity]]) console.log(tradedRow(`${title}: size ${lo}-${hi === Infinity ? "" : hi}`, traded(base.filter((r) => keep(r.bank) && r.size >= lo && r.size < hi))));
      for (let y = 2015; y <= 2021; y++) console.log(tradedRow(`${title}: ${y}, size 0.5+`, traded(base.filter((r) => keep(r.bank) && r.size >= 0.5 && r.date.startsWith(String(y))))));
      console.log("");
    }
    for (const bank of BANKS) for (const size of [0, 0.5]) console.log(tradedRow(`${bank.name}, size ${size}+`, traded(base.filter((r) => r.bank === bank && r.size >= size))));
    // The Fed alone, one number a decision: the mean of the seven pairs.
    const perDecision = new Map();
    for (const r of base.filter((x) => x.bank.currency === "USD")) { const d = perDecision.get(r.date) ?? []; d.push(r.bp); perDecision.set(r.date, d); }
    const fed = [...perDecision.values()].map(mean);
    console.log(`\nthe Fed, one number a decision (the mean of its pairs): ${fed.length} decisions, ${f(mean(fed))} bp, t ${f(tOf(fed), 1)}, above zero in ${fed.filter((v) => v > 0).length}`);
  }

  // "Through the decision against the move before it" looked at from every side: neighbours, banks, years.
  if (mode === "fade") {
    /** In at 15 minutes before the decision in the direction of the move of the last `back` quarter-hours, out `after` minutes after it. */
    const through = (back, after) => {
      const recs = [];
      for (const e of decisions) {
        if (!e.scheduled) continue;
        for (const symbol of e.bank.pairs) {
          const x = frame(e, symbol, after);
          if (x === null) continue;
          const start = x.P.atOrBefore(x.P.rows[x.before].slot - back);
          if (start < 0 || start >= x.before) continue;
          const pre = move(x.P, start, x.before), usual = x.P.usual.get(x.P.rows[x.before].date);
          if (pre === 0 || usual === undefined) continue;
          recs.push({ date: x.P.rows[x.before].date, pair: symbol, bank: e.bank, size: Math.abs(pre) / usual, bp: Math.sign(pre) * move(x.P, x.before, x.entry), cost: cost(x.P, x.before, x.entry, Math.sign(pre)) });
        }
      }
      return recs;
    };
    const cellText = (recs) => { const s = traded(recs); return lpad(`${f(s.mean, 1)} (${f(s.t, 1)})`, 13); };
    for (const [title, keep] of GROUPS) {
      console.log(`--- ${title}: the move through the decision in the direction of the move before it (minus = it turns back); rows = the hours before, columns = out after`);
      console.log(`${pad("", 8)} ${[60, 120, 240].map((a) => lpad(hold(a), 13)).join("")}`);
      for (const back of [12, 24, 48, 96]) console.log(`${pad(`${back / 4} h`, 8)} ${[60, 120, 240].map((a) => cellText(through(back, a).filter((r) => keep(r.bank)))).join("")}`);
      console.log("");
    }
    const base = through(24, 120);
    console.log("--- the last 6 hours, out 2 hours after: by bank, by year (the other seven banks), by the size of the move before");
    console.log(TRADED_HEAD);
    for (const bank of BANKS) console.log(tradedRow(bank.name, traded(base.filter((r) => r.bank === bank))));
    const others = base.filter((r) => r.bank.currency !== "USD");
    for (let y = 2015; y <= 2021; y++) console.log(tradedRow(`the other seven: ${y}`, traded(others.filter((r) => r.date.startsWith(String(y))))));
    for (const [lo, hi] of [[0, 0.15], [0.15, 0.3], [0.3, 0.5], [0.5, Infinity]]) console.log(tradedRow(`the other seven: move before ${lo}-${hi === Infinity ? "" : hi} of a usual day`, traded(others.filter((r) => r.size >= lo && r.size < hi))));
  }

  // The day before a decision against the same hours of the same weekday one and two weeks later, when the bank decides nothing.
  if (mode === "before") {
    console.log("--- the own currency over the 24 hours that end 15 minutes before the decision, and over the same hours 7 and 14 days later (no decision of that bank within two days)");
    console.log(`${pad("", 30)} ${lpad("n", 4)} ${lpad("decision", 9)} ${lpad("t", 5)} | ${lpad("n", 4)} ${lpad("other", 8)} ${lpad("t", 5)} | ${lpad("difference", 10)} ${lpad("t", 5)} | by year: decision / other weeks`);
    for (const bank of BANKS) {
      const list = decisions.filter((e) => e.bank === bank && e.scheduled);
      const taken = list.map((e) => e.from);
      const own = [], other = [];
      for (const e of list) for (const shiftDays of [0, 7, 14]) {
        const from = e.from + shiftDays * 96;
        if (shiftDays > 0 && taken.some((s) => Math.abs(s - from) <= 2 * 96)) continue;
        let v = 0, n = 0, date;
        for (const symbol of bank.pairs) {
          const P = data.get(symbol), sign = symbol.startsWith(bank.currency) ? 1 : -1;
          const end = P.atOrBefore(from - 1), start = end < 0 ? -1 : P.atOrBefore(P.rows[end].slot - 96);
          if (end < 0 || start < 0 || start >= end || from - 1 - P.rows[end].slot > 8) continue; // the end must be a price of that same morning
          v += sign * move(P, start, end); n++; date = P.rows[end].date;
        }
        if (n === bank.pairs.length) (shiftDays === 0 ? own : other).push({ date, v: v / n });
      }
      const a = own.map((r) => r.v), b = other.map((r) => r.v);
      const sd = (xs) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)) * (xs.length / (xs.length - 1)));
      const tDiff = (mean(a) - mean(b)) / Math.sqrt(sd(a) ** 2 / a.length + sd(b) ** 2 / b.length);
      const years = [];
      for (let y = 2015; y <= 2021; y++) years.push(`${f(mean(own.filter((r) => r.date.startsWith(String(y))).map((r) => r.v)), 0)}/${f(mean(other.filter((r) => r.date.startsWith(String(y))).map((r) => r.v)), 0)}`);
      console.log(`${pad(bank.name, 30)} ${lpad(a.length, 4)} ${lpad(f(mean(a)), 9)} ${lpad(f(tOf(a), 1), 5)} | ${lpad(b.length, 4)} ${lpad(f(mean(b)), 8)} ${lpad(f(tOf(b), 1), 5)} | ${lpad(f(mean(a) - mean(b)), 10)} ${lpad(f(tDiff, 1), 5)} | ${years.join("  ")}`);
    }
  }
}
