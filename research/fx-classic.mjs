// Chart figures traded by the textbook rules that independent sources agree
// on (TZ 17.26): entry on a candle CLOSE beyond the neckline or the boundary
// of the figure, stop behind the figure, target = the height of the figure
// (the pole for a flag) laid off from the breakout. A second variant waits
// for the return to the broken line (retest). Figures are found on swing
// points with nothing taken from the future (see fx-patterns.mjs).
// The control: a close beyond ANY last swing, stop behind the opposite swing,
// target = the distance between the two - a breakout with the same kind of
// stop and target and no figure.
// Seven dollar pairs, M15 execution, the costs of the project. Dev only.
//
// Usage: node research/fx-classic.mjs [gallery.html]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = (process.env.PAIRS ?? "EURUSD,GBPUSD,USDJPY,AUDUSD,NZDUSD,USDCAD,USDCHF").split(",");
const FROM = "2015-02-02", TO = "2021-12-08", SPLIT = "2019-01-01";
const TFS = ["H1", "H4", "D1"];
const galleryFile = process.argv[2];
const galleryItems = [];
/** For the gallery: the first figure of every kind on the first pair since 2019, whatever its result. */
function firstOfEachType(tfName, list) {
  const seen = new Set();
  for (const c of list.slice().sort((a, b) => a.e - b.e)) {
    if (c.symbol !== PAIRS[0] || c.date < "2019-01-01" || seen.has(c.type)) continue;
    seen.add(c.type);
    galleryItems.push({ tfName, c });
  }
}
const ZIGZAG = 2;       // ATR(14) of pullback that confirms a swing
const NEAR = 0.25;      // "equal" highs or lows: within this share of the figure's height
const WINDOW = 30;      // bars of the figure's timeframe to wait for the breakout
const RETEST = 10;      // bars to wait for the return to the broken line
const LIMIT = { H1: 10 * 96, H4: 30 * 96, D1: 90 * 96 }; // M15 bars a trade may last

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f = (x, d = 3) => (!Number.isFinite(x) ? "  n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a");
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

function spec(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits;
  return {
    symbol, point, pip: point * 10, base: own.usdSide === "base", contract: own.contractSize,
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
    if (k !== key) { bars.push({ date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, first: i, last: i }); key = k; } else {
      const t = bars[bars.length - 1];
      t.h = Math.max(t.h, b.h); t.l = Math.min(t.l, b.l); t.c = b.c; t.last = i;
    }
  });
  return bars;
}
const sma = (xs, n) => { const out = new Array(xs.length).fill(NaN); let s = 0; for (let i = 0; i < xs.length; i++) { s += xs[i]; if (i >= n) s -= xs[i - n]; if (i + 1 >= n) out[i] = s / n; } return out; };
const atr = (bars, n) => sma(bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)))), n);
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

const market = new Map();
for (const symbol of PAIRS) {
  const m15 = loadM15(symbol);
  const tf = { H1: aggregate(m15, (b) => `${b.date} ${b.hour}`), H4: aggregate(m15, (b) => `${b.date} ${Math.floor(b.hour / 4)}`), D1: aggregate(m15, (b) => b.date) };
  const dAtr = atr(tf.D1, 20);
  const day = new Map();
  tf.D1.forEach((b, i) => { if (i > 0) day.set(b.date, dAtr[i - 1]); });
  market.set(symbol, { s: spec(symbol), m15, tf, day, swings: Object.fromEntries(TFS.map((n) => [n, zigzag(tf[n])])) });
}

// ------------------------------------------------------------------ the figures
/** A line through two swings, as a function of the bar index. */
const lineOf = (p, q) => (k) => q.price + ((q.price - p.price) / (q.idx - p.idx)) * (k - q.idx);
const flat = (price) => () => price;
/**
 * Figures completed by the swing just confirmed. Each has one or two `sides`: { dir, line(k) - the
 * price a close has to pass on bar k, stop - behind the figure, height - the target distance }.
 * Written for a figure that ends with a low (a buy or a break down); `v` mirrors it for a high.
 */
function figures(swings, otherStops = false) {
  const out = [];
  for (let n = 5; n < swings.length; n++) {
    const [a, b, c, d, e, g] = [swings[n], swings[n - 1], swings[n - 2], swings[n - 3], swings[n - 4], swings[n - 5]];
    const up = a.type === "L" ? 1 : -1; // the side in which a reversal figure ending here would trade
    const v = (x) => up * x;            // prices mirrored so that the text below reads as for lows
    const push = (type, sides) => out.push({ type, conf: a.conf, swings: [g, e, d, c, b, a], sides: sides.map((s) => ({ ...s, height: Math.abs(s.height) })) });
    const A = v(a.price), B = v(b.price), C = v(c.price), D = v(d.price), E = v(e.price), G = v(g.price);
    // Double bottom: lows C and A near each other, high B between, a fall into C (D well above B).
    {
      const low = Math.min(A, C), h = B - low;
      if (Math.abs(A - C) <= NEAR * h && D - B >= 0.5 * h) push(up > 0 ? "double bottom" : "double top", [{ dir: up, line: flat(b.price), stop: v(otherStops ? low + h / 2 : low), height: h }]);
    }
    // Triple bottom: lows E, C, A near each other; the neckline is the higher of the highs D and B.
    {
      const low = Math.min(A, C, E), neck = Math.max(B, D), h = neck - low;
      if (Math.max(A, C, E) - low <= NEAR * h && Math.abs(B - D) <= 0.5 * h && G - neck >= 0.5 * h) push(up > 0 ? "triple bottom" : "triple top", [{ dir: up, line: flat(v(neck)), stop: v(otherStops ? low + h / 2 : low), height: h }]);
    }
    // Inverse head and shoulders: head C under both shoulders E and A, shoulders near each other; neckline through D and B.
    {
      const neck = Math.max(B, D), h = neck - C;
      if (C < A - 0.2 * h && C < E - 0.2 * h && Math.abs(A - E) <= 0.35 * h && G > neck) {
        push(up > 0 ? "inverse head and shoulders" : "head and shoulders", [{ dir: up, line: lineOf(d, b), stop: otherStops ? c.price : a.price, height: h }]);
      }
    }
    // Flag: a fast pole C -> B, a pullback to A of 20-50% of it; trade in the side of the pole on a close beyond its top.
    {
      const pole = B - C, back = B - A;
      if (b.idx - c.idx <= 30 && pole >= 1.5 * Math.abs(D - C) && back >= 0.2 * pole && back <= 0.5 * pole) push(up > 0 ? "bull flag" : "bear flag", [{ dir: up, line: flat(b.price), stop: a.price, height: pole }]);
    }
    // Triangles and wedges on the last four swings D (high), C (low), B (high), A (low).
    {
      const base = D - C, upper = lineOf(d, b), lower = lineOf(c, a);
      const highsFlat = Math.abs(D - B) <= 0.15 * base, lowsFlat = Math.abs(C - A) <= 0.15 * base;
      const lowsRise = A - C > 0.15 * base, highsFall = D - B > 0.15 * base, highsRise = B - D > 0.15 * base, lowsFall = C - A > 0.15 * base;
      const sideUp = { dir: up, line: upper, stop: a.price, height: base }, sideDown = { dir: -up, line: lower, stop: b.price, height: base };
      // Flat top and rising lows: ascending triangle when the figure ends with a low (descending when mirrored).
      if (highsFlat && lowsRise) push(up > 0 ? "ascending triangle" : "descending triangle", [{ ...sideUp, line: flat(v(Math.max(B, D))) }]);
      // Falling highs and a flat bottom: the mirror case seen from a low.
      if (lowsFlat && highsFall) push(up > 0 ? "descending triangle" : "ascending triangle", [{ ...sideDown, line: flat(v(Math.min(A, C))) }]);
      if (highsFall && lowsRise) push("symmetrical triangle", [sideUp, sideDown]);
      if (highsFlat && lowsFlat) push("rectangle", [{ ...sideUp, line: flat(v(Math.max(B, D))) }, { ...sideDown, line: flat(v(Math.min(A, C))) }]);
      // Wedges: both lines lean the same way and converge; the trade is against the lean.
      const narrowing = Math.abs(B - A) <= 0.8 * base;
      if (highsRise && lowsRise && narrowing) push(up > 0 ? "rising wedge" : "falling wedge", [sideDown]);
      if (highsFall && lowsFall && narrowing) push(up > 0 ? "falling wedge" : "rising wedge", [sideUp]);
    }
  }
  return out;
}

// ------------------------------------------------------------------ the trade
/** One trade from M15 bar `e` (a market order at its open, or a limit order waiting from `e` to `expire`). Result in R. */
function trade(m, tfName, { e, dir, stopPrice, height, limit, stopEntry, expire }, costs) {
  const { s, m15, day } = m;
  const spreadOf = (b) => (costs ? Math.max(b.spread, s.minSpread) * s.point : 0);
  const slip = costs ? s.slip : 0;
  let i = e, entry = NaN;
  if (stopEntry !== undefined) {
    for (; i <= Math.min(expire, m15.length - 1); i++) {
      const b = m15[i], sp = spreadOf(b);
      if (dir > 0 && b.h + sp >= stopEntry) { entry = Math.max(stopEntry, b.o + sp) + slip; break; }
      if (dir < 0 && b.l <= stopEntry) { entry = Math.min(stopEntry, b.o) - slip; break; }
    }
    if (!Number.isFinite(entry)) return null;
  } else if (limit === undefined) {
    if (i >= m15.length) return null;
    entry = dir > 0 ? m15[i].o + spreadOf(m15[i]) + slip : m15[i].o - slip;
  } else {
    for (; i <= Math.min(expire, m15.length - 1); i++) {
      const b = m15[i], sp = spreadOf(b);
      if (dir > 0 && b.l + sp <= limit) { entry = Math.min(limit, b.o + sp) + slip; break; }
      if (dir < 0 && b.h >= limit) { entry = Math.max(limit, b.o) - slip; break; }
    }
    if (!Number.isFinite(entry)) return null;
  }
  const dAtr = day.get(m15[i].date);
  if (!Number.isFinite(dAtr)) return null;
  let dist = dir * (entry - (stopPrice - dir * s.pip));
  if (!(dist > 0)) return null;
  if (dist < 0.1 * dAtr) dist = 0.1 * dAtr;
  // The target is the height of the figure from the line that was broken, as the sources give it.
  const base = limit ?? stopEntry ?? m15[e].o;
  const target = base + dir * height;
  const rr = (dir * (target - entry)) / dist;
  if (!(rr > 0.2)) return null; // the price is already at the target
  const stop = entry - dir * dist;
  let exit = NaN, reason = "", j = i, nights = 0;
  for (; j < m15.length; j++) {
    const b = m15[j], sp = spreadOf(b);
    if (j > i && m15[j].date !== m15[j - 1].date) nights += weekday(m15[j - 1].date) === 3 ? 3 : 1;
    if (j > i && j - i >= LIMIT[tfName]) { exit = dir > 0 ? b.o - slip : b.o + sp + slip; reason = "time"; break; }
    const limitBar = (limit !== undefined || stopEntry !== undefined) && j === i; // on the bar of a limit fill the stop counts if reached, the target does not
    if (dir > 0) {
      if (b.l <= stop) { exit = (limitBar ? stop : Math.min(stop, b.o)) - slip; reason = "stop"; break; }
      if (!limitBar && b.h >= target) { exit = target - slip; reason = "target"; break; }
    } else {
      if (b.h + sp >= stop) { exit = (limitBar ? stop : Math.max(stop, b.o + sp)) + slip; reason = "stop"; break; }
      if (!limitBar && b.l + sp <= target) { exit = target + slip; reason = "target"; break; }
    }
  }
  if (!Number.isFinite(exit)) return null;
  let r = (dir * (exit - entry)) / dist;
  if (costs) {
    const swap = (dir > 0 ? s.swapLong : s.swapShort) * (s.swapRef === null ? 1 : entry / s.swapRef) * nights;
    const commission = s.base ? (s.commission / s.contract) * entry : s.commission / s.contract;
    r += (swap - commission) / dist;
  }
  return { e: i, x: j, r, rr, reason, date: m15[i].date, entry, stop, target };
}
/** The breakout of a figure: the first close of its timeframe beyond a side's line within WINDOW bars; null if the figure is undone first. */
function breakout(m, tfName, fig, touch = false) {
  const bars = m.tf[tfName];
  for (let k = fig.conf + 1; k <= Math.min(fig.conf + WINDOW, bars.length - 2); k++) {
    for (const side of fig.sides) {
      const level = side.line(k);
      if (side.dir * ((touch ? (side.dir > 0 ? bars[k].h : bars[k].l) : bars[k].c) - level) > 0) return { k, side, level };
    }
    // A one-sided figure is undone when a bar closes behind it.
    if (fig.sides.length === 1 && fig.sides[0].dir * (bars[k].c - fig.sides[0].stop) < 0) return null;
  }
  return null;
}
function candidates(symbol, tfName, mode, costs, otherStops = false) {
  const m = market.get(symbol), bars = m.tf[tfName];
  const out = [];
  for (const fig of figures(m.swings[tfName], otherStops)) {
    if (bars[fig.conf].date < FROM) continue;
    const br = breakout(m, tfName, fig, mode === "touch");
    if (br === null) continue;
    if (mode === "touch") {
      const t = trade(m, tfName, { e: bars[br.k].first, dir: br.side.dir, stopPrice: br.side.stop, height: br.side.height, stopEntry: br.level, expire: bars[br.k].last }, costs);
      if (t !== null) out.push({ symbol, type: fig.type, ...t, fig, side: br.side, k: br.k });
      continue;
    }
    const e = bars[br.k].last + 1;
    const order = mode === "break"
      ? { e, dir: br.side.dir, stopPrice: br.side.stop, height: br.side.height }
      : { e, dir: br.side.dir, stopPrice: br.side.stop, height: br.side.height, limit: br.level, expire: bars[Math.min(br.k + RETEST, bars.length - 1)].last };
    // For the plain break the height is laid off from the broken line, not from the fill.
    const t = mode === "break" ? trade(m, tfName, { ...order, height: br.side.height + br.side.dir * (br.level - m.m15[Math.min(e, m.m15.length - 1)].o) }, costs) : trade(m, tfName, order, costs);
    if (t !== null) out.push({ symbol, type: fig.type, ...t, fig, side: br.side, k: br.k });
  }
  return out;
}
/** The control: a close beyond the last swing, stop behind the opposite swing, target = the distance between them. */
function control(symbol, tfName, costs) {
  const m = market.get(symbol), bars = m.tf[tfName], S = m.swings[tfName];
  const out = [];
  for (let n = 1; n < S.length; n++) {
    const a = S[n], b = S[n - 1];
    if (bars[a.conf].date < FROM) continue;
    const dir = a.type === "L" ? 1 : -1; // after a confirmed low: wait for a close above the high before it
    for (let k = a.conf + 1; k <= Math.min(a.conf + WINDOW, bars.length - 2); k++) {
      if (dir * (bars[k].c - a.price) < 0) break;
      if (dir * (bars[k].c - b.price) > 0) {
        const e = bars[k].last + 1, h = Math.abs(b.price - a.price);
        const t = trade(m, tfName, { e, dir, stopPrice: a.price, height: h + dir * (b.price - m.m15[Math.min(e, m.m15.length - 1)].o) }, costs);
        if (t !== null) out.push({ symbol, type: "no figure", ...t });
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ harmonic figures
/**
 * Gartley, Bat, Butterfly and Crab by their Fibonacci ratios (S. Carney's numbers, the ones the
 * sources repeat). Points X, A, B, C are the last four swings; D is not waited for as a swing: a
 * limit order stands at the price where D is due. B = AB / XA, C = BC / AB, D = the share of XA at
 * which the order stands (measured from A), stop = the share of XA where the figure is wrong.
 * The target is 0.382 or 0.618 of the way from D back to A.
 */
const HARMONIC = {
  Gartley: { b: [0.568, 0.668], d: 0.786, stop: 1.0, cd: [1.13, 1.618] },
  Bat: { b: [0.382, 0.5], d: 0.886, stop: 1.0, cd: [1.618, 2.618] },
  Butterfly: { b: [0.736, 0.836], d: 1.27, stop: 1.414, cd: [1.618, 2.24] },
  Crab: { b: [0.382, 0.618], d: 1.618, stop: 2.0, cd: [2.24, 3.618] },
};
function harmonics(symbol, tfName, share, costs) {
  const m = market.get(symbol), bars = m.tf[tfName], S = m.swings[tfName];
  const out = [];
  for (let n = 3; n < S.length; n++) {
    const [c, b, a, x] = [S[n], S[n - 1], S[n - 2], S[n - 3]];
    if (bars[c.conf].date < FROM) continue;
    const dir = c.type === "H" ? 1 : -1; // C is a high: D is a low to buy
    const xa = Math.abs(a.price - x.price), ab = Math.abs(a.price - b.price), bc = Math.abs(c.price - b.price);
    if (!(xa > 0 && ab > 0 && bc > 0)) continue;
    const rb = ab / xa, rc = bc / ab;
    if (rc < 0.382 || rc > 0.886) continue;
    for (const [name, h] of Object.entries(HARMONIC)) {
      if (rb < h.b[0] || rb > h.b[1]) continue;
      const dPrice = a.price - dir * h.d * xa, stopPrice = a.price - dir * h.stop * xa;
      const cd = Math.abs(c.price - dPrice) / bc;
      if (cd < h.cd[0] || cd > h.cd[1]) continue;
      // The order waits until the price passes C (the figure is gone) or the window ends.
      let lastBar = Math.min(c.conf + WINDOW, bars.length - 1);
      for (let k = c.conf + 1; k <= lastBar; k++) if (dir > 0 ? bars[k].h > c.price : bars[k].l < c.price) { lastBar = k - 1; break; }
      if (lastBar <= c.conf) continue;
      const t = trade(m, tfName, { e: bars[c.conf].last + 1, dir, stopPrice, height: share * Math.abs(a.price - dPrice), limit: dPrice, expire: bars[lastBar].last }, costs);
      if (t !== null) out.push({ symbol, type: name, ...t, pts: [x, a, b, c] });
    }
  }
  return out;
}

// ------------------------------------------------------------------ counting
function sequence(cands) {
  const trades = [], free = new Map();
  for (const c of cands.slice().sort((a, b) => a.e - b.e)) {
    if (c.e < (free.get(c.symbol) ?? 0)) continue;
    free.set(c.symbol, c.x);
    trades.push(c);
  }
  return trades;
}
function summary(trades) {
  if (trades.length === 0) return { n: 0 };
  const byWeek = new Map();
  for (const t of trades) { const wk = Math.floor((Date.parse(`${t.date}T00:00:00Z`) / 86400e3 + 3) / 7); byWeek.set(wk, (byWeek.get(wk) ?? 0) + t.r); }
  const w = [...byWeek.values()], mw = mean(w);
  const sd = Math.sqrt(mean(w.map((x) => (x - mw) ** 2)) * (w.length / Math.max(1, w.length - 1)));
  const decided = trades.filter((t) => t.reason !== "time");
  return {
    n: trades.length, meanR: mean(trades.map((t) => t.r)), t: mw / (sd / Math.sqrt(w.length)),
    hit: decided.filter((t) => t.reason === "target").length / Math.max(1, decided.length),
    // The share of targets a coin would reach with the same stops and targets: 1 / (1 + reward to risk).
    coin: mean(decided.map((t) => 1 / (1 + t.rr))), rr: mean(trades.map((t) => t.rr)),
  };
}
const months = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.44);
const TYPES = ["double bottom", "double top", "triple bottom", "triple top", "inverse head and shoulders", "head and shoulders", "bull flag", "bear flag", "ascending triangle", "descending triangle", "symmetrical triangle", "rectangle", "rising wedge", "falling wedge"];
const totals = new Map();
for (const tfName of TFS) {
  console.log(`\n=== figures on ${tfName}; dev ${FROM} .. ${TO}; "hit" = share of trades that reached the target before the stop; "coin" = what a coin would reach with the same stops and targets ===`);
  console.log(`${pad("figure, entry", 44)} ${lpad("n", 6)} ${lpad("/mo", 6)} ${lpad("R:R", 5)} ${lpad("hit", 5)} ${lpad("coin", 5)} ${lpad("before", 7)} ${lpad("after", 7)} ${lpad("t", 5)} | ${lpad("1st", 7)} | ${lpad("2nd", 7)} | pairs+`);
  const row = (label, net, gross) => {
    const tr = sequence(net), all = summary(tr), g = summary(sequence(gross));
    if (all.n === 0) { console.log(`${pad(label, 44)} ${lpad(0, 6)}`); return; }
    const a = summary(tr.filter((t) => t.date < SPLIT)), b = summary(tr.filter((t) => t.date >= SPLIT));
    const pairsPlus = PAIRS.filter((p) => mean(tr.filter((t) => t.symbol === p).map((t) => t.r)) > 0).length;
    console.log(`${pad(label, 44)} ${lpad(all.n, 6)} ${lpad((all.n / months).toFixed(1), 6)} ${lpad(all.rr.toFixed(2), 5)} ${lpad(pct(g.hit), 5)} ${lpad(pct(g.coin), 5)} ${lpad(f(g.meanR), 7)} ${lpad(f(all.meanR), 7)} ${lpad(f(all.t, 1), 5)} | ${lpad(f(a.meanR), 7)} | ${lpad(f(b.meanR), 7)} | ${pairsPlus}/${PAIRS.length}`);
  };
  row("control: break of a swing, no figure", PAIRS.flatMap((p) => control(p, tfName, true)), PAIRS.flatMap((p) => control(p, tfName, false)));
  for (const mode of ["break", "retest"]) {
    const net = PAIRS.flatMap((p) => candidates(p, tfName, mode, true)), gross = PAIRS.flatMap((p) => candidates(p, tfName, mode, false));
    row(`ALL FIGURES, ${mode}`, net, gross);
    for (const type of TYPES) row(`${type}, ${mode}`, net.filter((c) => c.type === type), gross.filter((c) => c.type === type));
    for (const c of net) { const key = `${c.type}|${mode}`; if (!totals.has(key)) totals.set(key, { net: [], gross: [] }); totals.get(key).net.push(c); }
    for (const c of gross) { const key = `${c.type}|${mode}`; totals.get(key)?.gross.push(c); }
    if (tfName === "H4" && mode === "break") firstOfEachType(tfName, net);
  }
  row("ALL FIGURES, entry on a touch of the line", PAIRS.flatMap((p) => candidates(p, tfName, "touch", true)), PAIRS.flatMap((p) => candidates(p, tfName, "touch", false)));
  row("ALL FIGURES, break, the other stops", PAIRS.flatMap((p) => candidates(p, tfName, "break", true, true)), PAIRS.flatMap((p) => candidates(p, tfName, "break", false, true)));
  for (const share of [0.382, 0.618]) {
    const net = PAIRS.flatMap((p) => harmonics(p, tfName, share, true)), gross = PAIRS.flatMap((p) => harmonics(p, tfName, share, false));
    row(`ALL HARMONIC, target ${share} of AD`, net, gross);
    if (tfName === "H1" && share === 0.618) firstOfEachType(tfName, net);
    for (const type of Object.keys(HARMONIC)) row(`${type}, target ${share} of AD`, net.filter((c) => c.type === type), gross.filter((c) => c.type === type));
  }
}
console.log("\n=== every figure over the three timeframes together ===");
console.log(`${pad("figure, entry", 44)} ${lpad("n", 6)} ${lpad("hit", 5)} ${lpad("coin", 5)} ${lpad("before", 7)} ${lpad("after", 7)}`);
for (const [key, v] of totals) {
  const g = summary(v.gross), a = summary(v.net);
  console.log(`${pad(key.replace("|", ", "), 44)} ${lpad(a.n, 6)} ${lpad(pct(g.hit), 5)} ${lpad(pct(g.coin), 5)} ${lpad(f(g.meanR), 7)} ${lpad(f(a.meanR), 7)}`);
}

// ------------------------------------------------------------------ the gallery: every kind of figure as the detector sees it
if (galleryFile !== undefined && galleryItems.length > 0) {
  const NAMES = {
    "double bottom": "Двойное дно", "double top": "Двойная вершина", "triple bottom": "Тройное дно", "triple top": "Тройная вершина",
    "inverse head and shoulders": "Перевёрнутая голова и плечи", "head and shoulders": "Голова и плечи", "bull flag": "Бычий флаг", "bear flag": "Медвежий флаг",
    "ascending triangle": "Восходящий треугольник", "descending triangle": "Нисходящий треугольник", "symmetrical triangle": "Симметричный треугольник",
    rectangle: "Прямоугольник", "rising wedge": "Восходящий клин", "falling wedge": "Нисходящий клин",
    Gartley: "Гартли", Bat: "Летучая мышь", Butterfly: "Бабочка", Crab: "Краб",
  };
  const POINTS = { double: 4, triple: 6, head: 6, flag: 3 };
  const pointsOf = (type) => POINTS[Object.keys(POINTS).find((k) => type.includes(k))] ?? 4;
  const ENDS = { stop: "стоп", target: "цель достигнута", time: "закрыта по сроку" };
  const cards = galleryItems.map(({ tfName, c }) => {
    const m = market.get(c.symbol), bars = m.tf[tfName];
    const barAt = (i) => { let lo = 0, hi = bars.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].last < i) lo = mid + 1; else hi = mid; } return lo; };
    const shape = c.fig ? c.fig.swings.slice(-pointsOf(c.type)) : c.pts;
    const entryBar = barAt(c.e), exitBar = barAt(c.x);
    const from = Math.max(0, shape[0].idx - 8), to = Math.min(bars.length - 1, Math.min(from + 170, Math.max(exitBar + 5, entryBar + 12)));
    const view = bars.slice(from, to + 1);
    const W = 760, H = 300, padL = 8, padR = 64;
    const top = Math.max(...view.map((b) => b.h), c.target, c.stop), bottom = Math.min(...view.map((b) => b.l), c.target, c.stop);
    const x = (i) => padL + ((i - from + 0.5) * (W - padL - padR)) / view.length, y = (p) => 12 + ((top - p) * (H - 24)) / (top - bottom);
    const bw = Math.max(1.5, ((W - padL - padR) / view.length) * 0.6);
    const candles = view.map((b, n) => { const i = from + n, up = b.c >= b.o; return `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" class="${up ? "up" : "dn"}"/><rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y(Math.max(b.o, b.c)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y(b.o) - y(b.c))).toFixed(1)}" class="${up ? "upf" : "dnf"}"/>`; }).join("");
    const pts = shape.map((s) => [s.idx, s.price]);
    if (c.pts) pts.push([entryBar, c.entry]);
    const poly = pts.map(([i, p]) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(" ");
    const letters = c.pts ? ["X", "A", "B", "C", "D"] : [];
    const dots = pts.map(([i, p], n) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p).toFixed(1)}" r="4" class="dot"/>${letters[n] ? `<text x="${(x(i) + 6).toFixed(1)}" y="${(y(p) - 6).toFixed(1)}" class="lbl">${letters[n]}</text>` : ""}`).join("");
    // The line whose break is the entry: the neckline or the boundary of the figure.
    const neck = c.side ? `<line x1="${x(shape[0].idx).toFixed(1)}" y1="${y(c.side.line(shape[0].idx)).toFixed(1)}" x2="${x(c.k).toFixed(1)}" y2="${y(c.side.line(c.k)).toFixed(1)}" class="neck"/>` : "";
    const hline = (p, cls, label) => `<line x1="${x(entryBar).toFixed(1)}" x2="${W - padR}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" class="${cls}"/><text x="${W - padR + 4}" y="${(y(p) + 4).toFixed(1)}" class="lbl">${label}</text>`;
    const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${NAMES[c.type]}">${candles}${neck}<polyline points="${poly}" class="fig"/>${dots}<line x1="${x(entryBar).toFixed(1)}" x2="${x(entryBar).toFixed(1)}" y1="12" y2="${H - 12}" class="entry"/>${hline(c.entry, "ent", "вход")}${hline(c.stop, "stp", "стоп")}${hline(c.target, "tp", "цель")}</svg>`;
    const dir = (c.side ? c.side.dir : Math.sign(c.target - c.entry)) > 0 ? "Покупка" : "Продажа";
    return `<section><h2>${NAMES[c.type]} — ${c.symbol}, ${tfName}, ${c.date}</h2><p>${dir}. Цель в ${c.rr.toFixed(1)} раза ${c.rr >= 1 ? "дальше" : "от"} стопа. Итог: ${ENDS[c.reason]} (${f(c.r, 2)} R после издержек).</p>${svg}</section>`;
  }).join("\n");
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Фигуры по правилам источников</title><style>
:root{--bg:#fff;--fg:#1c1c1c;--mut:#6b6b6b;--up:#1a8f5a;--dn:#c0392b;--fig:#2456c7;--line:#888;--neck:#b8860b}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#a0a0a0;--up:#3fbf85;--dn:#e06c5c;--fig:#7aa2ff;--line:#999;--neck:#e0b040}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:820px;margin-inline:auto}
h1{font-size:22px}h2{font-size:17px;margin:28px 0 4px}p{margin:4px 0 8px;color:var(--mut)}svg{width:100%;height:auto;display:block}
.up{stroke:var(--up)}.dn{stroke:var(--dn)}.upf{fill:var(--up)}.dnf{fill:var(--dn)}.fig{fill:none;stroke:var(--fig);stroke-width:2}.dot{fill:var(--fig)}
.neck{stroke:var(--neck);stroke-width:2}.entry{stroke:var(--line);stroke-dasharray:4 4}.ent{stroke:var(--fg)}.stp{stroke:var(--dn);stroke-dasharray:6 3}.tp{stroke:var(--up);stroke-dasharray:6 3}.lbl{fill:var(--fg);font-size:12px}
</style></head><body><h1>Фигуры по правилам, в которых сходятся источники</h1><p>Синяя ломаная — точки разворота, из которых сложена фигура. Жёлтая линия — линия шеи или граница: закрытие свечи за ней и есть вход (вертикальный пунктир). Стоп — за фигурой, цель — высота фигуры от линии пробоя (у флага — длина древка). У гармонических фигур вход стоит лимитным ордером в точке D. Для каждого вида взят первый по порядку пример с 2019 года на EURUSD, без отбора по результату.</p>${cards}</body></html>`;
  mkdirSync(path.dirname(galleryFile), { recursive: true });
  writeFileSync(galleryFile, html);
  console.log(`\ngallery of ${galleryItems.length} figures written to ${galleryFile}`);
}
