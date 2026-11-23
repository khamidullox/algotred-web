// Two notes from the customer's chat, coded as they stand (TZ 17.36).
// Seven dollar pairs, execution on M15. Said for a buy, mirrored for a sell.
//
// A. "Fibo + engulfing" (their drawing of 2025-05-04; M15, M30, H1, H4).
//    A candle that closed up after a candle that closed down and whose body
//    covers the body of that candle. A Fibonacci grid is put on the candle:
//    0 at its low, 1 at its high. A limit order in the zone 0.5-0.382 (both
//    edges are counted), the stop at 0, the targets at 1.618 and 2.618.
//    Context: none; the pattern at a 20-candle low; the pattern with the
//    trend of its own timeframe (swing highs and lows both rising).
//    Control: the same grid, order, stop and targets on a candle of the same
//    size and colour that is not an engulfing.
//
// B. A divergence of RSI(14) with the price as a sign of a reversal (their
//    photos of 2026-04-19; H4, and H1 beside it). Found the way the built-in
//    "RSI Divergence Indicator" of TradingView finds it: a low of RSI with 5
//    candles on the left and 5 on the right (2 on the right is counted too),
//    the previous such low 5 to 60 candles back; the price low is lower, the
//    RSI low is higher. Entry on the next open after the low is confirmed,
//    the stop one pip beyond the lowest low between the two, take 1:1 and
//    1:1.5. Also only "at a level": the low within 0.25 of the daily ATR of
//    the lowest low of the 120 candles before the first of the two lows.
//    Control: the same low of RSI with no divergence.
//
// One position a pair, costs as in the engine, the stop before the take
// within a bar.
//
// Usage: node research/fx-chat-notes.mjs [gallery.html]               dev
//        node research/fx-chat-notes.mjs window FROM TO                a list of trades in a window that ends
//          before dev begins: to check the mechanics, nothing is counted
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const DEV_FROM = "2015-02-02", DEV_TO = "2021-12-08", SPLIT = "2018-07-01";
const TF = { M15: 1, M30: 2, H1: 4, H4: 16 }; // M15 bars in one candle
const KEY = {
  M15: (b) => `${b.date} ${b.hour} ${b.minute}`,
  M30: (b) => `${b.date} ${b.hour} ${b.minute < 30 ? 0 : 1}`,
  H1: (b) => `${b.date} ${b.hour}`,
  H4: (b) => `${b.date} ${Math.floor(b.hour / 4)}`,
};
const RULES = {
  // A: the grid on an engulfing candle
  bodyTolerancePips: 1, // the open may stand this far inside the previous body: a new candle seldom opens exactly on the last close
  sizeAtr: 1, // the candle is at least this many ATR(14) of its timeframe from high to low
  minStopDayAtr: 0.1, // a setup whose stop is closer than this share of the daily ATR(20) is skipped
  entries: [0.5, 0.382], // the two edges of the "0.5-0.3" zone
  targets: [1.618, 2.618],
  orderCandles: 10, // candles the limit order waits; it is also removed when the price reaches 1.618 first
  extremeCandles: 20,
  zigzagAtr: 2,
  // B: the divergence
  rsi: 14, left: 5, rights: [5, 2], rangeMin: 5, rangeMax: 60,
  takes: [1, 1.5],
  levelCandles: 120, levelDayAtr: 0.25,
  // both
  lifeCandles: 120, // candles of its timeframe a trade may live
};
const windowMode = process.argv[2] === "window" ? { from: process.argv[3], to: process.argv[4] } : null;
const galleryFile = windowMode ? undefined : process.argv[2];
const FROM = windowMode ? windowMode.from : DEV_FROM, TO = windowMode ? windowMode.to : DEV_TO;
if (windowMode && !(windowMode.to < DEV_FROM)) { console.error(`the window must end before ${DEV_FROM}: dev, test and holdout are not for checking the mechanics`); process.exit(1); }
const DAY_ATR = windowMode ? 5 : 20; // the data begin four weeks before dev: the check of the mechanics takes a shorter daily ATR

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f = (x, d = 3) => (!Number.isFinite(x) ? "  n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "n/a");
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
/** RSI by Wilder, as on a TradingView or MT5 chart: the first value is a plain average of n changes. */
function rsi(bars, n) {
  const out = new Array(bars.length).fill(NaN);
  let up = 0, down = 0;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c, u = Math.max(d, 0), v = Math.max(-d, 0);
    if (i <= n) { up += u / n; down += v / n; } else { up = (up * (n - 1) + u) / n; down = (down * (n - 1) + v) / n; }
    if (i >= n) out[i] = down === 0 ? 100 : 100 - 100 / (1 + up / down);
  }
  return out;
}
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
/** For every bar: +1 when the last two swing highs and the last two swing lows confirmed by its close both rise, -1 when both fall. */
function steps(bars, swings) {
  const out = new Int8Array(bars.length), hi = [], lo = [];
  let n = 0;
  for (let i = 0; i < bars.length; i++) {
    while (n < swings.length && swings[n].conf <= i) { (swings[n].type === "H" ? hi : lo).push(swings[n].price); n++; }
    if (hi.length < 2 || lo.length < 2) continue;
    if (hi.at(-1) > hi.at(-2) && lo.at(-1) > lo.at(-2)) out[i] = 1;
    else if (hi.at(-1) < hi.at(-2) && lo.at(-1) < lo.at(-2)) out[i] = -1;
  }
  return out;
}
/** For every bar: the highest high and the lowest low of the n bars before it. */
function extremesBefore(bars, n) {
  const hi = new Array(bars.length).fill(NaN), lo = new Array(bars.length).fill(NaN);
  for (let i = n; i < bars.length; i++) {
    let h = -Infinity, l = Infinity;
    for (let k = i - n; k < i; k++) { if (bars[k].h > h) h = bars[k].h; if (bars[k].l < l) l = bars[k].l; }
    hi[i] = h; lo[i] = l;
  }
  return { hi, lo };
}
function build(symbol, from, to) {
  const m15 = loadM15(symbol, from, to);
  const d1 = aggregate(m15, (b) => b.date), dAtr = atr(d1, DAY_ATR), day = new Map();
  d1.forEach((b, i) => { if (i > 0) day.set(b.date, dAtr[i - 1]); });
  const tf = {};
  for (const name of Object.keys(TF)) {
    const bars = aggregate(m15, KEY[name]), av = atr(bars, 14), of = new Int32Array(m15.length);
    bars.forEach((b, k) => { for (let j = b.first; j <= b.last; j++) of[j] = k; });
    tf[name] = { bars, av, of, trend: steps(bars, zigzag(bars, av)), ext: extremesBefore(bars, RULES.extremeCandles), osc: rsi(bars, RULES.rsi) };
  }
  return { s: spec(symbol), m15, day, tf };
}

// ------------------------------------------------------------------ orders and the trade
const spreadOf = (m, b, costs) => (costs ? Math.max(b.spread, m.s.minSpread) * m.s.point : 0);
function marketEntry(m, j, dir, costs) {
  const b = m.m15[j];
  if (b === undefined) return null;
  const slip = costs ? m.s.slip : 0;
  return { j, intrabar: false, entry: dir > 0 ? b.o + spreadOf(m, b, costs) + slip : b.o - slip };
}
/** A limit order at a fixed price; filled at its price, or at the open when the bar opens through it. Removed when the price reaches `cancelAt` first. */
function limitEntry(m, jFrom, jTo, dir, P, cancelAt, costs) {
  const slip = costs ? m.s.slip : 0;
  for (let j = jFrom; j <= jTo && j < m.m15.length; j++) {
    const b = m.m15[j], sp = spreadOf(m, b, costs);
    if (dir > 0) {
      if (b.l + sp <= P) return { j, intrabar: b.o + sp > P, entry: Math.min(P, b.o + sp) + slip };
      if (b.h >= cancelAt) return null;
    } else {
      if (b.h >= P) return { j, intrabar: b.o < P, entry: Math.max(P, b.o) - slip };
      if (b.l + sp <= cancelAt) return null;
    }
  }
  return null;
}
/**
 * The position from its fill to the stop, the take or the time limit, the stop and the take given as prices.
 * Result in R (the distance from the fill to the stop), after swaps and commission when costs are on.
 * Within a bar the stop is taken before the take; on the bar where a limit order was filled only the stop may follow.
 */
function hold(m, fill, dir, stop, take, lifeBars, costs) {
  if (fill === null) return null;
  const { s, m15 } = m, slip = costs ? s.slip : 0, { j: j0, entry } = fill;
  const dist = dir * (entry - stop), rr = (dir * (take - entry)) / dist;
  if (!(dist > 0) || !(rr > 0)) return null;
  let nights = 0, exit = NaN, reason = "", j = j0;
  for (; j < m15.length; j++) {
    const b = m15[j], sp = spreadOf(m, b, costs), first = j === j0 && fill.intrabar;
    if (j > j0 && b.date !== m15[j - 1].date) nights += weekday(m15[j - 1].date) === 3 ? 3 : 1;
    if (j - j0 >= lifeBars) { exit = dir > 0 ? b.o - slip : b.o + sp + slip; reason = "time"; break; }
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
  return { e: j0, x: j, r, rr, reason, entry, stop, take, dir, date: m15[j0].date };
}
/** The same with the stop given as a price and the take in R; the stop not further than a usual day's range and not closer than a tenth of it. */
function holdR(m, fill, dir, stopPrice, takeR, lifeBars, costs) {
  if (fill === null) return null;
  const dAtr = m.day.get(m.m15[fill.j].date);
  if (!Number.isFinite(dAtr)) return null;
  let dist = dir * (fill.entry - stopPrice);
  if (!(dist > 0) || dist > dAtr) return null;
  if (dist < 0.1 * dAtr) dist = 0.1 * dAtr;
  return hold(m, fill, dir, fill.entry - dir * dist, fill.entry + dir * takeR * dist, lifeBars, costs);
}

// ------------------------------------------------------------------ the entries
/** All candidates of one pair: a map from the name of a variant to its trades. */
function candidates(symbol, m, costs) {
  const out = new Map();
  const put = (key, t, extra) => { if (t === null || t.date < FROM) return; let a = out.get(key); if (a === undefined) out.set(key, (a = [])); a.push({ symbol, t, ...extra }); };

  // A. The grid on an engulfing candle, and on a candle of the same size and colour that is not one.
  const tol = RULES.bodyTolerancePips * m.s.pip;
  for (const name of Object.keys(TF)) {
    const { bars, av, trend, ext } = m.tf[name], life = RULES.lifeCandles * TF[name];
    for (let j = RULES.extremeCandles + 2; j + 1 < bars.length; j++) {
      const p = bars[j - 1], b = bars[j], range = b.h - b.l, dAtr = m.day.get(b.date);
      if (b.date < FROM || !Number.isFinite(dAtr) || !(range >= RULES.sizeAtr * av[j - 1])) continue;
      const dir = b.c > b.o ? 1 : b.c < b.o ? -1 : 0;
      if (dir === 0) continue;
      const engulf = dir > 0 ? p.c < p.o && b.c > p.o && b.o <= p.c + tol : p.c > p.o && b.c < p.o && b.o >= p.c - tol;
      const zero = dir > 0 ? b.l : b.h, level = (x) => zero + dir * x * range;
      const atExtreme = dir > 0 ? Math.min(p.l, b.l) <= ext.lo[j - 1] : Math.max(p.h, b.h) >= ext.hi[j - 1];
      const extra = { part: "A", name, j, dir, zero, range, atExtreme, withTrend: trend[j] === dir };
      const jTo = bars[Math.min(j + RULES.orderCandles, bars.length - 1)].last;
      for (const e of RULES.entries) {
        if (e * range < RULES.minStopDayAtr * dAtr) continue;
        const fill = limitEntry(m, b.last + 1, jTo, dir, level(e), level(RULES.targets[0]), costs);
        for (const target of RULES.targets) put(`A|${name}|${e}|${target}|${engulf ? "pattern" : "control"}`, hold(m, fill, dir, zero, level(target), life, costs), extra);
      }
    }
  }

  // B. A low of RSI that diverges from the price, and a low of RSI that does not.
  for (const name of ["H4", "H1"]) {
    const { bars, osc } = m.tf[name], life = RULES.lifeCandles * TF[name];
    for (const right of RULES.rights) for (const dir of [1, -1]) {
      const w = (k) => -dir * osc[k], px = (k) => (dir > 0 ? bars[k].l : bars[k].h);
      let prev = -1;
      for (let i = RULES.rsi + RULES.left; i + right < bars.length; i++) {
        let pivot = Number.isFinite(osc[i - RULES.left]);
        for (let k = 1; pivot && k <= RULES.left; k++) if (!(w(i) > w(i - k))) pivot = false;
        for (let k = 1; pivot && k <= right; k++) if (!(w(i) >= w(i + k))) pivot = false;
        if (!pivot) continue;
        const before = prev, conf = i + right;
        prev = i;
        if (before < 0 || i - before < RULES.rangeMin || i - before > RULES.rangeMax || bars[conf].date < FROM) continue;
        const div = dir * (px(i) - px(before)) < 0 && dir * (osc[i] - osc[before]) > 0;
        let far = px(i);
        for (let k = before; k <= conf; k++) far = dir > 0 ? Math.min(far, bars[k].l) : Math.max(far, bars[k].h);
        let level = NaN;
        if (before >= RULES.levelCandles) { level = px(before - 1); for (let k = before - RULES.levelCandles; k < before; k++) level = dir > 0 ? Math.min(level, bars[k].l) : Math.max(level, bars[k].h); }
        const dAtr = m.day.get(bars[conf].date);
        const atLevel = Number.isFinite(level) && Number.isFinite(dAtr) && Math.abs(px(i) - level) <= RULES.levelDayAtr * dAtr;
        const fill = marketEntry(m, bars[conf].last + 1, dir, costs);
        for (const take of RULES.takes) put(`B|${name}|${right}|${take}|${div ? "pattern" : "control"}`, holdR(m, fill, dir, far - dir * m.s.pip, take, life, costs), { part: "B", name, i, before, conf, dir, atLevel });
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
  if (trades.length === 0) return { n: 0, meanR: NaN, t: NaN, win: NaN, coin: NaN };
  const byWeek = new Map();
  for (const c of trades) { const wk = Math.floor((Date.parse(`${c.t.date}T00:00:00Z`) / 86400e3 + 3) / 7); byWeek.set(wk, (byWeek.get(wk) ?? 0) + c.t.r); }
  const w = [...byWeek.values()], mw = mean(w);
  const sd = Math.sqrt(mean(w.map((x) => (x - mw) ** 2)) * (w.length / Math.max(1, w.length - 1)));
  const rs = trades.map((c) => c.t.r);
  return { n: rs.length, meanR: mean(rs), t: mw / (sd / Math.sqrt(w.length)), win: rs.filter((r) => r > 0).length / rs.length, coin: mean(trades.map((c) => 1 / (1 + c.t.rr))) };
}

// ------------------------------------------------------------------ pictures
const n1 = (v) => v.toFixed(1);
const ENDS = { stop: "стоп", take: "тейк", time: "закрыта по сроку" };
function frame(m, c, upperH, extraPrices) {
  const { bars, of } = m.tf[c.name], t = c.t;
  const first = c.part === "A" ? c.j - 1 : c.before;
  const from = Math.max(0, first - 24), to = Math.min(bars.length - 1, of[t.x] + 6), view = bars.slice(from, to + 1);
  const W = 760, padL = 8, padR = 70;
  const top = Math.max(...view.map((b) => b.h), t.take, t.stop, ...extraPrices), bottom = Math.min(...view.map((b) => b.l), t.take, t.stop, ...extraPrices);
  const x = (i) => padL + ((i - from + 0.5) * (W - padL - padR)) / view.length, y = (p) => 12 + ((top - p) * (upperH - 24)) / (top - bottom);
  const bw = Math.max(1.5, ((W - padL - padR) / view.length) * 0.6);
  const candles = view.map((b, n) => { const i = from + n, up = b.c >= b.o; return `<line x1="${n1(x(i))}" x2="${n1(x(i))}" y1="${n1(y(b.h))}" y2="${n1(y(b.l))}" class="${up ? "up" : "dn"}"/><rect x="${n1(x(i) - bw / 2)}" y="${n1(y(Math.max(b.o, b.c)))}" width="${n1(bw)}" height="${n1(Math.max(1, Math.abs(y(b.o) - y(b.c))))}" class="${up ? "upf" : "dnf"}"/>`; }).join("");
  const entryBar = of[t.e];
  const hline = (p, cls, label, fromBar = entryBar) => `<line x1="${n1(x(fromBar))}" x2="${W - padR}" y1="${n1(y(p))}" y2="${n1(y(p))}" class="${cls}"/><text x="${W - padR + 4}" y="${n1(y(p) + 4)}" class="lbl">${label}</text>`;
  return { bars, from, to, view, W, padL, padR, x, y, bw, candles, entryBar, hline };
}
/** A: the two candles in a box, the grid on the second one, the order and its end. */
function cardA(m, c, title) {
  const t = c.t, H = 320, level = (v) => c.zero + c.dir * v * c.range;
  const fr = frame(m, c, H, [level(1.618)]);
  const { x, y, bw, W, padR } = fr, p = fr.bars[c.j - 1], b = fr.bars[c.j];
  const box = `<rect x="${n1(x(c.j - 1) - bw)}" y="${n1(y(Math.max(p.h, b.h)) - 3)}" width="${n1(x(c.j) - x(c.j - 1) + 2 * bw)}" height="${n1(y(Math.min(p.l, b.l)) - y(Math.max(p.h, b.h)) + 6)}" class="box"/>`;
  const grid = [0.382, 0.5, 1].map((v) => `<line x1="${n1(x(c.j))}" x2="${W - padR}" y1="${n1(y(level(v)))}" y2="${n1(y(level(v)))}" class="grid"/><text x="${n1(x(c.j) + bw + 3)}" y="${n1(y(level(v)) - 3)}" class="sm">${v}</text>`).join("");
  const mark = `<line x1="${n1(x(fr.entryBar))}" x2="${n1(x(fr.entryBar))}" y1="12" y2="${H - 12}" class="entry"/>`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${fr.candles}${box}${grid}${mark}${fr.hline(t.entry, "ent", "вход")}${fr.hline(t.stop, "stp", "стоп (0)", c.j)}${fr.hline(t.take, "tp", "цель", c.j)}</svg>`;
  const digits = m.s.digits === 3 ? 3 : 5;
  return `<section><h2>${title}</h2><p>${t.dir > 0 ? "Покупка" : "Продажа"} ${t.entry.toFixed(digits)}, стоп ${t.stop.toFixed(digits)}, цель ${t.take.toFixed(digits)} (1 к ${t.rr.toFixed(1)}). Итог: ${ENDS[t.reason]} (${f(t.r, 2)} R после издержек).</p>${svg}</section>`;
}
/** B: the candles with the two price extremes joined, RSI under them with its two turns joined. */
function cardB(m, c, title) {
  const t = c.t, upper = 250, lower = 90, H = upper + lower;
  const fr = frame(m, c, upper, []);
  const { x, y, W, padL, padR, from, to, bars } = fr, osc = m.tf[c.name].osc;
  const px = (k) => (c.dir > 0 ? bars[k].l : bars[k].h);
  const yr = (v) => upper + 6 + ((100 - v) * (lower - 12)) / 100;
  const points = [];
  for (let i = from; i <= to; i++) if (Number.isFinite(osc[i])) points.push(`${n1(x(i))},${n1(yr(osc[i]))}`);
  const band = [30, 70].map((v) => `<line x1="${padL}" x2="${W - padR}" y1="${n1(yr(v))}" y2="${n1(yr(v))}" class="grid"/><text x="${W - padR + 4}" y="${n1(yr(v) + 4)}" class="sm">${v}</text>`).join("");
  const join = `<line x1="${n1(x(c.before))}" y1="${n1(y(px(c.before)))}" x2="${n1(x(c.i))}" y2="${n1(y(px(c.i)))}" class="fig"/><line x1="${n1(x(c.before))}" y1="${n1(yr(osc[c.before]))}" x2="${n1(x(c.i))}" y2="${n1(yr(osc[c.i]))}" class="fig"/>`;
  const mark = `<line x1="${n1(x(fr.entryBar))}" x2="${n1(x(fr.entryBar))}" y1="12" y2="${H - 6}" class="entry"/>`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${fr.candles}${band}<polyline points="${points.join(" ")}" class="osc"/>${join}${mark}${fr.hline(t.entry, "ent", "вход")}${fr.hline(t.stop, "stp", "стоп")}${fr.hline(t.take, "tp", "тейк")}<text x="${W - padR + 4}" y="${upper + 14}" class="sm">RSI 14</text></svg>`;
  const digits = m.s.digits === 3 ? 3 : 5;
  return `<section><h2>${title}</h2><p>${t.dir > 0 ? "Покупка: цена сделала минимум ниже, RSI — выше" : "Продажа: цена сделала максимум выше, RSI — ниже"}. Вход ${t.entry.toFixed(digits)}, стоп ${t.stop.toFixed(digits)}, тейк ${t.take.toFixed(digits)}. Итог: ${ENDS[t.reason]} (${f(t.r, 2)} R после издержек).</p>${svg}</section>`;
}
function page(heading, lead, cards) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Записи из чата</title><style>
:root{--bg:#fff;--fg:#1c1c1c;--mut:#6b6b6b;--up:#1a8f5a;--dn:#c0392b;--fig:#2456c7;--line:#888}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#a0a0a0;--up:#3fbf85;--dn:#e06c5c;--fig:#7aa2ff;--line:#999}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:820px;margin-inline:auto}
h1{font-size:22px}h2{font-size:17px;margin:28px 0 4px}p{margin:4px 0 8px;color:var(--mut)}svg{width:100%;height:auto;display:block}
.up{stroke:var(--up)}.dn{stroke:var(--dn)}.upf{fill:var(--up)}.dnf{fill:var(--dn)}.fig{stroke:var(--fig);stroke-width:2}.box{fill:none;stroke:var(--fig);stroke-width:1.5}
.entry{stroke:var(--line);stroke-dasharray:4 4}.grid{stroke:var(--line);stroke-width:.6;stroke-dasharray:2 4}.osc{fill:none;stroke:var(--fg);stroke-width:1.2}
.ent{stroke:var(--fg)}.stp{stroke:var(--dn);stroke-dasharray:6 3}.tp{stroke:var(--up);stroke-dasharray:6 3}.lbl{fill:var(--fg);font-size:12px}.sm{fill:var(--mut);font-size:10px}
</style></head><body><h1>${heading}</h1><p>${lead}</p>${cards.join("\n")}</body></html>`;
}

// ------------------------------------------------------------------ run
const net = new Map(), gross = new Map(), markets = new Map();
const merge = (into, from) => { for (const [k, v] of from) into.set(k, (into.get(k) ?? []).concat(v)); };
for (const symbol of PAIRS) {
  const m = build(symbol, "2015-01-01", TO);
  markets.set(symbol, m);
  merge(net, candidates(symbol, m, true)); merge(gross, candidates(symbol, m, false));
}
const pick = (map, key, test) => sequence((map.get(key) ?? []).filter(test).sort((x, y) => x.t.e - y.t.e));

if (windowMode) {
  // The mechanics on a few weeks that belong to no dataset: every trade of a few variants with its prices.
  console.log(`Trades between ${FROM} and ${TO} (before dev begins; the daily ATR here is of ${DAY_ATR} days). For checking the mechanics only.`);
  for (const key of ["A|H1|0.5|1.618|pattern", "A|H1|0.382|2.618|pattern", "A|M15|0.5|1.618|pattern", "A|H4|0.5|1.618|control", "B|H1|5|1|pattern", "B|H1|2|1.5|control"]) {
    for (const [label, map] of [["after costs", net], ["before costs", gross]]) {
      const list = pick(map, key, () => true);
      console.log(`--- ${key}, ${label}: ${list.length} trades`);
      for (const c of list.slice(0, 6)) {
        const m = markets.get(c.symbol), b = m.m15[c.t.e], x = m.m15[c.t.x], d = m.s.digits, bars = m.tf[c.name].bars;
        const what = c.part === "A" ? `candle ${bars[c.j].date} ${String(bars[c.j].hour).padStart(2, "0")}h o ${bars[c.j].o.toFixed(d)} h ${bars[c.j].h.toFixed(d)} l ${bars[c.j].l.toFixed(d)} c ${bars[c.j].c.toFixed(d)}${c.atExtreme ? " extreme" : ""}${c.withTrend ? " trend" : ""}` : `rsi turns ${bars[c.before].date} ${m.tf[c.name].osc[c.before].toFixed(1)} -> ${bars[c.i].date} ${String(bars[c.i].hour).padStart(2, "0")}h ${m.tf[c.name].osc[c.i].toFixed(1)}${c.atLevel ? " level" : ""}`;
        console.log(`  ${c.symbol} ${what} | ${c.t.dir > 0 ? "buy " : "sell"} ${b.date} ${String(b.hour).padStart(2, "0")}:${String(b.minute).padStart(2, "0")} at ${c.t.entry.toFixed(d)} stop ${c.t.stop.toFixed(d)} take ${c.t.take.toFixed(d)} rr ${c.t.rr.toFixed(2)} -> ${c.t.reason} ${x.date} ${String(x.hour).padStart(2, "0")}:${String(x.minute).padStart(2, "0")} r ${f(c.t.r, 2)}`);
      }
    }
  }
} else {
  const months = (Date.parse(DEV_TO) - Date.parse(DEV_FROM)) / (86400e3 * 30.44);
  const cells = [];
  const row = (label, stem, test = () => true) => {
    const tr = pick(net, `${stem}|pattern`, test), all = summary(tr), gs = summary(pick(gross, `${stem}|pattern`, test));
    const a = summary(tr.filter((c) => c.t.date < SPLIT)), b = summary(tr.filter((c) => c.t.date >= SPLIT));
    const plus = PAIRS.filter((p) => mean(tr.filter((c) => c.symbol === p).map((c) => c.t.r)) > 0).length;
    const cn = summary(pick(net, `${stem}|control`, test)), cg = summary(pick(gross, `${stem}|control`, test));
    cells.push({ label: `${stem} ${label}`, n: all.n, perMonth: all.n / months, before: gs.meanR, after: all.meanR, t: all.t });
    console.log(`${pad(label, 34)} ${lpad(all.n, 6)} ${lpad((all.n / months).toFixed(1), 6)} ${lpad(f(gs.meanR), 7)} ${lpad(f(all.meanR), 7)} ${lpad(f(all.t, 1), 5)} ${lpad(pct(gs.win), 5)} ${lpad(pct(gs.coin), 5)} | ${lpad(f(a.meanR), 7)} | ${lpad(f(b.meanR), 7)} | ${plus}/${PAIRS.length} || ${lpad(cn.n, 6)} ${lpad(f(cg.meanR), 7)} ${lpad(f(cn.meanR), 7)} ${lpad(pct(cg.win), 5)}`);
  };
  const head = (title) => { console.log(`\n=== ${title} ===`); console.log(`${pad("", 34)} ${lpad("n", 6)} ${lpad("/mo", 6)} ${lpad("before", 7)} ${lpad("after", 7)} ${lpad("t", 5)} ${lpad("wins", 5)} ${lpad("coin", 5)} | ${lpad("1st", 7)} | ${lpad("2nd", 7)} | pairs+ || control: n, before, after, wins`); };
  console.log(`Two notes from the chat, dev ${DEV_FROM} .. ${DEV_TO}. R = the distance from the entry to the stop; "before" and "wins" are before costs; t counts weeks.`);
  console.log(`"coin" is the share of wins that gives 0 R at these targets. The control stands to the right of every row.`);
  const contexts = [["every pattern", () => true], ["at a 20-candle extreme", (c) => c.atExtreme], ["with the trend by swings", (c) => c.withTrend]];
  for (const name of Object.keys(TF)) {
    for (const e of RULES.entries) for (const target of RULES.targets) {
      head(`A. Fibo + engulfing, ${name}: entry at ${e}, target ${target}`);
      for (const [label, test] of contexts) row(label, `A|${name}|${e}|${target}`, test);
    }
  }
  for (const name of ["H4", "H1"]) for (const right of RULES.rights) for (const take of RULES.takes) {
    head(`B. RSI divergence, ${name}: ${right} candles on the right, take 1:${take}`);
    row("every divergence", `B|${name}|${right}|${take}`);
    row("at a level", `B|${name}|${right}|${take}`, (c) => c.atLevel);
  }
  const big = cells.filter((c) => c.n >= 30 && Math.abs(c.t) >= 2);
  console.log(`\nCells counted: ${cells.length} (each with its control). With 30+ trades: ${cells.filter((c) => c.n >= 30).length}; of them |t| >= 2: ${big.length} (${big.filter((c) => c.t > 0).length} above zero), expected by chance about ${(cells.filter((c) => c.n >= 30).length * 0.05).toFixed(0)}.`);
  console.log(`After costs above zero: ${cells.filter((c) => c.n >= 30 && c.after > 0).length}; before costs above zero: ${cells.filter((c) => c.n >= 30 && c.before > 0).length}.`);
  for (const key of ["A|M15|0.5|1.618|pattern", "A|H1|0.5|1.618|pattern", "A|H4|0.5|1.618|pattern", "B|H4|5|1|pattern", "B|H1|5|1|pattern"]) {
    const tr = pick(net, key, () => true), gr = pick(gross, key, () => true);
    if (tr.length === 0) continue;
    const pips = tr.map((c) => Math.abs(c.t.entry - c.t.stop) / markets.get(c.symbol).s.pip).sort((x, y) => x - y), reasons = {};
    for (const c of tr) reasons[c.t.reason] = (reasons[c.t.reason] ?? 0) + 1;
    console.log(`${pad(key, 26)} median stop ${pips[Math.floor(pips.length / 2)].toFixed(0)} pips; costs take ${(mean(gr.map((c) => c.t.r)) - mean(tr.map((c) => c.t.r))).toFixed(3)} R a trade; buys ${f(mean(tr.filter((c) => c.t.dir > 0).map((c) => c.t.r)))} R, sells ${f(mean(tr.filter((c) => c.t.dir < 0).map((c) => c.t.r)))} R; ended: ${Object.entries(reasons).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  if (galleryFile !== undefined) {
    // The first cases in time order on EURUSD from 2019, with no selection by result.
    const firstOf = (key, n) => pick(net, key, (c) => c.symbol === "EURUSD" && c.t.date >= "2019-01-01").slice(0, n);
    const cards = [
      ...firstOf("A|H1|0.5|1.618|pattern", 6).map((c) => cardA(markets.get(c.symbol), c, `Фибо + поглощение, H1 — ${c.symbol}, ${c.t.date}`)),
      ...firstOf("B|H4|5|1|pattern", 6).map((c) => cardB(markets.get(c.symbol), c, `Расхождение RSI, H4 — ${c.symbol}, ${c.t.date}`)),
    ];
    mkdirSync(path.dirname(galleryFile), { recursive: true });
    writeFileSync(galleryFile, page("Как программа видит «фибо + поглощение» и расхождение RSI", "Первые по порядку случаи на EURUSD с 2019 года, без отбора по результату: среди них есть и убыточные. В рамке — две свечи поглощения; тонкий пунктир — уровни сетки 0,382, 0,5 и 1. У расхождения синие линии соединяют два экстремума цены и два разворота RSI. Серый пунктир — момент входа.", cards));
    console.log(`\n${cards.length} pictures written to ${galleryFile}`);
  }
}
