// Gold, what was not counted on it before (TZ 17.43). XAUUSD, M15, dev only:
// nothing after 2021-12-08 is read. Results are in basis points of the price
// (hundredths of a percent) or, for the trend systems, in shares of the risk.
//
// A. The parts of the day around the two London fixings (10:30 and 15:00 in
//    London, 12:30 and 17:00 by the server all year round). The published
//    pattern: gold falls between the morning and the afternoon fixing and rises
//    from the afternoon fixing to the next morning's. Two rules: sold at 12:30
//    and bought back at 17:00; bought at 17:00 and sold at 12:30 of the next
//    trading day. The control: every other window of the same four and a half
//    hours inside a day, started every half hour.
// B. The trend by the published Turtle rules (as in TZ 17.27 for currencies):
//    System 1 enters on a break of the 20-day high or low and leaves on the
//    10-day low or high, System 2 is 55 and 20 days; the stop 2 N from the
//    entry. Plain and as published (adds every half N, the skip rule of
//    System 1). The control: a random day, a random side, the same stop and exit.
// C. Against a stretched move, as on currencies (TZ 17.24): when the move of
//    the last k days is at least 1.5 usual moves of k days, trade against it at
//    the next open and hold five trading days. The control: the same hold from
//    every day, which is the drift of gold itself.
// D. The day of the week: the move of each server day.
//
// Costs: the spread of the bar (not under the floor of the config), slippage on
// both fills, the commission; the swap of the config for every night held,
// three times after Wednesday, in proportion to the price.
//
// Usage: node research/gold.mjs
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
// "check" prints the two fixing rules day by day on the four weeks before dev begins and stops: the mechanics only.
const checkMode = process.argv[2] === "check";
const SYMBOL = "XAUUSD", FROM = checkMode ? "2015-01-05" : "2015-02-02", TO = checkMode ? "2015-02-01" : "2021-12-08", SPLIT = "2018-07-01";
const SEEDS = 40;
const own = config.symbols[SYMBOL], point = 10 ** -own.digits, pip = point * 10;
const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints, slip = config.costs.slippagePips * pip;
const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
// One night as a share of the price: the config gives the swap at a reference price and it scales with the price.
const SWAP = { long: (own.swapLongPips * pip) / own.swapReferencePrice, short: (own.swapShortPips * pip) / own.swapReferencePrice };

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / 86400e3;
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
function nightsBetween(a, b) {
  let n = 0;
  for (let d = dayNumber(a); d < dayNumber(b); d++) { const wd = (d + 4) % 7; if (wd >= 1 && wd <= 5) n += wd === 3 ? 3 : 1; }
  return n;
}
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** t of a list of dated values: the values of one week are summed first. */
function tByWeeks(items) {
  const byWeek = new Map();
  for (const [date, v] of items) { const wk = Math.floor((dayNumber(date) + 3) / 7); byWeek.set(wk, (byWeek.get(wk) ?? 0) + v); }
  const w = [...byWeek.values()];
  return mean(w) / (sd(w) / Math.sqrt(w.length));
}

// ------------------------------------------------------------------ data
const bars = [];
{
  const lines = readFileSync(`${config.dataDir}/${SYMBOL}_M15.csv`, "utf8").split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after dev is read
    bars.push({ date, time: p[1].slice(0, 5), o: +p[2], h: +p[3], l: +p[4], c: +p[5], spread: +p[8] });
  }
}
const at = new Map(bars.map((b, i) => [`${b.date} ${b.time}`, i]));
const allDates = [...new Set(bars.map((b) => b.date))];
/** One round trip opened on bar i, as a share of the price. */
const roundTrip = (i) => (Math.max(bars[i].spread, floor) * point + 2 * slip + commission) / bars[i].o;
const hhmm = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// ------------------------------------------------------------------ A. windows of the day
/** Every day's move from the open of the bar at `start` to the open of the bar at `end` (the next trading day when `overnight`), in the direction `dir`. */
function windowTrades(start, end, dir, overnight = false) {
  const out = [];
  allDates.forEach((date, k) => {
    if (date < FROM) return;
    const a = at.get(`${date} ${start}`);
    if (a === undefined) return;
    let b, exitDate = date;
    if (!overnight) b = at.get(`${date} ${end}`); else for (let n = k + 1; n < allDates.length && n <= k + 4 && b === undefined; n++) { b = at.get(`${allDates[n]} ${end}`); exitDate = allDates[n]; }
    if (b === undefined) return;
    const gross = dir * Math.log(bars[b].o / bars[a].o), nights = nightsBetween(date, exitDate);
    out.push({ date, gross, cost: roundTrip(a), swap: (dir > 0 ? SWAP.long : SWAP.short) * nights });
  });
  return out;
}
function stats(trades, value) {
  const xs = trades.map(value), years = new Map();
  for (const t of trades) years.set(t.date.slice(0, 4), (years.get(t.date.slice(0, 4)) ?? 0) + value(t));
  return { n: xs.length, bp: mean(xs) * 1e4, t: tByWeeks(trades.map((t) => [t.date, value(t)])), yearsUp: `${[...years.values()].filter((v) => v > 0).length}/${years.size}`, a: mean(trades.filter((t) => t.date < SPLIT).map(value)) * 1e4, b: mean(trades.filter((t) => t.date >= SPLIT).map(value)) * 1e4 };
}
const months = (dayNumber(TO) - dayNumber(FROM)) / 30.44;
console.log(`Gold, dev ${FROM} .. ${TO}: ${bars.length} bars of M15, ${allDates.filter((d) => d >= FROM).length} days. bp = hundredths of a percent of the price; t counts weeks.`);
console.log(`One round trip costs ${(mean(bars.map((b, i) => (b.date >= FROM ? roundTrip(i) : NaN)).filter(Number.isFinite)) * 1e4).toFixed(1)} bp on average; a night costs ${(-SWAP.long * 1e4).toFixed(1)} bp long and ${(-SWAP.short * 1e4).toFixed(1)} bp short.`);
if (checkMode) {
  for (const [label, start, end, dir, overnight] of [["sold 12:30, bought back 17:00", "12:30", "17:00", -1, false], ["bought 17:00, sold 12:30 of the next day", "17:00", "12:30", 1, true]]) {
    console.log(`\n${label}:`);
    for (const t of windowTrades(start, end, dir, overnight).slice(0, 7)) console.log(`  ${t.date}: in ${bars[at.get(`${t.date} ${start}`)].o.toFixed(2)}, before costs ${f(t.gross * 1e4, 1)} bp, cost ${(t.cost * 1e4).toFixed(2)} bp, swap ${f(t.swap * 1e4, 2)} bp`);
  }
  process.exit(0);
}

console.log(`\n=== A. Around the London fixings ===`);
console.log(`${pad("", 46)} ${lpad("days", 5)} ${lpad("tr/mo", 5)} | ${lpad("before", 7)} ${lpad("t", 5)} ${lpad("years", 5)} | ${lpad("cost", 5)} ${lpad("swap", 5)} | ${lpad("after", 7)} ${lpad("t", 5)} ${lpad("a year", 7)} | ${lpad("halves, after", 15)} | ${lpad("no swaps", 8)} ${lpad("t", 5)}`);
const cells = [];
function lineA(label, trades) {
  const g = stats(trades, (t) => t.gross), c = mean(trades.map((t) => t.cost)) * 1e4, s = mean(trades.map((t) => t.swap)) * 1e4;
  const n = stats(trades, (t) => t.gross - t.cost + t.swap), z = stats(trades, (t) => t.gross - t.cost);
  cells.push({ label, before: g.bp, beforeT: g.t, after: n.bp, afterT: n.t, flat: z.bp, flatT: z.t });
  console.log(`${pad(label, 46)} ${lpad(g.n, 5)} ${lpad((g.n / months).toFixed(0), 5)} | ${lpad(f(g.bp), 7)} ${lpad(f(g.t, 1), 5)} ${lpad(g.yearsUp, 5)} | ${lpad(f(-c, 1), 5)} ${lpad(f(s, 1), 5)} | ${lpad(f(n.bp), 7)} ${lpad(f(n.t, 1), 5)} ${lpad(f(n.bp * 2.52, 1) + "%", 7)} | ${lpad(f(n.a), 7)} ${lpad(f(n.b), 7)} | ${lpad(f(z.bp), 8)} ${lpad(f(z.t, 1), 5)}`);
}
lineA("sold 12:30, bought back 17:00 (between fixings)", windowTrades("12:30", "17:00", -1));
lineA("bought 17:00, sold 12:30 of the next day", windowTrades("17:00", "12:30", 1, true));
// The control: the same four and a half hours from every other half hour of the day, sold.
const scan = [];
for (let start = 60; start + 270 <= 23 * 60; start += 30) {
  const tr = windowTrades(hhmm(start), hhmm(start + 270), -1), g = stats(tr, (t) => t.gross);
  scan.push({ start: hhmm(start), bp: g.bp, t: g.t, n: g.n });
}
const fix = scan.find((x) => x.start === "12:30"), ranked = scan.slice().sort((a, b) => b.bp - a.bp);
console.log(`\nThe control, a window of 4.5 hours sold from every half hour (before costs, bp and t):`);
for (let i = 0; i < scan.length; i += 6) console.log("  " + scan.slice(i, i + 6).map((x) => `${x.start} ${lpad(f(x.bp), 6)} (${lpad(f(x.t, 1), 4)})`).join("   "));
console.log(`The window between the fixings is number ${ranked.indexOf(fix) + 1} of ${scan.length} by the size of the fall; windows with |t| >= 2: ${scan.filter((x) => Math.abs(x.t) >= 2).length}.`);
console.log(`The parts of the day, bought (before costs): ${[["01:00", "09:00"], ["09:00", "12:30"], ["12:30", "17:00"], ["17:00", "23:00"]].map(([a, b]) => { const g = stats(windowTrades(a, b, 1), (t) => t.gross); return `${a}-${b} ${f(g.bp)} bp (t ${f(g.t, 1)})`; }).join("; ")}; 23:00 to 01:00 of the next day ${(() => { const g = stats(windowTrades("23:00", "01:00", 1, true), (t) => t.gross); return `${f(g.bp)} bp (t ${f(g.t, 1)})`; })()}.`);

// ------------------------------------------------------------------ B. the Turtle rules (the simulator of TZ 17.27)
function dailyOf() {
  const days = [];
  bars.forEach((b, i) => {
    const t = days[days.length - 1];
    if (t === undefined || t.date !== b.date) days.push({ date: b.date, first: i, last: i, h: b.h, l: b.l, c: b.c, o: b.o }); else { t.h = Math.max(t.h, b.h); t.l = Math.min(t.l, b.l); t.c = b.c; t.last = i; }
  });
  const N = new Array(days.length).fill(NaN);
  let sum = 0;
  for (let d = 1; d < days.length; d++) {
    const tr = Math.max(days[d].h - days[d].l, Math.abs(days[d].h - days[d - 1].c), Math.abs(days[d].l - days[d - 1].c));
    if (d <= 20) { sum += tr; if (d === 20) N[d] = sum / 20; } else N[d] = (19 * N[d - 1] + tr) / 20;
  }
  const ext = {};
  for (const n of [10, 20, 55]) {
    const hi = new Array(days.length).fill(NaN), lo = new Array(days.length).fill(NaN);
    for (let d = n; d < days.length; d++) { let a = -Infinity, b = Infinity; for (let j = d - n; j < d; j++) { if (days[j].h > a) a = days[j].h; if (days[j].l < b) b = days[j].l; } hi[d] = a; lo[d] = b; }
    ext[n] = { hi, lo };
  }
  const nights = new Array(days.length).fill(0);
  for (let d = 1; d < days.length; d++) nights[d] = nights[d - 1] + (weekday(days[d - 1].date) === 3 ? 3 : 1);
  return { days, N, ext, nights };
}
const D = dailyOf();
function simulate(P, next = null) {
  const { days, N, ext, nights } = D, out = [];
  let pos = null, shadow = null, lastShadowWon = false;
  const close = (px, d, reason) => {
    for (const u of pos.units) {
      const move = (pos.dir * (px - u.entry)) / u.entry, risk = (2 * pos.n) / u.entry;
      const cost = roundTrip(u.i), swap = (nights[d] - nights[u.d]) * (pos.dir > 0 ? SWAP.long : SWAP.short);
      out.push({ dir: pos.dir, date: days[u.d].date, exitDate: days[d].date, held: d - u.d, reason, gross: move / risk, noSwap: (move - cost) / risk, net: (move - cost + swap) / risk });
    }
    pos = null;
  };
  for (let d = 56; d < days.length; d++) {
    const n = N[d - 1], day = days[d], open = day.date >= FROM;
    const hiE = ext[P.E].hi[d], loE = ext[P.E].lo[d], hiX = ext[P.X].hi[d], loX = ext[P.X].lo[d], hi55 = ext[55].hi[d], lo55 = ext[55].lo[d];
    for (let i = day.first; i <= day.last; i++) {
      const { o, h, l } = bars[i];
      let closedHere = false;
      if (shadow !== null) {
        const lvl = shadow.dir > 0 ? Math.max(shadow.stop, loX) : Math.min(shadow.stop, hiX);
        if (shadow.dir > 0 ? l <= lvl : h >= lvl) { const px = shadow.dir > 0 ? Math.min(lvl, o) : Math.max(lvl, o); lastShadowWon = shadow.dir * (px - shadow.entry) > 0; shadow = null; }
      }
      if (pos !== null) {
        const lvl = pos.dir > 0 ? Math.max(pos.stop, loX) : Math.min(pos.stop, hiX);
        if (pos.dir > 0 ? l <= lvl : h >= lvl) { close(pos.dir > 0 ? Math.min(lvl, o) : Math.max(lvl, o), d, lvl === pos.stop ? "stop" : "exit"); closedHere = true; } else if (P.adds) {
          while (pos.units.length < 4 && (pos.dir > 0 ? h >= pos.nextAdd : l <= pos.nextAdd)) {
            const entry = pos.dir > 0 ? Math.max(pos.nextAdd, o) : Math.min(pos.nextAdd, o);
            pos.units.push({ entry, i, d }); pos.stop = entry - pos.dir * 2 * pos.n; pos.nextAdd += pos.dir * 0.5 * pos.n;
          }
        }
      }
      const up = h >= hiE, down = l <= loE;
      if (up && down) continue;
      if (P.skip && shadow === null && (up || down)) { const dir = up ? 1 : -1, entry = up ? Math.max(hiE, o) : Math.min(loE, o); shadow = { dir, entry, stop: entry - dir * 2 * n, allowed: !lastShadowWon }; }
      if (pos !== null || closedHere || !open) continue;
      let dir = 0, entry = NaN;
      if (P.random !== undefined) { if (i === day.first && next() < P.random) { dir = next() < 0.5 ? 1 : -1; entry = o; } } else if (up || down) {
        dir = up ? 1 : -1;
        if (!P.skip || (shadow !== null && shadow.dir === dir && shadow.allowed)) entry = up ? Math.max(hiE, o) : Math.min(loE, o);
        else if (up ? h >= hi55 : l <= lo55) entry = up ? Math.max(hi55, o) : Math.min(lo55, o);
        else dir = 0;
      }
      if (dir === 0) continue;
      pos = { dir, n, units: [{ entry, i, d }], stop: entry - dir * 2 * n, nextAdd: entry + dir * 0.5 * n };
    }
  }
  return out;
}
const monthKeys = [];
for (let y = 2015; y <= 2021; y++) for (let m = 1; m <= 12; m++) { const k = `${y}-${String(m).padStart(2, "0")}`; if (k >= FROM.slice(0, 7) && k <= TO.slice(0, 7)) monthKeys.push(k); }
function byMonth(trades, key) {
  const sum = new Map(monthKeys.map((k) => [k, 0]));
  for (const t of trades) sum.set(t.exitDate.slice(0, 7), sum.get(t.exitDate.slice(0, 7)) + t[key]);
  const xs = [...sum.values()];
  return mean(xs) / (sd(xs) / Math.sqrt(xs.length));
}
console.log(`\n=== B. The trend by the Turtle rules; R = the risk of a unit (2 N); t over the monthly sums ===`);
console.log(`${pad("", 42)} ${lpad("trades", 6)} ${lpad("/mo", 5)} | ${lpad("before", 7)} ${lpad("t", 5)} | ${lpad("no swaps", 8)} ${lpad("t", 5)} | ${lpad("after", 7)} ${lpad("t", 5)} | ${lpad("wins", 5)} ${lpad("days", 5)} | ${lpad("after: 1st", 10)} ${lpad("2nd", 7)} | ${lpad("longs", 7)} ${lpad("shorts", 7)}`);
const VARIANTS = [["System 1: 20-day break, 10-day exit", { E: 20, X: 10 }], ["System 2: 55-day break, 20-day exit", { E: 55, X: 20 }], ["System 1 as published (skip rule, adds)", { E: 20, X: 10, skip: true, adds: true }], ["System 2 as published (adds)", { E: 55, X: 20, adds: true }]];
const kept = new Map();
for (const [label, P] of VARIANTS) {
  const tr = simulate(P), m = (key, part = tr) => mean(part.map((t) => t[key]));
  kept.set(label, tr);
  cells.push({ label, before: m("gross"), beforeT: byMonth(tr, "gross"), after: m("net"), afterT: byMonth(tr, "net"), flat: m("noSwap"), flatT: byMonth(tr, "noSwap") });
  console.log(`${pad(label, 42)} ${lpad(tr.length, 6)} ${lpad((tr.length / monthKeys.length).toFixed(1), 5)} | ${lpad(f(m("gross"), 3), 7)} ${lpad(f(byMonth(tr, "gross"), 1), 5)} | ${lpad(f(m("noSwap"), 3), 8)} ${lpad(f(byMonth(tr, "noSwap"), 1), 5)} | ${lpad(f(m("net"), 3), 7)} ${lpad(f(byMonth(tr, "net"), 1), 5)} | ${lpad(((tr.filter((t) => t.gross > 0).length / tr.length) * 100).toFixed(0) + "%", 5)} ${lpad(mean(tr.map((t) => t.held)).toFixed(0), 5)} | ${lpad(f(m("net", tr.filter((t) => t.date < SPLIT)), 3), 10)} ${lpad(f(m("net", tr.filter((t) => t.date >= SPLIT)), 3), 7)} | ${lpad(f(m("net", tr.filter((t) => t.dir > 0)), 3), 7)} ${lpad(f(m("net", tr.filter((t) => t.dir < 0)), 3), 7)}`);
}
for (const [label, P] of VARIANTS.slice(0, 2)) {
  const mine = kept.get(label), target = mine.length, probe = simulate({ ...P, random: 0.05 }, rng(1)).length, chance = Math.min(1, (0.05 * target) / probe);
  const gross = [], noSwap = [];
  for (let s = 0; s < SEEDS; s++) { const ts = simulate({ ...P, random: chance }, rng(1000 + s)); gross.push(mean(ts.map((t) => t.gross))); noSwap.push(mean(ts.map((t) => t.noSwap))); }
  const g = mean(mine.map((t) => t.gross));
  console.log(`control for ${label}: a random day and side, the same stop and exit, ${SEEDS} seeds: before costs ${f(mean(gross), 3)} +- ${sd(gross).toFixed(3)} against ${f(g, 3)} of the system (${f((g - mean(gross)) / sd(gross), 1)} sd); seeds not below the system: ${gross.filter((x) => x >= g).length} of ${SEEDS}`);
  console.log(`   by year, sum of R after costs and swaps: ${[2015, 2016, 2017, 2018, 2019, 2020, 2021].map((y) => { const ts = mine.filter((t) => t.exitDate.startsWith(String(y))); return `${y} ${f(ts.reduce((s, t) => s + t.net, 0), 1)} (${ts.length})`; }).join(", ")}`);
}

// ------------------------------------------------------------------ C. against a stretched move
const days = D.days, logC = days.map((d) => Math.log(d.c));
function stretch(k, Z, hold) {
  const out = [];
  let busyUntil = -1;
  for (let d = Math.max(k, 21); d + hold + 1 < days.length; d++) {
    if (days[d + 1].date < FROM || d + 1 <= busyUntil) continue;
    let sq = 0;
    for (let j = d - 19; j <= d; j++) sq += (logC[j] - logC[j - 1]) ** 2;
    const z = (logC[d] - logC[d - k]) / (Math.sqrt(sq / 20) * Math.sqrt(k));
    if (Math.abs(z) < Z) continue;
    const dir = -Math.sign(z), a = days[d + 1].first, b = days[d + 1 + hold].first;
    out.push({ date: days[d + 1].date, dir, gross: dir * Math.log(bars[b].o / bars[a].o), cost: roundTrip(a), swap: (dir > 0 ? SWAP.long : SWAP.short) * (D.nights[d + 1 + hold] - D.nights[d + 1]) });
    busyUntil = d + 1 + hold;
  }
  return out;
}
/** The drift: the same hold bought from every day. */
function drift(hold) { const xs = []; for (let d = 21; d + hold + 1 < days.length; d++) if (days[d + 1].date >= FROM) xs.push(Math.log(bars[days[d + 1 + hold].first].o / bars[days[d + 1].first].o)); return mean(xs) * 1e4; }
console.log(`\n=== C. Against a stretched move, held five days ===`);
console.log(`${pad("", 46)} ${lpad("n", 5)} ${lpad("tr/mo", 5)} | ${lpad("before", 7)} ${lpad("t", 5)} | ${lpad("cost", 5)} ${lpad("swap", 5)} | ${lpad("after", 7)} ${lpad("t", 5)} | ${lpad("halves, after", 15)} | ${lpad("no swaps", 8)} ${lpad("t", 5)}`);
const lineC = (label, trades) => {
  if (trades.length < 5) { console.log(`${pad(label, 46)} ${lpad(trades.length, 5)} too few`); return; }
  const g = stats(trades, (t) => t.gross), n = stats(trades, (t) => t.gross - t.cost + t.swap), z = stats(trades, (t) => t.gross - t.cost);
  cells.push({ label, before: g.bp, beforeT: g.t, after: n.bp, afterT: n.t, flat: z.bp, flatT: z.t });
  console.log(`${pad(label, 46)} ${lpad(g.n, 5)} ${lpad((g.n / months).toFixed(1), 5)} | ${lpad(f(g.bp, 1), 7)} ${lpad(f(g.t, 1), 5)} | ${lpad(f(-mean(trades.map((t) => t.cost)) * 1e4, 1), 5)} ${lpad(f(mean(trades.map((t) => t.swap)) * 1e4, 1), 5)} | ${lpad(f(n.bp, 1), 7)} ${lpad(f(n.t, 1), 5)} | ${lpad(f(n.a, 1), 7)} ${lpad(f(n.b, 1), 7)} | ${lpad(f(z.bp, 1), 8)} ${lpad(f(z.t, 1), 5)}`);
};
for (const k of [10, 5]) {
  const tr = stretch(k, 1.5, 5);
  lineC(`the move of ${k} days, 1.5 usual moves: both sides`, tr);
  lineC(`   bought after a fall`, tr.filter((t) => t.dir > 0));
  lineC(`   sold after a rise`, tr.filter((t) => t.dir < 0));
}
console.log(`The drift of gold itself: five days bought from every day give ${f(drift(5), 1)} bp before costs.`);

// ------------------------------------------------------------------ D. the day of the week
console.log(`\n=== D. The day of the week: the move of a server day, close to close, before costs ===`);
const NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
for (let wd = 1; wd <= 5; wd++) {
  const xs = [];
  for (let d = 1; d < days.length; d++) if (days[d].date >= FROM && weekday(days[d].date) === wd) xs.push(logC[d] - logC[d - 1]);
  console.log(`  ${pad(NAMES[wd], 10)} ${lpad(xs.length, 4)} days  ${lpad(f(mean(xs) * 1e4, 1), 6)} bp  (t ${f(mean(xs) / (sd(xs) / Math.sqrt(xs.length)), 1)})`);
}
console.log(`\nCells with a rule: ${cells.length}. After costs and swaps above zero: ${cells.filter((c) => c.after > 0).length}, of them t >= 2: ${cells.filter((c) => c.after > 0 && c.afterT >= 2).length}. Without swaps above zero: ${cells.filter((c) => c.flat > 0).length}, of them t >= 2: ${cells.filter((c) => c.flat > 0 && c.flatT >= 2).length}.`);
