// The "Turtles" by their published rules on currencies (TZ 17.27). The videos
// name the system and the Donchian channel but give no periods; the rules
// themselves are public (the original Turtle rules, 1983): System 1 enters on
// a break of the 20-day high or low and leaves on the 10-day low or high,
// System 2 is 55 and 20 days; the stop is 2 N from the entry (N is the 20-day
// smoothed true range); a unit is added every half N up to four; System 1
// skips a breakout when the breakout before it would have been a winner,
// unless the price goes on to the 55-day extreme.
//
// Seven dollar pairs with their true M15 highs and lows, and the 21 crosses
// built from M15 closes of two dollar pairs (a cross pays the costs of both
// legs; a broker's own cross would cost about half). Daily levels come from
// the days before, fills are found on M15. Dev only.
//
// The control has no idea in it: a position is opened at the open of a random
// day in a random direction and is closed by the same stop and the same
// 10-day (or 20-day) exit. Many seeds give the spread of a result that comes
// from the exit alone.
//
// Usage: node research/fx-trend.mjs
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const FROM = "2015-02-02", TO = "2021-12-08", SPLIT = "2019-01-01";
const SEEDS = +(process.env.SEEDS ?? 40);
const CUR = { EUR: ["EURUSD", false], GBP: ["GBPUSD", false], AUD: ["AUDUSD", false], NZD: ["NZDUSD", false], JPY: ["USDJPY", true], CAD: ["USDCAD", true], CHF: ["USDCHF", true] };

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const f = (x, d = 3) => (!Number.isFinite(x) ? "  n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------ data
const raw = {};
for (const [cur, [pair]] of Object.entries(CUR)) {
  const own = config.symbols[pair];
  const point = 10 ** -own.digits;
  const m = new Map();
  const lines = readFileSync(`${config.dataDir}/${pair}_M15.csv`, "utf8").split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after dev is read
    m.set(`${date} ${p[1].slice(0, 5)}`, [+p[2], +p[3], +p[4], +p[5], +p[8]]);
  }
  raw[cur] = {
    pair, m, point, pip: point * 10, base: own.usdSide === "base",
    minSpread: own.minSpreadPoints ?? config.costs.minSpreadPoints,
    slip: config.costs.slippagePips * point * 10,
    commission: (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize,
    swapLong: own.swapLongPips * point * 10, swapShort: own.swapShortPips * point * 10,
  };
}
const names = Object.keys(CUR);
const stamps = [...raw.EUR.m.keys()].filter((k) => names.every((n) => raw[n].m.has(k)));
const dates = stamps.map((k) => k.slice(0, 10));
const T = stamps.length;

/** One dollar pair on the common bars: prices, the round-trip cost and the swaps as shares of the price. */
function leg(cur) {
  const r = raw[cur];
  const o = new Float64Array(T), h = new Float64Array(T), l = new Float64Array(T), c = new Float64Array(T), cost = new Float64Array(T);
  stamps.forEach((k, i) => {
    const b = r.m.get(k);
    o[i] = b[0]; h[i] = b[1]; l[i] = b[2]; c[i] = b[3];
    cost[i] = (Math.max(b[4], r.minSpread) * r.point + 2 * r.slip + (r.base ? r.commission * b[3] : r.commission)) / b[3];
  });
  return { ...r, o, h, l, c, cost };
}
const legs = Object.fromEntries(names.map((n) => [n, leg(n)]));
/** The swap of one night for being long (or short) a currency against the dollar, as a share of the price. */
const swapOfCurrency = (cur, long, i) => { const g = legs[cur], inverse = CUR[cur][1]; return ((long !== inverse ? g.swapLong : g.swapShort)) / g.c[i]; };

function daily(inst) {
  const days = [];
  for (let i = 0; i < T; i++) {
    const t = days[days.length - 1];
    if (t === undefined || t.date !== dates[i]) days.push({ date: dates[i], first: i, last: i, h: inst.h[i], l: inst.l[i], c: inst.c[i] });
    else { t.h = Math.max(t.h, inst.h[i]); t.l = Math.min(t.l, inst.l[i]); t.c = inst.c[i]; t.last = i; }
  }
  // N of the Turtles: the true range smoothed over 20 days.
  const N = new Array(days.length).fill(NaN);
  let sum = 0;
  for (let d = 1; d < days.length; d++) {
    const tr = Math.max(days[d].h - days[d].l, Math.abs(days[d].h - days[d - 1].c), Math.abs(days[d].l - days[d - 1].c));
    if (d <= 20) { sum += tr; if (d === 20) N[d] = sum / 20; } else N[d] = (19 * N[d - 1] + tr) / 20;
  }
  // The highest high and the lowest low of the n days before day d.
  const ext = {};
  for (const n of [10, 20, 55]) {
    const hi = new Array(days.length).fill(NaN), lo = new Array(days.length).fill(NaN);
    for (let d = n; d < days.length; d++) { let a = -Infinity, b = Infinity; for (let j = d - n; j < d; j++) { if (days[j].h > a) a = days[j].h; if (days[j].l < b) b = days[j].l; } hi[d] = a; lo[d] = b; }
    ext[n] = { hi, lo };
  }
  // Swap nights charged before day d: one a day, three after a Wednesday.
  const nights = new Array(days.length).fill(0);
  for (let d = 1; d < days.length; d++) nights[d] = nights[d - 1] + (weekday(days[d - 1].date) === 3 ? 3 : 1);
  return { days, N, ext, nights };
}

const instruments = [];
for (const cur of names) {
  const g = legs[cur], inverse = CUR[cur][1];
  const inst = { name: g.pair, usd: true, o: g.o, h: g.h, l: g.l, c: g.c, cost: (i) => g.cost[i], swap: (dir, i) => (dir > 0 ? g.swapLong : g.swapShort) / g.c[i] };
  void inverse;
  instruments.push({ ...inst, ...daily(inst) });
}
for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
  const A = legs[names[a]], B = legs[names[b]], ia = CUR[names[a]][1], ib = CUR[names[b]][1];
  const o = new Float64Array(T), h = new Float64Array(T), l = new Float64Array(T), c = new Float64Array(T);
  for (let i = 0; i < T; i++) {
    c[i] = (ia ? 1 / A.c[i] : A.c[i]) / (ib ? 1 / B.c[i] : B.c[i]);
    o[i] = i === 0 ? c[i] : c[i - 1]; h[i] = Math.max(o[i], c[i]); l[i] = Math.min(o[i], c[i]);
  }
  const inst = {
    name: `${names[a]}${names[b]}`, usd: false, o, h, l, c,
    cost: (i) => A.cost[i] + B.cost[i],
    // Long the cross is long the first currency and short the second, each against the dollar.
    swap: (dir, i) => swapOfCurrency(names[a], dir > 0, i) + swapOfCurrency(names[b], dir < 0, i),
  };
  instruments.push({ ...inst, ...daily(inst) });
}

// ------------------------------------------------------------------ the system
/**
 * P: { E, X } days of the entry and of the exit channel; `adds` up to four units, one every half N;
 * `skip` the System 1 rule (no entry after a winning breakout unless the 55-day extreme is reached);
 * `random` the chance of a random entry at the open of a day instead of the breakout (the control).
 */
function simulate(inst, P, next = null) {
  const { days, N, ext, nights, o, h, l } = inst;
  const out = [];
  let pos = null, shadow = null, lastShadowWon = false;
  const close = (px, i, d, reason) => {
    for (const u of pos.units) {
      const move = (pos.dir * (px - u.entry)) / u.entry, risk = (2 * pos.n) / u.entry;
      const cost = inst.cost(u.i), swap = (nights[d] - nights[u.d]) * inst.swap(pos.dir, u.i);
      out.push({ name: inst.name, usd: inst.usd, dir: pos.dir, date: days[u.d].date, exitDate: days[d].date, held: d - u.d, reason, gross: move / risk, noSwap: (move - cost) / risk, net: (move - cost + swap) / risk });
    }
    pos = null;
  };
  for (let d = 56; d < days.length; d++) {
    const n = N[d - 1], day = days[d], open = day.date >= FROM;
    const hiE = ext[P.E].hi[d], loE = ext[P.E].lo[d], hiX = ext[P.X].hi[d], loX = ext[P.X].lo[d], hi55 = ext[55].hi[d], lo55 = ext[55].lo[d];
    for (let i = day.first; i <= day.last; i++) {
      let closedHere = false;
      if (shadow !== null) {
        const lvl = shadow.dir > 0 ? Math.max(shadow.stop, loX) : Math.min(shadow.stop, hiX);
        if (shadow.dir > 0 ? l[i] <= lvl : h[i] >= lvl) {
          const px = shadow.dir > 0 ? Math.min(lvl, o[i]) : Math.max(lvl, o[i]);
          lastShadowWon = shadow.dir * (px - shadow.entry) > 0;
          shadow = null;
        }
      }
      if (pos !== null) {
        const lvl = pos.dir > 0 ? Math.max(pos.stop, loX) : Math.min(pos.stop, hiX);
        if (pos.dir > 0 ? l[i] <= lvl : h[i] >= lvl) {
          close(pos.dir > 0 ? Math.min(lvl, o[i]) : Math.max(lvl, o[i]), i, d, lvl === pos.stop ? "stop" : "exit");
          closedHere = true;
        } else if (P.adds) {
          while (pos.units.length < 4 && (pos.dir > 0 ? h[i] >= pos.nextAdd : l[i] <= pos.nextAdd)) {
            const entry = pos.dir > 0 ? Math.max(pos.nextAdd, o[i]) : Math.min(pos.nextAdd, o[i]);
            pos.units.push({ entry, i, d });
            pos.stop = entry - pos.dir * 2 * pos.n;
            pos.nextAdd += pos.dir * 0.5 * pos.n;
          }
        }
      }
      const up = h[i] >= hiE, down = l[i] <= loE;
      if (up && down) continue;
      if (P.skip && shadow === null && (up || down)) {
        const dir = up ? 1 : -1, entry = up ? Math.max(hiE, o[i]) : Math.min(loE, o[i]);
        shadow = { dir, entry, stop: entry - dir * 2 * n, allowed: !lastShadowWon };
      }
      if (pos !== null || closedHere || !open) continue;
      let dir = 0, entry = NaN;
      if (P.random !== undefined) {
        if (i === day.first && next() < P.random) { dir = next() < 0.5 ? 1 : -1; entry = o[i]; }
      } else if (up || down) {
        dir = up ? 1 : -1;
        if (!P.skip || (shadow !== null && shadow.dir === dir && shadow.allowed)) entry = up ? Math.max(hiE, o[i]) : Math.min(loE, o[i]);
        else if (up ? h[i] >= hi55 : l[i] <= lo55) entry = up ? Math.max(hi55, o[i]) : Math.min(lo55, o[i]); // the failsafe
        else dir = 0;
      }
      if (dir === 0) continue;
      pos = { dir, n, units: [{ entry, i, d }], stop: entry - dir * 2 * n, nextAdd: entry + dir * 0.5 * n };
    }
  }
  return out;
}

// ------------------------------------------------------------------ the tables
const months = [];
for (let y = 2015; y <= 2021; y++) for (let m = 1; m <= 12; m++) { const k = `${y}-${String(m).padStart(2, "0")}`; if (k >= FROM.slice(0, 7) && k <= TO.slice(0, 7)) months.push(k); }
/** The t of the monthly sums of R: trades of one month move together, months do not. */
function byMonth(trades, key) {
  const sum = new Map(months.map((k) => [k, 0]));
  for (const t of trades) sum.set(t.exitDate.slice(0, 7), sum.get(t.exitDate.slice(0, 7)) + t[key]);
  const xs = [...sum.values()];
  return { perMonth: mean(xs), t: mean(xs) / (sd(xs) / Math.sqrt(xs.length)) };
}
function row(label, trades) {
  if (trades.length === 0) { console.log(`${pad(label, 44)} no trades`); return; }
  const g = byMonth(trades, "gross"), ns = byMonth(trades, "noSwap"), net = byMonth(trades, "net");
  const a = trades.filter((t) => t.date < SPLIT), z = trades.filter((t) => t.date >= SPLIT);
  console.log(`${pad(label, 44)}${lpad(trades.length, 6)}${lpad((trades.length / months.length).toFixed(1), 7)}  ${f(mean(trades.map((t) => t.gross)))} (${f(g.t, 1)})   ${f(mean(trades.map((t) => t.noSwap)))} (${f(ns.t, 1)})   ${f(mean(trades.map((t) => t.net)))} (${f(net.t, 1)})  ${lpad(((trades.filter((t) => t.gross > 0).length / trades.length) * 100).toFixed(0), 4)}%  ${lpad(mean(trades.map((t) => t.held)).toFixed(0), 4)}   ${f(mean(a.map((t) => t.noSwap)))} / ${f(mean(z.map((t) => t.noSwap)))}`);
}
const HEAD = `${pad("", 44)}trades  a month  before costs (t)  no swaps (t)     with swaps (t)   wins  days   no swaps: 2015-18 / 2019-21`;

const VARIANTS = [
  ["System 1: 20-day break, 10-day exit", { E: 20, X: 10 }],
  ["System 1 with the skip rule", { E: 20, X: 10, skip: true }],
  ["System 2: 55-day break, 20-day exit", { E: 55, X: 20 }],
  ["System 1 with adds", { E: 20, X: 10, adds: true }],
  ["System 1 as published (skip rule, adds)", { E: 20, X: 10, skip: true, adds: true }],
  ["System 2 as published (adds)", { E: 55, X: 20, adds: true }],
];
console.log(`common M15 bars ${T}, instruments ${instruments.length} (7 dollar pairs, 21 crosses), months ${months.length}; R is the result in shares of the risk (2 N); t is over the monthly sums`);
const results = new Map();
for (const [label, P] of VARIANTS) {
  const all = instruments.flatMap((inst) => simulate(inst, P));
  results.set(label, all);
  console.log(`\n== ${label} ==\n${HEAD}`);
  row("dollar pairs", all.filter((t) => t.usd));
  row("crosses (costs of two legs)", all.filter((t) => !t.usd));
  row("all 28", all);
  row("  longs", all.filter((t) => t.dir > 0));
  row("  shorts", all.filter((t) => t.dir < 0));
}

// By year and by instrument for the two plain systems.
for (const label of [VARIANTS[0][0], VARIANTS[2][0]]) {
  const all = results.get(label);
  console.log(`\n-- ${label}: sum of R without swaps by year --`);
  console.log([2015, 2016, 2017, 2018, 2019, 2020, 2021].map((y) => { const ts = all.filter((t) => t.exitDate.startsWith(String(y))); return `${y}: ${f(ts.reduce((s, t) => s + t.noSwap, 0), 1)} (${ts.length})`; }).join("   "));
  const per = instruments.map((inst) => { const ts = all.filter((t) => t.name === inst.name); return { name: inst.name, n: ts.length, m: mean(ts.map((t) => t.noSwap)) }; }).sort((x, y) => y.m - x.m);
  console.log(`   by instrument (no swaps): ${per.map((x) => `${x.name} ${f(x.m, 2)} (${x.n})`).join(", ")}`);
  console.log(`   instruments above zero: ${per.filter((x) => x.m > 0).length} of ${per.length}`);
}

// The control: random entries with the same stop and the same exit channel.
console.log(`\n== Control: a random day, a random direction, the same stop and exit; ${SEEDS} seeds ==`);
for (const [label, P] of [VARIANTS[0], VARIANTS[2]]) {
  const target = results.get(label).length;
  // The chance is set so that the control makes about as many trades as the system.
  const probe = instruments.flatMap((inst) => simulate(inst, { ...P, random: 0.05 }, rng(1))).length;
  const chance = Math.min(1, (0.05 * target) / probe);
  const gross = [], noSwap = [], counts = [];
  for (let s = 0; s < SEEDS; s++) {
    const next = rng(1000 + s);
    const ts = instruments.flatMap((inst) => simulate(inst, { ...P, random: chance }, next));
    gross.push(mean(ts.map((t) => t.gross))); noSwap.push(mean(ts.map((t) => t.noSwap))); counts.push(ts.length);
  }
  const mine = results.get(label), g = mean(mine.map((t) => t.gross));
  console.log(`${pad(label, 40)} control trades ${mean(counts).toFixed(0)} (system ${target}); before costs: control ${f(mean(gross))} +- ${sd(gross).toFixed(3)}, system ${f(g)} -> ${f((g - mean(gross)) / sd(gross), 1)} sd; control without swaps ${f(mean(noSwap))}; seeds where the control beat the system: ${gross.filter((x) => x >= g).length} of ${SEEDS}`);
}
