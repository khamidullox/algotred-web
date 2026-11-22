// The customer's own entries around a trendline (TZ 17.35), from their video
// lesson of 2026-11-22. Lines on H1, execution on M15, seven dollar pairs.
// Everything below is said for an uptrend and mirrored for a downtrend.
//
// Swings: a low becomes a swing on the bar that closes 2 ATR(14) above it.
// Line:   a run of rising swing lows of H1; from every low of the run but the
//         last a line goes through the later low that gives the smallest
//         slope, so every later low is on the line or above it. The line from
//         the first low is the "global" one, the later ones are steeper,
//         "local". A low within 0.25 ATR of the line is a touch.
// Break:  an H1 close more than 0.1 ATR below the line. Break of structure:
//         an H1 close below the last low of the run within 24 bars of it.
//
// Entry 1 (against the old trend): after the break alone or the break with
//         the break of structure; at once (next M15 open) or on the retest
//         (a limit order on the line, waiting 24 H1 bars). Stop one pip
//         beyond the highest high since the line began.
// Entry 2 (with the trend): M15 comes within 0.25 ATR of a living line and
//         within 32 M15 bars closes above its last M15 swing high. Stop one
//         pip beyond the low of the last 32 M15 bars.
// Take 1:1 and 1:1.5, the whole position, no breakeven. One position a pair.
// The control has the same entry, stop and take with no line at all.
//
// Usage: node research/fx-trendline.mjs [gallery.html]              dev
//        node research/fx-trendline.mjs example PAIR FROM TO gallery.html
//          what the detector marks in one window of one pair, e.g. the two
//          places of the video (they lie after dev: no results are counted)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const DEV_FROM = "2015-02-02", DEV_TO = "2021-12-08", SPLIT = "2018-07-01";
const RULES = {
  zigzagAtr: 2, // a swing is confirmed when the price has come back by this many ATR(14) of its timeframe
  touchAtr: 0.25, // H1 ATRs: a swing this close to the line is a touch; a bar this close has come to the line
  breakAtr: 0.1, // H1 ATRs: an H1 close this far beyond the line is a break
  structureBars: 24, // H1 bars from the break of the line in which the break of structure must come
  retestBars: 24, // H1 bars the limit order on the line waits
  bounceBars: 32, // M15 bars from the touch of the line to the break of the pullback
  pullbackBars: 32, // M15 bars whose extreme is the stop of entry 2
  limitBars: 5 * 96, // M15 bars a trade may live
  takes: [1, 1.5],
};
const example = process.argv[2] === "example" ? { pair: process.argv[3], from: process.argv[4], to: process.argv[5], file: process.argv[6] } : null;
const galleryFile = example ? example.file : process.argv[2];
const FROM = example ? example.from : DEV_FROM, TO = example ? example.to : DEV_TO;

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f = (x, d = 3) => (!Number.isFinite(x) ? "  n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400e3).toISOString().slice(0, 10);

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
/** M15 bars between two dates. Dev reads nothing after its end; the example mode reads its own window and 60 days before it. */
function loadM15(symbol, from, to) {
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date < from) continue;
    if (date > to) break;
    rows.push({ date, hour: +p[1].slice(0, 2), minute: +p[1].slice(3, 5), o: +p[2], h: +p[3], l: +p[4], c: +p[5], spread: +p[8] });
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
const atr = (bars, n) => sma(bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)))), n);

/** Swings with nothing taken from the future: a high becomes a swing on the bar whose close is 2 ATRs under it (`conf`). */
function zigzag(bars, av) {
  const swings = [];
  let dir = 0, hi = -Infinity, hiIdx = -1, lo = Infinity, loIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], thr = RULES.zigzagAtr * av[i];
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
  for (let i = 0; i < bars.length; i++) {
    while (n < swings.length && swings[n].conf <= i) { if (swings[n].type === "H") h = swings[n].price; else l = swings[n].price; n++; }
    hi[i] = h; lo[i] = l;
  }
  return { hi, lo };
}
function build(symbol, from, to) {
  const m15 = loadM15(symbol, from, to);
  const h1 = aggregate(m15, (b) => `${b.date} ${b.hour}`), d1 = aggregate(m15, (b) => b.date);
  const atr1 = atr(h1, 14), sw1 = zigzag(h1, atr1);
  const sw15 = zigzag(m15, atr(m15, 14)), last15 = lastSwings(m15, sw15);
  const dAtr = atr(d1, 20), day = new Map();
  d1.forEach((b, i) => { if (i > 0) day.set(b.date, dAtr[i - 1]); });
  const h1Of = new Int32Array(m15.length);
  h1.forEach((b, k) => { for (let j = b.first; j <= b.last; j++) h1Of[j] = k; });
  return { s: spec(symbol), m15, h1, atr1, sw1, last15, day, h1Of };
}

// ------------------------------------------------------------------ lines
// A line of direction +1 lies under rising lows, of direction -1 over falling highs. Inside, prices are
// multiplied by the direction ("q"), so that both are "a line under rising lows".
const loQ = (dir, b) => (dir > 0 ? b.l : -b.h), hiQ = (dir, b) => (dir > 0 ? b.h : -b.l);
/** Every version of the trendline of one direction, the first breaks of structure, and where the swings say "trend". */
function scanLines(m, dir) {
  const { h1, atr1, sw1 } = m;
  const pivots = sw1.filter((s) => s.type === (dir > 0 ? "L" : "H"));
  const lines = [], breaks = [], trend = new Uint8Array(h1.length);
  let n = 0, run = [], living = [];
  for (let i = 0; i < h1.length; i++) {
    trend[i] = run.length >= 2 ? 1 : 0; // what is known before bar i closes
    const c = dir * h1[i].c;
    for (const line of living) if (line.brokenAt === null && c < line.p + line.slope * (i - line.i) - RULES.breakAtr * atr1[i]) line.brokenAt = i;
    if (run.length >= 2 && i > 0) {
      const level = run.at(-1).p;
      if (c < level && dir * h1[i - 1].c >= level) breaks.push({ i, level, from: run[0].idx });
    }
    while (n < pivots.length && pivots[n].conf <= i) {
      const s = pivots[n++], p = dir * s.price;
      if (run.length > 0 && p <= run.at(-1).p) run = [];
      run.push({ idx: s.idx, p });
      for (const line of living) line.endAt = i;
      living = [];
      // One line from every low of the run but the last: the first is the "global" line, the later ones are steeper, "local".
      for (let k = 0; k + 1 < run.length; k++) {
        const a = run[k], rest = run.slice(k + 1);
        let slope = Infinity;
        for (const b of rest) slope = Math.min(slope, (b.p - a.p) / (b.idx - a.idx));
        if (c < a.p + slope * (i - a.idx) - RULES.breakAtr * atr1[i]) continue; // the price is already under it
        const touches = 1 + rest.filter((b) => Math.abs(b.p - (a.p + slope * (b.idx - a.idx))) <= RULES.touchAtr * atr1[b.idx]).length;
        const line = { dir, i: a.idx, p: a.p, slope, touches, global: k === 0, born: i, last: run.at(-1).p, points: [a, ...rest].map((b) => ({ ...b })), brokenAt: null, endAt: null };
        lines.push(line); living.push(line);
      }
    }
  }
  return { lines, breaks, trend };
}
/** The line in "q" at M15 bar j: the bar's hour and the part of the hour that has passed. */
const lineQ = (m, L, j) => L.p + L.slope * (m.h1Of[j] + m.m15[j].minute / 60 - L.i);

// ------------------------------------------------------------------ orders and the trade
const spreadOf = (m, b, costs) => (costs ? Math.max(b.spread, m.s.minSpread) * m.s.point : 0);
function marketEntry(m, j, dir, costs) {
  const b = m.m15[j];
  if (b === undefined) return null;
  const slip = costs ? m.s.slip : 0;
  return { j, intrabar: false, entry: dir > 0 ? b.o + spreadOf(m, b, costs) + slip : b.o - slip };
}
/** A limit order whose price may move with every bar; filled at its price, or at the open when the bar opens through it. */
function limitEntry(m, jFrom, jTo, dir, priceAt, costs) {
  const slip = costs ? m.s.slip : 0;
  for (let j = jFrom; j <= jTo && j < m.m15.length; j++) {
    const b = m.m15[j], P = priceAt(j), sp = spreadOf(m, b, costs);
    if (dir > 0) { if (b.l + sp <= P) return { j, intrabar: b.o + sp > P, entry: Math.min(P, b.o + sp) + slip }; } else if (b.h >= P) return { j, intrabar: b.o < P, entry: Math.max(P, b.o) - slip };
  }
  return null;
}
/**
 * The position from its fill to the stop, the take or the time limit. Result in R (the stop distance), after
 * swaps and commission when costs are on. Within a bar the stop is taken before the take; on the bar where a
 * limit order was filled only the stop may follow.
 */
function manage(m, fill, dir, stopPrice, takeR, costs) {
  if (fill === null) return null;
  const { s, m15, day } = m, slip = costs ? s.slip : 0, { j: j0, entry } = fill;
  const dAtr = day.get(m15[j0].date);
  if (!Number.isFinite(dAtr)) return null;
  let dist = dir * (entry - stopPrice);
  if (!(dist > 0) || dist > dAtr) return null; // a stop further than a usual day's range is not a stop of this method
  if (dist < 0.1 * dAtr) dist = 0.1 * dAtr;
  const stop = entry - dir * dist, take = entry + dir * takeR * dist;
  let nights = 0, exit = NaN, reason = "", j = j0;
  for (; j < m15.length; j++) {
    const b = m15[j], sp = spreadOf(m, b, costs), first = j === j0 && fill.intrabar;
    if (j > j0 && b.date !== m15[j - 1].date) nights += weekday(m15[j - 1].date) === 3 ? 3 : 1;
    if (j - j0 >= RULES.limitBars) { exit = dir > 0 ? b.o - slip : b.o + sp + slip; reason = "time"; break; }
    if (dir > 0) {
      if (b.l <= stop) { exit = (first ? stop : Math.min(stop, b.o)) - slip; reason = "stop"; break; }
      if (!first && b.h >= take) { exit = take - slip; reason = "take"; break; }
    } else {
      if (b.h + sp >= stop) { exit = (first ? stop : Math.max(stop, b.o + sp)) + slip; reason = "stop"; break; }
      if (!first && b.l + sp <= take) { exit = take + slip; reason = "take"; break; }
    }
  }
  if (!Number.isFinite(exit)) return null; // the data ended with the position open
  let r = (dir * (exit - entry)) / dist;
  if (costs) {
    const swap = (dir > 0 ? s.swapLong : s.swapShort) * (s.swapRef === null ? 1 : entry / s.swapRef) * nights;
    const commission = s.base ? (s.commission / s.contract) * entry : s.commission / s.contract;
    r += (swap - commission) / dist;
  }
  return { e: j0, x: j, r, reason, entry, stop, take, dir, date: m15[j0].date };
}

// ------------------------------------------------------------------ the entries
/** All candidates of one pair: a map from the name of a variant to its trades in time order. */
function candidates(symbol, m, costs) {
  const { h1, m15, atr1, last15, h1Of } = m;
  const out = new Map();
  const put = (key, t, extra) => { if (t === null || t.date < FROM) return; let a = out.get(key); if (a === undefined) out.set(key, (a = [])); a.push({ symbol, t, ...extra }); };
  const scans = { 1: scanLines(m, 1), "-1": scanLines(m, -1) };
  const topOf = (dir, from, to) => { let top = -Infinity; for (let i = from; i <= to; i++) top = Math.max(top, hiQ(dir, h1[i])); return top; };
  const retestEnd = (a) => (a + RULES.retestBars < h1.length ? h1[a + RULES.retestBars].last : m15.length - 1);

  for (const dir of [1, -1]) {
    const sc = scans[dir], against = -dir;
    // Entry 1: the line is broken, the trade goes against the old trend.
    for (const L of sc.lines) {
      const b = L.brokenAt;
      if (b === null) continue;
      let s = -1;
      for (let i = b; i <= b + RULES.structureBars && i < h1.length; i++) if (dir * h1[i].c < L.last) { s = i; break; }
      for (const [signal, a] of [["line", b], ["line+structure", s]]) {
        if (a < 0) continue;
        const stopPrice = dir * topOf(dir, L.i, a) + dir * m.s.pip, j0 = h1[a].last + 1;
        const now = marketEntry(m, j0, against, costs);
        const back = limitEntry(m, j0, retestEnd(a), against, (j) => dir * lineQ(m, L, j), costs);
        for (const take of RULES.takes) {
          put(`E1|${signal}|now|${take}`, manage(m, now, against, stopPrice, take, costs), { L, a });
          put(`E1|${signal}|retest|${take}`, manage(m, back, against, stopPrice, take, costs), { L, a });
        }
      }
    }
    // Its control: the break of structure with no line.
    for (const ev of sc.breaks) {
      const stopPrice = dir * topOf(dir, ev.from, ev.i) + dir * m.s.pip, j0 = h1[ev.i].last + 1;
      const now = marketEntry(m, j0, against, costs);
      const back = limitEntry(m, j0, retestEnd(ev.i), against, () => dir * ev.level, costs);
      for (const take of RULES.takes) {
        put(`C1|now|${take}`, manage(m, now, against, stopPrice, take, costs), {});
        put(`C1|retest|${take}`, manage(m, back, against, stopPrice, take, costs), {});
      }
    }
    // Entry 2: the price comes back to a living line and the pullback breaks on M15.
    const pullbackStop = (k) => { let lo = Infinity; for (let u = Math.max(0, k - RULES.pullbackBars + 1); u <= k; u++) lo = Math.min(lo, loQ(dir, m15[u])); return dir * lo - dir * m.s.pip; };
    const brokeUp = (k) => {
      const level = dir > 0 ? last15.hi[k] : last15.lo[k];
      return Number.isFinite(level) && (dir > 0 ? m15[k].c > level && m15[k - 1].c <= level : m15[k].c < level && m15[k - 1].c >= level);
    };
    for (const L of sc.lines) {
      const endH = Math.min(L.brokenAt ?? Infinity, L.endAt ?? Infinity);
      const life1 = Number.isFinite(endH) ? h1[endH].last : m15.length - 1;
      let touch = -1;
      for (let j = h1[L.born].last + 1; j <= life1; j++) {
        const a1 = atr1[h1Of[j] - 1];
        if (Number.isFinite(a1) && loQ(dir, m15[j]) <= lineQ(m, L, j) + RULES.touchAtr * a1) { touch = j; break; }
      }
      if (touch < 0) continue;
      for (let k = Math.max(touch, 1); k <= touch + RULES.bounceBars && k < life1; k++) {
        if (!brokeUp(k)) continue;
        const fill = marketEntry(m, k + 1, dir, costs), stopPrice = pullbackStop(k);
        for (const take of RULES.takes) put(`E2|${take}`, manage(m, fill, dir, stopPrice, take, costs), { L, a: h1Of[k], touch });
        break;
      }
    }
    // Its control: the same break on M15 anywhere, with the swings of H1 rising, and with no condition at all.
    for (let k = 1; k < m15.length - 1; k++) {
      if (m15[k].date < FROM || !brokeUp(k)) continue;
      const fill = marketEntry(m, k + 1, dir, costs), stopPrice = pullbackStop(k);
      for (const take of RULES.takes) {
        const t = manage(m, fill, dir, stopPrice, take, costs);
        put(`C2|any|${take}`, t, {});
        if (sc.trend[h1Of[k]] === 1) put(`C2|trend|${take}`, t, {});
      }
    }
  }
  for (const list of out.values()) list.sort((x, y) => x.t.e - y.t.e);
  return out;
}

// ------------------------------------------------------------------ counting
/** One position per pair: candidates in time order, a new one only after the previous trade is closed. */
function sequence(cands) {
  const trades = [], free = new Map();
  for (const c of cands) {
    if (c.t.e < (free.get(c.symbol) ?? 0)) continue;
    free.set(c.symbol, c.t.x);
    trades.push(c);
  }
  return trades;
}
function summary(trades) {
  if (trades.length === 0) return { n: 0, meanR: NaN, t: NaN, pf: NaN, win: NaN };
  const byWeek = new Map();
  for (const c of trades) { const wk = Math.floor((Date.parse(`${c.t.date}T00:00:00Z`) / 86400e3 + 3) / 7); byWeek.set(wk, (byWeek.get(wk) ?? 0) + c.t.r); }
  const w = [...byWeek.values()], mw = mean(w);
  const sd = Math.sqrt(mean(w.map((x) => (x - mw) ** 2)) * (w.length / Math.max(1, w.length - 1)));
  const rs = trades.map((c) => c.t.r), wins = rs.filter((r) => r > 0).reduce((a, r) => a + r, 0), losses = -rs.filter((r) => r <= 0).reduce((a, r) => a + r, 0);
  return { n: rs.length, meanR: mean(rs), t: mw / (sd / Math.sqrt(w.length)), pf: wins / Math.max(1e-9, losses), win: rs.filter((r) => r > 0).length / rs.length };
}

// ------------------------------------------------------------------ the picture of one trade
function card(m, c, title, note) {
  const { h1, h1Of } = m, { L, t } = c, dir = L.dir;
  const exitH = h1Of[t.x], entryH = h1Of[t.e];
  const from = Math.max(0, L.i - 12), to = Math.min(h1.length - 1, exitH + 8);
  const view = h1.slice(from, to + 1);
  const W = 760, H = 320, padL = 8, padR = 70;
  const top = Math.max(...view.map((b) => b.h), t.take, t.stop), bottom = Math.min(...view.map((b) => b.l), t.take, t.stop);
  const x = (i) => padL + ((i - from + 0.5) * (W - padL - padR)) / view.length, y = (p) => 12 + ((top - p) * (H - 24)) / (top - bottom);
  const bw = Math.max(1.5, ((W - padL - padR) / view.length) * 0.6), n1 = (v) => v.toFixed(1);
  const candles = view.map((b, n) => { const i = from + n, up = b.c >= b.o; return `<line x1="${n1(x(i))}" x2="${n1(x(i))}" y1="${n1(y(b.h))}" y2="${n1(y(b.l))}" class="${up ? "up" : "dn"}"/><rect x="${n1(x(i) - bw / 2)}" y="${n1(y(Math.max(b.o, b.c)))}" width="${n1(bw)}" height="${n1(Math.max(1, Math.abs(y(b.o) - y(b.c))))}" class="${up ? "upf" : "dnf"}"/>`; }).join("");
  const lineEnd = Math.min(to, Math.max(entryH, c.a) + 4), at = (i) => dir * (L.p + L.slope * (i - L.i));
  const line = `<line x1="${n1(x(L.i))}" y1="${n1(y(at(L.i)))}" x2="${n1(x(lineEnd))}" y2="${n1(y(at(lineEnd)))}" class="fig"/>`;
  const dots = L.points.map((p) => `<rect x="${n1(x(p.idx) - 5)}" y="${n1(y(dir * p.p) - 5)}" width="10" height="10" class="box"/>`).join("");
  const hline = (p, cls, label) => `<line x1="${n1(x(entryH))}" x2="${W - padR}" y1="${n1(y(p))}" y2="${n1(y(p))}" class="${cls}"/><text x="${W - padR + 4}" y="${n1(y(p) + 4)}" class="lbl">${label}</text>`;
  const mark = (i, cls) => `<line x1="${n1(x(i))}" x2="${n1(x(i))}" y1="12" y2="${H - 12}" class="${cls}"/>`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${candles}${line}${dots}${L.brokenAt !== null && L.brokenAt <= to ? mark(L.brokenAt, "brk") : ""}${mark(entryH, "entry")}${hline(t.entry, "ent", "вход")}${hline(t.stop, "stp", "стоп")}${hline(t.take, "tp", "тейк")}</svg>`;
  const ends = { stop: "стоп", take: "тейк", time: "закрыта по сроку" };
  const digits = m.s.digits === 3 ? 3 : 5;
  return `<section><h2>${title}</h2><p>${t.dir > 0 ? "Покупка" : "Продажа"} ${t.entry.toFixed(digits)}, стоп ${t.stop.toFixed(digits)}, тейк ${t.take.toFixed(digits)}. Касаний линии: ${L.touches}. Итог: ${ends[t.reason]}${note ?? ` (${f(t.r, 2)} R после издержек)`}.</p>${svg}</section>`;
}
function page(heading, lead, cards) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Линии тренда</title><style>
:root{--bg:#fff;--fg:#1c1c1c;--mut:#6b6b6b;--up:#1a8f5a;--dn:#c0392b;--fig:#2456c7;--line:#888}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#a0a0a0;--up:#3fbf85;--dn:#e06c5c;--fig:#7aa2ff;--line:#999}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:820px;margin-inline:auto}
h1{font-size:22px}h2{font-size:17px;margin:28px 0 4px}p{margin:4px 0 8px;color:var(--mut)}svg{width:100%;height:auto;display:block}
.up{stroke:var(--up)}.dn{stroke:var(--dn)}.upf{fill:var(--up)}.dnf{fill:var(--dn)}.fig{stroke:var(--fig);stroke-width:2}.box{fill:none;stroke:var(--fig);stroke-width:1.5}
.entry{stroke:var(--line);stroke-dasharray:4 4}.brk{stroke:var(--fig);stroke-dasharray:2 5}.ent{stroke:var(--fg)}.stp{stroke:var(--dn);stroke-dasharray:6 3}.tp{stroke:var(--up);stroke-dasharray:6 3}.lbl{fill:var(--fg);font-size:12px}
</style></head><body><h1>${heading}</h1><p>${lead}</p>${cards.join("\n")}</body></html>`;
}
const LEAD = "Свечи H1. Синяя линия — линия тренда, квадраты — точки разворота, через которые она проведена. Редкий синий пунктир — свеча, закрывшаяся за линией (пробой). Серый пунктир — момент входа.";
function writePage(heading, lead, cards) {
  mkdirSync(path.dirname(galleryFile), { recursive: true });
  writeFileSync(galleryFile, page(heading, lead, cards));
  console.log(`\n${cards.length} pictures written to ${galleryFile}`);
}

// ------------------------------------------------------------------ run
if (example) {
  // One pair, one window: what the detector marks there. No results are counted.
  const m = build(example.pair, shift(example.from, -60), example.to), all = candidates(example.pair, m, true);
  console.log(`What the detector marks on ${example.pair} from ${example.from} to ${example.to} (a window outside dev: for the shape only)`);
  const digits = m.s.digits === 3 ? 3 : 5, cards = [];
  for (const [key, title] of [["E1|line|now|1", "Вход 1: пробой линии, вход сразу"], ["E1|line|retest|1", "Вход 1: пробой линии, вход на ретесте"], ["E1|line+structure|retest|1", "Вход 1: пробой и слом структуры, вход на ретесте"], ["E2|1", "Вход 2: отбой от линии и слом на M15"]]) {
    console.log(`--- ${key}`);
    for (const c of all.get(key) ?? []) {
      const b = m.m15[c.t.e];
      console.log(`  ${c.t.date} ${String(b.hour).padStart(2, "0")}:${String(b.minute).padStart(2, "0")} server  ${c.t.dir > 0 ? "buy " : "sell"} ${c.t.entry.toFixed(digits)}  stop ${c.t.stop.toFixed(digits)}  take ${c.t.take.toFixed(digits)}  touches ${c.L.touches}  ${c.L.global ? "global" : "local "} line from ${m.h1[c.L.i].date}`);
      cards.push(card(m, c, `${title} — ${example.pair}, ${c.t.date}`, ""));
    }
  }
  if (galleryFile !== undefined) writePage(`Что программа отмечает на ${example.pair}, ${example.from} — ${example.to}`, `${LEAD} Это окно вне старых данных: оно открыто только чтобы сверить форму с примерами из видео.`, cards);
} else {
  const net = new Map(), gross = new Map(), markets = new Map();
  const merge = (into, from) => { for (const [k, v] of from) into.set(k, (into.get(k) ?? []).concat(v)); };
  for (const symbol of PAIRS) {
    const m = build(symbol, "2014-01-01", DEV_TO);
    markets.set(symbol, m);
    merge(net, candidates(symbol, m, true)); merge(gross, candidates(symbol, m, false));
  }
  const months = (Date.parse(DEV_TO) - Date.parse(DEV_FROM)) / (86400e3 * 30.44);
  let rows = 0;
  const row = (label, key, test = () => true) => {
    const pick = (map) => sequence((map.get(key) ?? []).filter(test).sort((x, y) => x.t.e - y.t.e));
    const tr = pick(net), all = summary(tr), gs = summary(pick(gross)), a = summary(tr.filter((c) => c.t.date < SPLIT)), b = summary(tr.filter((c) => c.t.date >= SPLIT));
    const plus = PAIRS.filter((p) => mean(tr.filter((c) => c.symbol === p).map((c) => c.t.r)) > 0).length;
    rows++;
    console.log(`${pad(label, 62)} ${lpad(all.n, 6)} ${lpad((all.n / months).toFixed(1), 6)} ${lpad(f(gs.meanR), 7)} ${lpad(f(all.meanR), 7)} ${lpad(f(all.t, 1), 5)} ${lpad(Number.isFinite(all.pf) ? all.pf.toFixed(2) : "n/a", 5)} ${lpad(Number.isFinite(gs.win) ? `${(gs.win * 100).toFixed(0)}%` : "n/a", 5)} | ${lpad(f(a.meanR), 7)} | ${lpad(f(b.meanR), 7)} | ${plus}/${PAIRS.length}`);
  };
  const head = (title) => { console.log(`\n=== ${title} ===`); console.log(`${pad("", 62)} ${lpad("n", 6)} ${lpad("/mo", 6)} ${lpad("before", 7)} ${lpad("after", 7)} ${lpad("t", 5)} ${lpad("PF", 5)} ${lpad("wins", 5)} | ${lpad("1st", 7)} | ${lpad("2nd", 7)} | pairs+`); };
  console.log(`Entries around a trendline, dev ${DEV_FROM} .. ${DEV_TO}. R = the stop distance; "before" and "wins" are before costs; t counts weeks.`);
  console.log("With no edge a take of 1 gives 0 R and 50% of wins before costs, a take of 1.5 gives 0 R and 40%.");
  for (const take of RULES.takes) {
    head(`Entry 1, against the old trend after the break of the line; take 1:${take}`);
    for (const signal of ["line", "line+structure"]) for (const mode of ["now", "retest"]) for (const touches of [2, 3]) {
      row(`${signal === "line" ? "the line is broken" : "the line and the structure are broken"}, ${mode === "now" ? "at once" : "on the retest"}, ${touches}+ touches`, `E1|${signal}|${mode}|${take}`, (c) => c.L.touches >= touches);
    }
    row("control: break of structure with no line, at once", `C1|now|${take}`);
    row("control: break of structure with no line, on the retest", `C1|retest|${take}`);
    head(`Entry 2, with the trend on a bounce from the line; take 1:${take}`);
    for (const touches of [2, 3]) row(`touch of the line and a break on M15, ${touches}+ touches`, `E2|${take}`, (c) => c.L.touches >= touches);
    row("control: the same break on M15 anywhere, H1 swings rising", `C2|trend|${take}`);
    row("control: the same break on M15 anywhere, no condition", `C2|any|${take}`);
  }
  console.log(`\nRows counted: ${rows}`);
  const reasons = {};
  for (const c of sequence(net.get("E1|line|retest|1") ?? [])) reasons[c.t.reason] = (reasons[c.t.reason] ?? 0) + 1;
  console.log(`how the trades of "the line is broken, on the retest, take 1:1" ended: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  if (galleryFile !== undefined) {
    // The first cases in time order on EURUSD from 2019, with no selection by result.
    const firstOf = (key, n) => (net.get(key) ?? []).filter((c) => c.symbol === "EURUSD" && c.t.date >= "2019-01-01").slice(0, n);
    const cards = [
      ...firstOf("E1|line|retest|1", 6).map((c) => card(markets.get(c.symbol), c, `Вход 1: пробой линии, вход на ретесте — ${c.symbol}, ${c.t.date}`)),
      ...firstOf("E2|1", 6).map((c) => card(markets.get(c.symbol), c, `Вход 2: отбой от линии и слом на M15 — ${c.symbol}, ${c.t.date}`)),
    ];
    writePage("Как программа видит линии тренда и входы", `${LEAD} Это первые по порядку случаи на EURUSD с 2019 года, без отбора по результату: среди них есть и убыточные.`, cards);
  }
}
