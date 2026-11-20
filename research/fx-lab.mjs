// A lab for the setups the Telegram authors name but that were never run on
// currencies (TZ 17.24): EMA crosses, EMA 5/10 with MACD, DeMarker, a series
// of inside bars, engulfing and pin bars at an extreme, Turtle Soup, a sweep
// of the Asian or London range, and the plain break of that range as a
// reference. Seven dollar pairs, M15 execution, the costs of the project
// (Ask = Bid + spread of the bar, not below the floor; slippage on every
// fill; commission; swaps). Dev only: every setup is shown on the first part
// of dev (to the end of 2018) and on the second (2019-2021) separately, so a
// choice made on the first can be checked on the second before test is spent.
//
// Usage: node research/fx-lab.mjs [family]
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = (process.env.PAIRS ?? "EURUSD,GBPUSD,USDJPY,AUDUSD,NZDUSD,USDCAD,USDCHF").split(",");
const FROM = "2015-02-02", TO = "2021-12-08", SPLIT = "2019-01-01";
const only = process.argv[2];

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f = (x, d = 3) => (!Number.isFinite(x) ? "  n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

// ------------------------------------------------------------------ data
function spec(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits;
  return {
    symbol, point, pip: point * 10, base: own.usdSide === "base", contract: own.contractSize,
    minSpread: own.minSpreadPoints ?? config.costs.minSpreadPoints,
    slip: config.costs.slippagePips * point * 10,
    commission: own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip,
    swapLong: own.swapLongPips * point * 10, swapShort: own.swapShortPips * point * 10,
    // Where the config gives a reference price the swap is a share of the price (gold).
    swapRef: own.swapReferencePrice ?? null,
  };
}
function loadM15(symbol) {
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after dev is read
    rows.push({ date, hour: +p[1].slice(0, 2), minute: +p[1].slice(3, 5), o: +p[2], h: +p[3], l: +p[4], c: +p[5], spread: +p[8] });
  }
  return rows;
}
/** Bars of a higher timeframe built from M15; `last` is the index of the M15 bar that closes them. */
function aggregate(m15, keyOf) {
  const bars = [];
  let key = null;
  m15.forEach((b, i) => {
    const k = keyOf(b);
    if (k !== key) { bars.push({ date: b.date, hour: b.hour, o: b.o, h: b.h, l: b.l, c: b.c, first: i, last: i }); key = k; } else {
      const t = bars[bars.length - 1];
      t.h = Math.max(t.h, b.h); t.l = Math.min(t.l, b.l); t.c = b.c; t.last = i;
    }
  });
  return bars;
}
const sma = (xs, n) => xs.map((_, i) => (i + 1 < n ? NaN : mean(xs.slice(i + 1 - n, i + 1))));
function ema(xs, n) {
  const out = new Array(xs.length).fill(NaN);
  const k = 2 / (n + 1);
  let v = NaN;
  for (let i = 0; i < xs.length; i++) { v = i === 0 ? xs[0] : xs[i] * k + v * (1 - k); if (i + 1 >= n) out[i] = v; }
  return out;
}
function atr(bars, n) {
  const tr = bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
  return sma(tr, n);
}
/** Lowest low and highest high of the `n` bars before bar i (bar i itself is not in). */
function extremesBefore(bars, n) {
  const lo = new Array(bars.length).fill(NaN), hi = new Array(bars.length).fill(NaN), loAt = new Array(bars.length).fill(-1), hiAt = new Array(bars.length).fill(-1);
  for (let i = n; i < bars.length; i++) {
    let a = Infinity, b = -Infinity;
    for (let j = i - n; j < i; j++) { if (bars[j].l < a) { a = bars[j].l; loAt[i] = j; } if (bars[j].h > b) { b = bars[j].h; hiAt[i] = j; } }
    lo[i] = a; hi[i] = b;
  }
  return { lo, hi, loAt, hiAt };
}

const market = new Map();
for (const symbol of PAIRS) {
  const m15 = loadM15(symbol);
  const tf = {
    M15: m15.map((b, i) => ({ ...b, first: i, last: i })),
    H1: aggregate(m15, (b) => `${b.date} ${b.hour}`),
    H4: aggregate(m15, (b) => `${b.date} ${Math.floor(b.hour / 4)}`),
    D1: aggregate(m15, (b) => b.date),
  };
  // Daily numbers known at the open of a day: the ATR(20) and the SMA(200) of the days before it.
  const dAtr = atr(tf.D1, 20), dSma = sma(tf.D1.map((b) => b.c), 200);
  const day = new Map();
  tf.D1.forEach((b, i) => { if (i > 0) day.set(b.date, { atr: dAtr[i - 1], above: Number.isFinite(dSma[i - 1]) ? Math.sign(tf.D1[i - 1].c - dSma[i - 1]) : 0, index: i }); });
  market.set(symbol, { s: spec(symbol), m15, tf, day });
}

// ------------------------------------------------------------------ execution
/**
 * Runs the orders of one pair, one position (or one waiting order) at a time.
 * An order: { at, legs: [{ dir, type: "market"|"stop"|"limit", price, sl, tp }], rr, expire, timeExit }.
 * `at` is the first M15 bar on which it may be filled, `expire` the last; the first leg to be
 * triggered is the trade, two legs in one bar cancel the order. The take-profit is `tp` or `rr`
 * stop distances from the fill. Within one bar the stop is taken before the profit; on the bar of
 * a stop or limit fill the stop counts as hit if the bar reached it (worst case), the profit never.
 */
function execute(symbol, orders, costs = true) {
  const { s, m15, day } = market.get(symbol);
  const spreadOf = (b) => (costs ? Math.max(b.spread, s.minSpread) * s.point : 0);
  const slip = costs ? s.slip : 0;
  orders.sort((a, b) => a.at - b.at);
  const trades = [];
  let free = 0;
  for (const ord of orders) {
    if (ord.at < free || ord.at >= m15.length) continue;
    if (m15[ord.at].date < FROM) continue;
    const lastTry = Math.min(ord.expire ?? ord.at, m15.length - 1);
    let fill = null, cancelled = false, i = ord.at;
    for (; i <= lastTry; i++) {
      const b = m15[i], sp = spreadOf(b);
      const hits = [];
      for (const leg of ord.legs) {
        if (leg.type === "market") { if (i === ord.at) hits.push({ leg, price: leg.dir > 0 ? b.o + sp + slip : b.o - slip }); }
        else if (leg.type === "stop") {
          if (leg.dir > 0 && b.h + sp >= leg.price) hits.push({ leg, price: Math.max(leg.price, b.o + sp) + slip });
          if (leg.dir < 0 && b.l <= leg.price) hits.push({ leg, price: Math.min(leg.price, b.o) - slip });
        } else {
          if (leg.dir > 0 && b.l + sp <= leg.price) hits.push({ leg, price: Math.min(leg.price, b.o + sp) + slip });
          if (leg.dir < 0 && b.h >= leg.price) hits.push({ leg, price: Math.max(leg.price, b.o) - slip });
        }
      }
      if (hits.length > 1) { cancelled = true; break; }
      if (hits.length === 1) { fill = hits[0]; break; }
    }
    if (fill === null) { free = Math.min(i, lastTry) + (cancelled ? 1 : 0); continue; }
    const { leg, price: entry } = fill;
    const dir = leg.dir;
    const dayInfo = day.get(m15[i].date);
    if (dayInfo === undefined || !Number.isFinite(dayInfo.atr)) { free = i + 1; continue; }
    // The stop is never closer than a tenth of the daily ATR: a tighter one is only a way to pay the spread.
    const minDist = 0.1 * dayInfo.atr;
    let dist = dir * (entry - leg.sl);
    if (!(dist >= minDist)) dist = minDist;
    const sl = entry - dir * dist;
    const tp = leg.tp ?? (ord.rr ? entry + dir * ord.rr * dist : null);
    let exit = NaN, reason = "", j = i;
    for (; j < m15.length; j++) {
      const b = m15[j], sp = spreadOf(b);
      const entryBar = j === i, wasMarket = leg.type === "market";
      if (!entryBar && ord.timeExit !== undefined && j >= ord.timeExit) { exit = dir > 0 ? b.o - slip : b.o + sp + slip; reason = "time"; break; }
      if (dir > 0) {
        if (b.l <= sl) { exit = (entryBar && !wasMarket ? sl : Math.min(sl, b.o)) - slip; reason = "stop"; break; }
        if (tp !== null && b.h >= tp && !(entryBar && !wasMarket)) { exit = tp - slip; reason = "target"; break; }
      } else {
        if (b.h + sp >= sl) { exit = (entryBar && !wasMarket ? sl : Math.max(sl, b.o + sp)) + slip; reason = "stop"; break; }
        if (tp !== null && b.l + sp <= tp && !(entryBar && !wasMarket)) { exit = tp + slip; reason = "target"; break; }
      }
    }
    if (!Number.isFinite(exit)) break; // the data ended with the position open
    let swap = 0;
    if (costs) for (let k = i + 1; k <= j; k++) if (m15[k].date !== m15[k - 1].date) swap += (dir > 0 ? s.swapLong : s.swapShort) * (s.swapRef === null ? 1 : entry / s.swapRef) * (weekday(m15[k - 1].date) === 3 ? 3 : 1);
    const commission = !costs ? 0 : s.base ? (s.commission / s.contract) * entry : s.commission / s.contract;
    trades.push({ symbol, date: m15[i].date, dir, r: (dir * (exit - entry) + swap - commission) / dist, reason, bars: j - i });
    free = j;
  }
  return trades;
}

// ------------------------------------------------------------------ setups
const trendOk = (m, date, dir, filter) => filter === "none" || m.day.get(date)?.above === dir;
/** Index of the M15 bar after the close of timeframe bar j. */
const after = (bars, j) => bars[j].last + 1;

function emaCross(m, { tf, fast, slow, k, rr, filter }) {
  const bars = m.tf[tf], c = bars.map((b) => b.c), a = ema(c, fast), b2 = ema(c, slow), av = atr(bars, 14);
  const cross = [];
  for (let j = slow + 1; j < bars.length; j++) {
    const now = Math.sign(a[j] - b2[j]), was = Math.sign(a[j - 1] - b2[j - 1]);
    if (now !== 0 && was !== 0 && now !== was) cross.push({ j, dir: now });
  }
  const orders = [];
  cross.forEach((x, n) => {
    const next = cross[n + 1];
    if (!Number.isFinite(av[x.j]) || !trendOk(m, bars[x.j].date, x.dir, filter)) return;
    orders.push({ at: after(bars, x.j), legs: [{ dir: x.dir, type: "market", sl: bars[x.j].c - x.dir * k * av[x.j] }], rr, timeExit: next ? after(bars, next.j) : undefined });
  });
  return orders;
}
function macdEma(m, { stopAtr }) {
  const bars = m.tf.D1, c = bars.map((b) => b.c), e5 = ema(c, 5), e10 = ema(c, 10), e12 = ema(c, 12), e26 = ema(c, 26), av = atr(bars, 20);
  const line = c.map((_, i) => e12[i] - e26[i]);
  const firstOk = line.findIndex(Number.isFinite);
  const signal = new Array(c.length).fill(NaN);
  ema(line.slice(firstOk), 9).forEach((v, i) => { signal[i + firstOk] = v; });
  const state = c.map((_, i) => (!Number.isFinite(signal[i]) ? 0 : e5[i] > e10[i] && line[i] > signal[i] ? 1 : e5[i] < e10[i] && line[i] < signal[i] ? -1 : 0));
  const orders = [];
  for (let j = 40; j < bars.length; j++) {
    if (state[j] === 0 || state[j] === state[j - 1]) continue;
    let out = j + 1;
    while (out < bars.length && Math.sign(e5[out] - e10[out]) === state[j]) out++;
    orders.push({ at: after(bars, j), legs: [{ dir: state[j], type: "market", sl: bars[j].c - state[j] * stopAtr * av[j] }], timeExit: out < bars.length ? after(bars, out) : undefined });
  }
  return orders;
}
function demarker(m, { tf, rr, filter }) {
  const bars = m.tf[tf], av = atr(bars, 14);
  const up = bars.map((b, i) => (i === 0 ? 0 : Math.max(b.h - bars[i - 1].h, 0))), down = bars.map((b, i) => (i === 0 ? 0 : Math.max(bars[i - 1].l - b.l, 0)));
  const su = sma(up, 14), sd = sma(down, 14);
  const dem = su.map((v, i) => (v + sd[i] === 0 ? 0.5 : v / (v + sd[i])));
  const orders = [];
  for (let j = 20; j < bars.length; j++) {
    const dir = dem[j - 1] < 0.3 && dem[j] >= 0.3 ? 1 : dem[j - 1] > 0.7 && dem[j] <= 0.7 ? -1 : 0;
    if (dir === 0 || !Number.isFinite(av[j]) || !trendOk(m, bars[j].date, dir, filter)) continue;
    orders.push({ at: after(bars, j), legs: [{ dir, type: "market", sl: bars[j].c - dir * 1.5 * av[j] }], rr, timeExit: j + 20 < bars.length ? after(bars, j + 20) : undefined });
  }
  return orders;
}
function insideSeries(m, { tf, rr }) {
  const bars = m.tf[tf], buf = m.s.pip;
  const orders = [];
  for (let j = 3; j + 1 < bars.length; j++) {
    const mother = bars[j - 2];
    const inside = (b) => b.h <= mother.h && b.l >= mother.l;
    if (!inside(bars[j - 1]) || !inside(bars[j])) continue;
    orders.push({
      at: after(bars, j), expire: bars[Math.min(j + 3, bars.length - 1)].last, rr,
      legs: [{ dir: 1, type: "stop", price: mother.h + buf, sl: mother.l - buf }, { dir: -1, type: "stop", price: mother.l - buf, sl: mother.h + buf }],
      timeExit: j + 20 < bars.length ? after(bars, j + 20) : undefined,
    });
  }
  return orders;
}
function engulfing(m, { tf, entry, rr }) {
  const bars = m.tf[tf], av = atr(bars, 14), ext = extremesBefore(bars, 20);
  const orders = [];
  for (let j = 22; j + 1 < bars.length; j++) {
    const p = bars[j - 1], b = bars[j];
    if (!Number.isFinite(av[j])) continue;
    let dir = 0;
    if (p.c < p.o && b.c > b.o && b.c >= p.o && b.o <= p.c && Math.min(p.l, b.l) <= ext.lo[j - 1]) dir = 1;
    if (p.c > p.o && b.c < b.o && b.c <= p.o && b.o >= p.c && Math.max(p.h, b.h) >= ext.hi[j - 1]) dir = -1;
    if (dir === 0) continue;
    const sl = dir > 0 ? Math.min(p.l, b.l) - 0.1 * av[j] : Math.max(p.h, b.h) + 0.1 * av[j];
    const leg = entry === "market" ? { dir, type: "market", sl } : { dir, type: "limit", price: (b.h + b.l) / 2, sl };
    orders.push({ at: after(bars, j), expire: entry === "market" ? undefined : bars[Math.min(j + 3, bars.length - 1)].last, legs: [leg], rr, timeExit: j + 20 < bars.length ? after(bars, j + 20) : undefined });
  }
  return orders;
}
function pinBar(m, { tf, rr }) {
  const bars = m.tf[tf], ext = extremesBefore(bars, 20), buf = m.s.pip;
  const orders = [];
  for (let j = 21; j + 1 < bars.length; j++) {
    const b = bars[j], range = b.h - b.l;
    if (!(range > 0)) continue;
    const body = Math.abs(b.c - b.o), lower = Math.min(b.o, b.c) - b.l, upper = b.h - Math.max(b.o, b.c);
    let dir = 0;
    if (lower >= 0.6 * range && body <= 0.3 * range && b.l <= ext.lo[j]) dir = 1;
    if (upper >= 0.6 * range && body <= 0.3 * range && b.h >= ext.hi[j]) dir = -1;
    if (dir === 0) continue;
    orders.push({
      at: after(bars, j), expire: bars[Math.min(j + 2, bars.length - 1)].last, rr,
      legs: [dir > 0 ? { dir, type: "stop", price: b.h + buf, sl: b.l - buf } : { dir, type: "stop", price: b.l - buf, sl: b.h + buf }],
      timeExit: j + 20 < bars.length ? after(bars, j + 20) : undefined,
    });
  }
  return orders;
}
/** Turtle Soup (L. Raschke): a new N-day low when the previous one is at least four days old; buy back above the old low. */
function turtleSoup(m, { days, rr, plusOne }) {
  const d1 = m.tf.D1, m15 = m.m15, ext = extremesBefore(d1, days), buf = m.s.pip, sp = (b) => Math.max(b.spread, m.s.minSpread) * m.s.point;
  const orders = [];
  for (let d = days; d + 4 < d1.length; d++) {
    const endIdx = plusOne ? d1[d + 1].last : d1[d].last;
    const exitIdx = d1[d + 3].last;
    for (const dir of [1, -1]) {
      const level = dir > 0 ? ext.lo[d] : ext.hi[d], at = dir > 0 ? ext.loAt[d] : ext.hiAt[d];
      if (d - at < 4) continue;
      let broke = -1, extreme = dir > 0 ? Infinity : -Infinity;
      for (let i = d1[d].first; i <= endIdx; i++) {
        const b = m15[i];
        extreme = dir > 0 ? Math.min(extreme, b.l) : Math.max(extreme, b.h);
        if (broke < 0) { if (dir > 0 ? b.l < level : b.h > level) broke = i; continue; }
        const back = dir > 0 ? b.h + sp(b) >= level + buf : b.l <= level - buf;
        if (back) {
          orders.push({ at: i, expire: i, rr, legs: [{ dir, type: "stop", price: level + dir * buf, sl: extreme - dir * buf }], timeExit: exitIdx });
          break;
        }
      }
    }
  }
  return orders;
}
/** A sweep of the range of the hours [a, b): price goes beyond it during [b, c), an M15 bar closes back inside, trade back in. */
function sweep(m, { a, b, c, target, rr }) {
  const { m15, tf } = m, buf = m.s.pip;
  const orders = [];
  for (const d of tf.D1) {
    let hi = -Infinity, lo = Infinity, sweptHi = -Infinity, sweptLo = Infinity, done = false, exitIdx = d.last;
    for (let i = d.first; i <= d.last; i++) if (m15[i].hour >= 22) { exitIdx = i; break; }
    for (let i = d.first; i <= d.last && !done; i++) {
      const bar = m15[i];
      if (bar.hour >= a && bar.hour < b) { hi = Math.max(hi, bar.h); lo = Math.min(lo, bar.l); continue; }
      if (bar.hour < b || bar.hour >= c || !Number.isFinite(hi)) continue;
      if (bar.h > hi) sweptHi = Math.max(sweptHi, bar.h);
      if (bar.l < lo) sweptLo = Math.min(sweptLo, bar.l);
      if (Number.isFinite(sweptHi) && Number.isFinite(sweptLo)) { done = true; break; }
      let dir = 0;
      if (Number.isFinite(sweptHi) && bar.c < hi) dir = -1;
      if (Number.isFinite(sweptLo) && bar.c > lo) dir = 1;
      if (dir === 0 || i + 1 > d.last) continue;
      const sl = dir < 0 ? sweptHi + buf : sweptLo - buf;
      orders.push({ at: i + 1, legs: [{ dir, type: "market", sl, tp: target === "other side" ? (dir < 0 ? lo : hi) : undefined }], rr: target === "other side" ? undefined : rr, timeExit: exitIdx });
      done = true;
    }
  }
  return orders;
}
/** The plain break of the same range, as the mirror of the sweep. */
function rangeBreak(m, { a, b, c, rr }) {
  const { m15, tf } = m, buf = m.s.pip;
  const orders = [];
  for (const d of tf.D1) {
    let hi = -Infinity, lo = Infinity, start = -1, end = -1, exitIdx = d.last;
    for (let i = d.first; i <= d.last; i++) {
      const bar = m15[i];
      if (bar.hour >= a && bar.hour < b) { hi = Math.max(hi, bar.h); lo = Math.min(lo, bar.l); }
      if (bar.hour >= b && bar.hour < c) { if (start < 0) start = i; end = i; }
      if (bar.hour >= 22 && exitIdx === d.last) exitIdx = i;
    }
    if (start < 0 || !Number.isFinite(hi)) continue;
    const mid = (hi + lo) / 2;
    orders.push({ at: start, expire: end, rr, timeExit: exitIdx, legs: [{ dir: 1, type: "stop", price: hi + buf, sl: mid }, { dir: -1, type: "stop", price: lo - buf, sl: mid }] });
  }
  return orders;
}

// ------------------------------------------------------------------ the list
const setups = [];
const add = (family, label, fn, params) => setups.push({ family, label, fn, params });
for (const tf of ["M15", "H1", "H4"]) for (const [fast, slow] of [[20, 55], [5, 10]]) for (const rr of [1.2, 2]) for (const filter of ["none", "trend"]) {
  add("ema", `EMA ${fast}/${slow} ${tf} rr ${rr} ${filter}`, emaCross, { tf, fast, slow, k: 2, rr, filter });
}
add("macd", "EMA 5/10 + MACD D1, stop 2 ATR", macdEma, { stopAtr: 2 });
add("macd", "EMA 5/10 + MACD D1, stop 3 ATR", macdEma, { stopAtr: 3 });
for (const tf of ["H1", "H4", "D1"]) for (const rr of [1, 2]) for (const filter of ["none", "trend"]) add("demarker", `DeMarker 0.3/0.7 ${tf} rr ${rr} ${filter}`, demarker, { tf, rr, filter });
for (const tf of ["H1", "H4", "D1"]) for (const rr of [1, 2]) add("inside", `inside series ${tf} rr ${rr}`, insideSeries, { tf, rr });
for (const tf of ["H1", "H4", "D1"]) for (const entry of ["market", "limit 50%"]) for (const rr of [1, 2]) add("engulf", `engulfing at 20-bar extreme ${tf} ${entry} rr ${rr}`, engulfing, { tf, entry, rr });
for (const tf of ["H1", "H4", "D1"]) for (const rr of [1, 2]) add("pin", `pin bar at 20-bar extreme ${tf} rr ${rr}`, pinBar, { tf, rr });
for (const days of [20, 10]) for (const rr of [1, 2]) for (const plusOne of [false, true]) add("soup", `Turtle Soup ${days} days rr ${rr}${plusOne ? " +1 day" : ""}`, turtleSoup, { days, rr, plusOne });
for (const [name, a, b, c] of [["Asia 01-09, London 09-13", 1, 9, 13], ["London 09-15, New York 15-19", 9, 15, 19]]) {
  add("sweep", `sweep ${name}, to the other side`, sweep, { a, b, c, target: "other side" });
  for (const rr of [1, 2]) add("sweep", `sweep ${name}, rr ${rr}`, sweep, { a, b, c, rr });
  for (const rr of [1, 2]) add("break", `break ${name}, rr ${rr}`, rangeBreak, { a, b, c, rr });
}

// ------------------------------------------------------------------ run
function summary(trades) {
  if (trades.length === 0) return { n: 0, meanR: NaN, t: NaN, pf: NaN };
  const byDay = new Map();
  for (const t of trades) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.r);
  const days = [...byDay.values()], m = mean(days);
  const sd = Math.sqrt(mean(days.map((x) => (x - m) ** 2)) * (days.length / Math.max(1, days.length - 1)));
  const wins = trades.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0), losses = -trades.filter((t) => t.r <= 0).reduce((a, t) => a + t.r, 0);
  return { n: trades.length, meanR: mean(trades.map((t) => t.r)), t: m / (sd / Math.sqrt(days.length)), pf: wins / Math.max(1e-9, losses) };
}
const months = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.44);
console.log(`dev ${FROM} .. ${TO}; R = the stop distance; first part to ${SPLIT}, second part after`);
console.log(`${pad("setup", 52)} ${lpad("n", 6)} ${lpad("/mo", 6)} ${lpad("before", 7)} ${lpad("after", 7)} ${lpad("t", 5)} ${lpad("PF", 5)} | ${lpad("1st", 7)} ${lpad("n", 5)} | ${lpad("2nd", 7)} ${lpad("n", 5)} | pairs+`);
const results = [];
for (const st of setups) {
  if (only !== undefined && st.family !== only) continue;
  const net = [], gross = [];
  for (const symbol of PAIRS) {
    const m = market.get(symbol);
    net.push(...execute(symbol, st.fn(m, st.params), true));
    gross.push(...execute(symbol, st.fn(m, st.params), false));
  }
  const all = summary(net), g = summary(gross), a = summary(net.filter((t) => t.date < SPLIT)), b = summary(net.filter((t) => t.date >= SPLIT));
  const pairsPlus = PAIRS.filter((p) => mean(net.filter((t) => t.symbol === p).map((t) => t.r)) > 0).length;
  results.push({ ...st, all, g, a, b, pairsPlus });
  console.log(`${pad(st.label, 52)} ${lpad(all.n, 6)} ${lpad((all.n / months).toFixed(1), 6)} ${lpad(f(g.meanR), 7)} ${lpad(f(all.meanR), 7)} ${lpad(f(all.t, 1), 5)} ${lpad(Number.isFinite(all.pf) ? all.pf.toFixed(2) : "n/a", 5)} | ${lpad(f(a.meanR), 7)} ${lpad(a.n, 5)} | ${lpad(f(b.meanR), 7)} ${lpad(b.n, 5)} | ${pairsPlus}/${PAIRS.length}`);
}
const plusFirst = results.filter((r) => r.a.meanR > 0);
console.log(`\nsetups ${results.length}; in profit after costs on all of dev: ${results.filter((r) => r.all.meanR > 0).length}; before costs: ${results.filter((r) => r.g.meanR > 0).length}`);
console.log(`in profit on the first part: ${plusFirst.length}; of these still in profit on the second part: ${plusFirst.filter((r) => r.b.meanR > 0).length}`);
