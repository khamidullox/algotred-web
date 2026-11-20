// The customer's five-step entry model, written as mechanical rules (TZ 17.25):
//   1. a chart figure is found and gives a side: double bottom / top, head and
//      shoulders, flag (impulse and shallow pullback), contracting triangle;
//   2. it is labelled as going with the trend of the higher timeframe or against it;
//   3. there is a level of the higher timeframe ahead for the price to go to;
//   4. the entry is a break of structure on the lower timeframe;
//   5. an engulfing candle at the last point of the figure is noted.
// Stop behind the nearest swing of the lower timeframe; half is closed at 1:1
// and the stop goes to the entry; the rest goes to the target and is closed
// earlier if the lower timeframe breaks its structure the other way.
// The control takes every break of structure with no figure at all, with the
// same stop and the same management: it shows what the figure itself adds.
// Seven dollar pairs, M15 execution, the costs of the project. Dev only.
//
// Usage: node research/fx-patterns.mjs [gallery.html]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = (process.env.PAIRS ?? "EURUSD,GBPUSD,USDJPY,AUDUSD,NZDUSD,USDCAD,USDCHF").split(",");
const FROM = "2015-02-02", TO = "2021-12-08", SPLIT = "2019-01-01";
const galleryFile = process.argv[2];
/** Two sizes of the same model: figures on H1 entered on M15, figures on H4 entered on H1. */
const SCALES = [
  { name: "figures H1, entry M15", tf: "H1", entry: "M15", higher: "H4", window: 64, limitBars: 5 * 96 },
  { name: "figures H4, entry H1", tf: "H4", entry: "H1", higher: "D1", window: 64, limitBars: 15 * 96 },
];
const ZIGZAG = 2; // a swing is confirmed when the price has come back by this many ATR(14) of its timeframe

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
    symbol, point, pip: point * 10, base: own.usdSide === "base", contract: own.contractSize, digits: own.digits,
    minSpread: own.minSpreadPoints ?? config.costs.minSpreadPoints,
    slip: config.costs.slippagePips * point * 10,
    commission: own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip,
    swapLong: own.swapLongPips * point * 10, swapShort: own.swapShortPips * point * 10, swapRef: own.swapReferencePrice ?? null,
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
    rows.push({ date, hour: +p[1].slice(0, 2), o: +p[2], h: +p[3], l: +p[4], c: +p[5], spread: +p[8] });
  }
  return rows;
}
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
const sma = (xs, n) => { const out = new Array(xs.length).fill(NaN); let s = 0; for (let i = 0; i < xs.length; i++) { s += xs[i]; if (i >= n) s -= xs[i - n]; if (i + 1 >= n) out[i] = s / n; } return out; };
function ema(xs, n) {
  const out = new Array(xs.length).fill(NaN), k = 2 / (n + 1);
  let v = NaN;
  for (let i = 0; i < xs.length; i++) { v = i === 0 ? xs[0] : xs[i] * k + v * (1 - k); if (i + 1 >= n) out[i] = v; }
  return out;
}
const atr = (bars, n) => sma(bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)))), n);

/**
 * Swings of a timeframe with nothing taken from the future: a high becomes a swing on the bar
 * whose close is `ZIGZAG` ATRs under it (`conf`), a low the same way. Swings alternate.
 */
function zigzag(bars) {
  const av = atr(bars, 14);
  const swings = [];
  let dir = 0, hi = -Infinity, hiIdx = -1, lo = Infinity, loIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], thr = ZIGZAG * av[i];
    if (dir >= 0 && b.h > hi) { hi = b.h; hiIdx = i; }
    if (dir <= 0 && b.l < lo) { lo = b.l; loIdx = i; }
    if (!Number.isFinite(thr)) continue;
    if (dir >= 0 && hiIdx >= 0 && hiIdx < i && hi - b.c >= thr) {
      swings.push({ type: "H", idx: hiIdx, price: hi, conf: i });
      dir = -1; lo = Infinity;
      for (let j = hiIdx + 1; j <= i; j++) if (bars[j].l < lo) { lo = bars[j].l; loIdx = j; }
    } else if (dir <= 0 && loIdx >= 0 && loIdx < i && b.c - lo >= thr) {
      swings.push({ type: "L", idx: loIdx, price: lo, conf: i });
      dir = 1; hi = -Infinity;
      for (let j = loIdx + 1; j <= i; j++) if (bars[j].h > hi) { hi = bars[j].h; hiIdx = j; }
    }
  }
  return swings;
}
/** For every bar: the price of the last swing high and low already confirmed on that bar. */
function lastSwings(bars, swings) {
  const hi = new Array(bars.length).fill(NaN), lo = new Array(bars.length).fill(NaN);
  let n = 0, h = NaN, l = NaN;
  const byConf = swings.slice().sort((a, b) => a.conf - b.conf);
  for (let i = 0; i < bars.length; i++) {
    while (n < byConf.length && byConf[n].conf <= i) { if (byConf[n].type === "H") h = byConf[n].price; else l = byConf[n].price; n++; }
    hi[i] = h; lo[i] = l;
  }
  return { hi, lo };
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
  const swings = {}, last = {}, trend = {};
  for (const name of Object.keys(tf)) {
    swings[name] = zigzag(tf[name]);
    last[name] = lastSwings(tf[name], swings[name]);
    const e = ema(tf[name].map((b) => b.c), 50);
    trend[name] = tf[name].map((b, i) => (Number.isFinite(e[i]) ? Math.sign(b.c - e[i]) : 0));
  }
  const dAtr = atr(tf.D1, 20);
  const day = new Map();
  tf.D1.forEach((b, i) => { if (i > 0) day.set(b.date, dAtr[i - 1]); });
  // Which bar of a timeframe closes on a given M15 bar, and which is the last one closed before it.
  const closedBefore = {};
  for (const name of Object.keys(tf)) {
    const arr = new Int32Array(m15.length).fill(-1);
    let k = -1;
    for (let i = 0; i < m15.length; i++) { while (k + 1 < tf[name].length && tf[name][k + 1].last < i) k++; arr[i] = k; }
    closedBefore[name] = arr;
  }
  market.set(symbol, { s: spec(symbol), m15, tf, swings, last, trend, day, closedBefore });
}

// ------------------------------------------------------------------ step 1: the figures
/** Figures completed by the swing that has just been confirmed. Prices and sides only; nothing about the entry yet. */
function figures(m, tfName) {
  const S = m.swings[tfName];
  const out = [];
  for (let n = 4; n < S.length; n++) {
    const a = S[n], b = S[n - 1], c = S[n - 2], d = S[n - 3], e = S[n - 4];
    const dir = a.type === "L" ? 1 : -1; // a low has just formed: the figure may be a buy
    const below = (x, y) => dir * (x - y) < 0; // "x is lower than y" for a buy, mirrored for a sell
    const add = (type, kind, fields) => out.push({ type, kind, dir, conf: a.conf, swings: fields.swings, edge: fields.edge, trigger: fields.trigger });
    // Double bottom: two lows near each other, a high between them, a fall before the first low.
    {
      const height = Math.abs(b.price - (below(a.price, c.price) ? a.price : c.price));
      if (Math.abs(a.price - c.price) <= 0.25 * height && dir * (d.price - b.price) >= 0.5 * height) {
        add(dir > 0 ? "double bottom" : "double top", "reversal", { swings: [d, c, b, a], edge: below(a.price, c.price) ? a.price : c.price, trigger: b.price });
      }
    }
    // Head and shoulders (inverse for a buy): the middle low is the lowest, the two outer ones are near each other.
    {
      const neck = dir > 0 ? Math.max(b.price, d.price) : Math.min(b.price, d.price);
      const height = Math.abs(neck - c.price);
      if (below(c.price, a.price - dir * 0.2 * height) && below(c.price, e.price - dir * 0.2 * height) && Math.abs(a.price - e.price) <= 0.35 * height) {
        add(dir > 0 ? "inverse head and shoulders" : "head and shoulders", "reversal", { swings: [e, d, c, b, a], edge: a.price, trigger: neck });
      }
    }
    // Flag: a fast leg of at least 3 swing thresholds in at most 30 bars, then a pullback of 20-50% of it.
    {
      const leg = Math.abs(b.price - c.price), back = Math.abs(b.price - a.price);
      const fast = b.idx - c.idx <= 30 && leg >= 1.5 * Math.abs(c.price - d.price);
      if (fast && back >= 0.2 * leg && back <= 0.5 * leg) add(dir > 0 ? "bull flag" : "bear flag", "continuation", { swings: [c, b, a], edge: a.price, trigger: b.price });
    }
    // Contracting triangle: a lower high and a higher low. The side is the one of the last swing (a higher low: buy).
    {
      if (below(c.price, a.price) && dir * (d.price - b.price) > 0 && Math.abs(b.price - a.price) <= 0.8 * Math.abs(d.price - c.price)) {
        add("triangle", "continuation", { swings: [d, c, b, a], edge: a.price, trigger: b.price });
      }
    }
  }
  return out;
}
/** An engulfing candle in the side of the figure on its last point or one of the three bars after it. */
function engulfedAt(bars, idx, dir) {
  for (let j = Math.max(1, idx); j <= Math.min(idx + 3, bars.length - 1); j++) {
    const p = bars[j - 1], b = bars[j];
    if (dir > 0 && p.c < p.o && b.c > b.o && b.c >= p.o && b.o <= p.c) return true;
    if (dir < 0 && p.c > p.o && b.c < b.o && b.c <= p.o && b.o >= p.c) return true;
  }
  return false;
}

// ------------------------------------------------------------------ steps 3-4 and the trade
/**
 * The trade from M15 bar `e`: half off at 1:1 with the stop to the entry, the rest at `target`, or on a
 * break of the entry timeframe's structure against the trade (only after the first half is taken), or at
 * the stop, or after `limitBars`. Within a bar the stop is taken before any profit. Result in R.
 */
function trade(m, scale, e, dir, stopPrice, targetR, levelPrice, costs) {
  const { s, m15, day, tf, last, closedBefore } = m;
  if (e >= m15.length) return null;
  const spreadOf = (b) => (costs ? Math.max(b.spread, s.minSpread) * s.point : 0);
  const slip = costs ? s.slip : 0;
  const dAtr = day.get(m15[e].date);
  if (!Number.isFinite(dAtr)) return null;
  const b0 = m15[e];
  const entry = dir > 0 ? b0.o + spreadOf(b0) + slip : b0.o - slip;
  let dist = dir * (entry - stopPrice);
  if (!(dist > 0)) return null;
  if (dist > dAtr) return null; // a stop further than a day's range is not a stop of this model
  if (dist < 0.1 * dAtr) dist = 0.1 * dAtr;
  const stop0 = entry - dir * dist;
  const tp1 = entry + dir * dist;
  const target = levelPrice ?? entry + dir * targetR * dist;
  const eb = tf[scale.entry], ls = last[scale.entry], cb = closedBefore[scale.entry];
  let stop = stop0, half = false, r = 0, open = 1, reason = "", j = e, nights = 0;
  const close = (price, share) => { r += share * (dir * (price - entry)) / dist; open -= share; };
  for (; j < m15.length; j++) {
    const b = m15[j], sp = spreadOf(b);
    if (j > e && m15[j].date !== m15[j - 1].date) nights += open * (weekday(m15[j - 1].date) === 3 ? 3 : 1);
    if (j > e) {
      if (j - e >= scale.limitBars) { close(dir > 0 ? b.o - slip : b.o + sp + slip, open); reason = "time"; break; }
      // The entry timeframe has just closed a bar beyond its last swing against the trade: out with the rest.
      const k = cb[j];
      if (half && k >= 0 && eb[k].last === j - 1) {
        const against = dir > 0 ? eb[k].c < ls.lo[k] : eb[k].c > ls.hi[k];
        if (against) { close(dir > 0 ? b.o - slip : b.o + sp + slip, open); reason = "structure"; break; }
      }
    }
    if (dir > 0) {
      if (b.l <= stop) { close(Math.min(stop, b.o) - slip, open); reason = half ? "breakeven" : "stop"; break; }
      if (!half && b.h >= tp1) { close(tp1 - slip, 0.5); half = true; stop = entry; }
      if (half && b.h >= target) { close(target - slip, open); reason = "target"; break; }
    } else {
      if (b.h + sp >= stop) { close(Math.max(stop, b.o + sp) + slip, open); reason = half ? "breakeven" : "stop"; break; }
      if (!half && b.l + sp <= tp1) { close(tp1 + slip, 0.5); half = true; stop = entry; }
      if (half && b.l + sp <= target) { close(target + slip, open); reason = "target"; break; }
    }
  }
  if (open > 1e-9) return null; // the data ended with the position open
  if (costs) {
    const swap = (dir > 0 ? s.swapLong : s.swapShort) * (s.swapRef === null ? 1 : entry / s.swapRef) * nights;
    const commission = s.base ? (s.commission / s.contract) * entry : s.commission / s.contract;
    r += (swap - commission) / dist;
  }
  return { e, x: j, r, reason, half, entry, stop: stop0, target, tp1, date: m15[e].date };
}

/** Step 4 for one figure: the first break of structure of the entry timeframe in its side; null if the figure is undone first. */
function findEntry(m, scale, fig) {
  const pb = m.tf[scale.tf], eb = m.tf[scale.entry], ls = m.last[scale.entry];
  const t0 = pb[fig.conf].last + 1;
  if (t0 >= m.m15.length) return null;
  let k = m.closedBefore[scale.entry][t0] + 1;
  for (let n = 0; n < scale.window && k < eb.length; n++, k++) {
    const b = eb[k];
    if (fig.dir > 0 ? b.l < fig.edge : b.h > fig.edge) return null; // the figure is broken
    const level = fig.dir > 0 ? ls.hi[k] : ls.lo[k];
    if (!Number.isFinite(level) || k === 0) continue;
    const broke = fig.dir > 0 ? b.c > level && eb[k - 1].c <= level : b.c < level && eb[k - 1].c >= level;
    if (!broke) continue;
    const near = fig.dir > 0 ? ls.lo[k] : ls.hi[k]; // the nearest swing behind the entry
    const stopLevel = Number.isFinite(near) && fig.dir * (b.c - near) > 0 ? near : fig.edge;
    return { e: b.last + 1, k, stop: stopLevel - fig.dir * m.s.pip };
  }
  return null;
}
/** Step 3: the nearest swing of the higher timeframe ahead of the entry, between 1.5 and 6 stop distances away. */
function levelAhead(m, scale, e, dir, entryPrice, dist) {
  const hb = m.tf[scale.higher], hs = m.swings[scale.higher];
  let best = null, seen = 0;
  for (let n = hs.length - 1; n >= 0 && seen < 12; n--) {
    const sw = hs[n];
    if (hb[sw.conf].last + 1 > e) continue;
    seen++;
    if (sw.type !== (dir > 0 ? "H" : "L")) continue;
    const away = dir * (sw.price - entryPrice);
    if (away >= 1.5 * dist && away <= 6 * dist && (best === null || away < dir * (best - entryPrice))) best = sw.price;
  }
  return best;
}

function candidates(symbol, scale, costs) {
  const m = market.get(symbol), pb = m.tf[scale.tf];
  const out = [];
  for (const fig of figures(m, scale.tf)) {
    if (pb[fig.conf].date < FROM) continue;
    const en = findEntry(m, scale, fig);
    if (en === null) continue;
    const plain = trade(m, scale, en.e, fig.dir, en.stop, 2, null, costs);
    if (plain === null) continue;
    const level = levelAhead(m, scale, en.e, fig.dir, plain.entry, Math.abs(plain.entry - plain.stop));
    const toLevel = level === null ? null : trade(m, scale, en.e, fig.dir, en.stop, 2, level, costs);
    const hk = m.closedBefore[scale.higher][en.e];
    out.push({
      symbol, fig, type: fig.type, kind: fig.kind, dir: fig.dir, e: en.e, date: plain.date,
      withTrend: hk >= 0 && m.trend[scale.higher][hk] === fig.dir, engulf: engulfedAt(pb, fig.swings.at(-1).idx, fig.dir),
      hasLevel: toLevel !== null, plain, toLevel,
    });
  }
  return out;
}
/** The control: every break of structure of the entry timeframe, no figure, the same stop and management. */
function controlCandidates(symbol, scale, costs) {
  const m = market.get(symbol), eb = m.tf[scale.entry], ls = m.last[scale.entry];
  const out = [];
  for (let k = 1; k < eb.length; k++) {
    if (eb[k].date < FROM) continue;
    for (const dir of [1, -1]) {
      const level = dir > 0 ? ls.hi[k] : ls.lo[k], near = dir > 0 ? ls.lo[k] : ls.hi[k];
      if (!Number.isFinite(level) || !Number.isFinite(near)) continue;
      const broke = dir > 0 ? eb[k].c > level && eb[k - 1].c <= level : eb[k].c < level && eb[k - 1].c >= level;
      if (!broke || !(dir * (eb[k].c - near) > 0)) continue;
      const t = trade(m, scale, eb[k].last + 1, dir, near - dir * m.s.pip, 2, null, costs);
      if (t === null) continue;
      const hk = m.closedBefore[scale.higher][t.e];
      out.push({ symbol, type: "no figure", dir, e: t.e, date: t.date, withTrend: hk >= 0 && m.trend[scale.higher][hk] === dir, engulf: false, hasLevel: false, plain: t, toLevel: null });
    }
  }
  return out;
}

// ------------------------------------------------------------------ counting
/** One position per pair: candidates in time order, a new one only after the previous trade is closed. */
function sequence(cands, pick) {
  const trades = [];
  const free = new Map();
  for (const c of cands.slice().sort((a, b) => a.e - b.e)) {
    const t = pick(c);
    if (t === null || t === undefined) continue;
    if (c.e < (free.get(c.symbol) ?? 0)) continue;
    free.set(c.symbol, t.x);
    trades.push({ symbol: c.symbol, date: c.date, r: t.r, reason: t.reason });
  }
  return trades;
}
function summary(trades) {
  if (trades.length === 0) return { n: 0, meanR: NaN, t: NaN, pf: NaN, win: NaN };
  const byWeek = new Map();
  for (const t of trades) { const wk = Math.floor((Date.parse(`${t.date}T00:00:00Z`) / 86400e3 + 3) / 7); byWeek.set(wk, (byWeek.get(wk) ?? 0) + t.r); }
  const w = [...byWeek.values()], mw = mean(w);
  const sd = Math.sqrt(mean(w.map((x) => (x - mw) ** 2)) * (w.length / Math.max(1, w.length - 1)));
  const wins = trades.filter((t) => t.r > 0).reduce((a, t) => a + t.r, 0), losses = -trades.filter((t) => t.r <= 0).reduce((a, t) => a + t.r, 0);
  return { n: trades.length, meanR: mean(trades.map((t) => t.r)), t: mw / (sd / Math.sqrt(w.length)), pf: wins / Math.max(1e-9, losses), win: trades.filter((t) => t.r > 0).length / trades.length };
}
const months = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.44);
const gallery = [];

for (const scale of SCALES) {
  const net = PAIRS.flatMap((p) => candidates(p, scale, true)), gross = PAIRS.flatMap((p) => candidates(p, scale, false));
  const cNet = PAIRS.flatMap((p) => controlCandidates(p, scale, true)), cGross = PAIRS.flatMap((p) => controlCandidates(p, scale, false));
  console.log(`\n=== ${scale.name}; dev ${FROM} .. ${TO}; R = the stop distance; t counts weeks ===`);
  console.log(`${pad("what is required", 58)} ${lpad("n", 6)} ${lpad("/mo", 6)} ${lpad("before", 7)} ${lpad("after", 7)} ${lpad("t", 5)} ${lpad("PF", 5)} ${lpad("wins", 5)} | ${lpad("1st", 7)} | ${lpad("2nd", 7)} | pairs+`);
  const row = (label, n, g, test, pick) => {
    const tr = sequence(n.filter(test), pick), tg = sequence(g.filter(test), pick);
    const all = summary(tr), gs = summary(tg), a = summary(tr.filter((t) => t.date < SPLIT)), b = summary(tr.filter((t) => t.date >= SPLIT));
    const pairsPlus = PAIRS.filter((p) => mean(tr.filter((t) => t.symbol === p).map((t) => t.r)) > 0).length;
    console.log(`${pad(label, 58)} ${lpad(all.n, 6)} ${lpad((all.n / months).toFixed(1), 6)} ${lpad(f(gs.meanR), 7)} ${lpad(f(all.meanR), 7)} ${lpad(f(all.t, 1), 5)} ${lpad(Number.isFinite(all.pf) ? all.pf.toFixed(2) : "n/a", 5)} ${lpad(Number.isFinite(all.win) ? `${(all.win * 100).toFixed(0)}%` : "n/a", 5)} | ${lpad(f(a.meanR), 7)} | ${lpad(f(b.meanR), 7)} | ${pairsPlus}/${PAIRS.length}`);
  };
  const plain = (c) => c.plain, toLevel = (c) => c.toLevel;
  row("control: break of structure, no figure", cNet, cGross, () => true, plain);
  row("control, with the higher trend only", cNet, cGross, (c) => c.withTrend, plain);
  row("any figure + break of structure (steps 1, 4)", net, gross, () => true, plain);
  row("  + with the higher trend (step 2)", net, gross, (c) => c.withTrend, plain);
  row("  + against the higher trend", net, gross, (c) => !c.withTrend, plain);
  row("  + a level ahead as the target (step 3)", net, gross, (c) => c.hasLevel, toLevel);
  row("  + engulfing at the last point (step 5)", net, gross, (c) => c.engulf, plain);
  row("  all five steps together", net, gross, (c) => c.withTrend && c.hasLevel && c.engulf, toLevel);
  row("  steps 1-4 (trend, level, no engulfing demanded)", net, gross, (c) => c.withTrend && c.hasLevel, toLevel);
  for (const type of ["double bottom", "double top", "inverse head and shoulders", "head and shoulders", "bull flag", "bear flag", "triangle"]) {
    row(`${type}: steps 1, 4`, net, gross, (c) => c.type === type, plain);
    row(`${type}: steps 1-4`, net, gross, (c) => c.type === type && c.withTrend && c.hasLevel, toLevel);
  }
  const reasons = {};
  for (const t of sequence(net, plain)) reasons[t.reason] = (reasons[t.reason] ?? 0) + 1;
  console.log(`how the trades of "any figure" ended: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (scale === SCALES[0]) for (const type of ["double bottom", "head and shoulders", "bull flag", "triangle"]) gallery.push(...net.filter((c) => c.symbol === PAIRS[0] && c.type === type && c.date >= "2019-01-01").slice(0, 2).map((c) => ({ ...c, scale })));
}

// ------------------------------------------------------------------ the gallery: what the detector calls a figure
if (galleryFile !== undefined && gallery.length > 0) {
  const cards = gallery.map((c) => {
    const m = market.get(c.symbol), bars = m.tf[c.scale.tf], t = c.plain;
    const from = Math.max(0, c.fig.swings[0].idx - 10), exitBar = m.closedBefore[c.scale.tf][t.x] + 1;
    const to = Math.min(bars.length - 1, Math.max(exitBar + 4, c.fig.conf + 14));
    const view = bars.slice(from, to + 1);
    const W = 760, H = 300, padL = 8, padR = 70, top = Math.max(...view.map((b) => b.h), t.target, t.stop), bottom = Math.min(...view.map((b) => b.l), t.target, t.stop);
    const x = (i) => padL + ((i - from + 0.5) * (W - padL - padR)) / view.length, y = (p) => 12 + ((top - p) * (H - 24)) / (top - bottom);
    const bw = Math.max(2, ((W - padL - padR) / view.length) * 0.6);
    const candles = view.map((b, n) => { const i = from + n, up = b.c >= b.o; return `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" class="${up ? "up" : "dn"}"/><rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y(Math.max(b.o, b.c)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y(b.o) - y(b.c))).toFixed(1)}" class="${up ? "upf" : "dnf"}"/>`; }).join("");
    const poly = c.fig.swings.map((s) => `${x(s.idx).toFixed(1)},${y(s.price).toFixed(1)}`).join(" ");
    const dots = c.fig.swings.map((s) => `<circle cx="${x(s.idx).toFixed(1)}" cy="${y(s.price).toFixed(1)}" r="4" class="dot"/>`).join("");
    const entryIdx = m.closedBefore[c.scale.tf][t.e] + 1;
    const hline = (p, cls, label) => `<line x1="${x(entryIdx).toFixed(1)}" x2="${W - padR}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" class="${cls}"/><text x="${W - padR + 4}" y="${(y(p) + 4).toFixed(1)}" class="lbl">${label}</text>`;
    const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${c.type}">${candles}<polyline points="${poly}" class="fig"/>${dots}<line x1="${x(entryIdx).toFixed(1)}" x2="${x(entryIdx).toFixed(1)}" y1="12" y2="${H - 12}" class="entry"/>${hline(t.entry, "ent", "вход")}${hline(t.stop, "stp", "стоп")}${hline(t.tp1, "tp", "1:1")}${hline(t.target, "tp", "цель")}</svg>`;
    const names = { "double bottom": "Двойное дно", "head and shoulders": "Голова и плечи", "bull flag": "Флаг (импульс и откат)", triangle: "Сужающийся треугольник" };
    const ends = { stop: "стоп", breakeven: "половина на 1:1, остаток в безубыток", target: "половина на 1:1, остаток на цели", structure: "половина на 1:1, остаток закрыт по слому структуры", time: "закрыта по сроку" };
    return `<section><h2>${names[c.type] ?? c.type} — ${c.symbol}, ${c.date}</h2><p>${c.dir > 0 ? "Покупка" : "Продажа"}. ${c.withTrend ? "По тренду H4" : "Против тренда H4"}; поглощение у последней точки: ${c.engulf ? "есть" : "нет"}; уровень H4 впереди: ${c.hasLevel ? "есть" : "нет"}. Итог: ${ends[t.reason]} (${f(t.r, 2)} R после издержек).</p>${svg}</section>`;
  }).join("\n");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Фигуры на графике</title><style>
:root{--bg:#fff;--fg:#1c1c1c;--mut:#6b6b6b;--up:#1a8f5a;--dn:#c0392b;--fig:#2456c7;--line:#888}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#a0a0a0;--up:#3fbf85;--dn:#e06c5c;--fig:#7aa2ff;--line:#999}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:820px;margin-inline:auto}
h1{font-size:22px}h2{font-size:17px;margin:28px 0 4px}p{margin:4px 0 8px;color:var(--mut)}svg{width:100%;height:auto;display:block}
.up{stroke:var(--up)}.dn{stroke:var(--dn)}.upf{fill:var(--up)}.dnf{fill:var(--dn)}.fig{fill:none;stroke:var(--fig);stroke-width:2}.dot{fill:var(--fig)}
.entry{stroke:var(--line);stroke-dasharray:4 4}.ent{stroke:var(--fg)}.stp{stroke:var(--dn);stroke-dasharray:6 3}.tp{stroke:var(--up);stroke-dasharray:6 3}.lbl{fill:var(--fg);font-size:12px}
</style></head><body><h1>Как программа видит фигуры</h1><p>Свечи H1. Синяя ломаная — точки разворота, из которых сложена фигура. Вертикальная пунктирная линия — момент входа (слом структуры на M15). Это первые по порядку примеры с 2019 года, без отбора по результату: среди них есть и убыточные.</p>${cards}</body></html>`;
  mkdirSync(path.dirname(galleryFile), { recursive: true });
  writeFileSync(galleryFile, html);
  console.log(`\ngallery of ${gallery.length} figures written to ${galleryFile}`);
}
