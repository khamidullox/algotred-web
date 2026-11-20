// The check of fx-levels.mjs on one-minute bars (TZ 17.27). On M15 a level
// (a round number, an earlier high or low) is broken more often than held.
// The question here: can an order take that move, or is it gone in the minute
// of the touch? EURUSD, GBPUSD and USDJPY (the pairs with M1 files), dev only.
//
// For every touch the trade in the direction of the break is measured four
// times with the same stop and target S on the two sides of its entry:
//   at the level itself (a stop order resting at the level, filled with no slip),
//   at the open of the next minute, 5 minutes later, 15 minutes later
//   (a market order; the stop and the target are counted from its own price).
// If the move lives only in the first column, it is the jump through the
// level: a resting stop order is filled after it, not before.
//
// Usage: node research/fx-levels-m1.mjs
import { closeSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = (process.env.PAIRS ?? "EURUSD,GBPUSD,USDJPY").split(",");
const FROM = "2015-02-02", TO = "2021-12-08", SPLIT = "2019-01-01";
const ZIGZAG = 2, DAY = 1440, LIMIT = 5 * DAY;
const LIFE = { H1: 20 * DAY, H4: 60 * DAY, D1: 180 * DAY };
const DELAYS = [0, 5, 15]; // minutes after the minute of the touch

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length === 0 ? NaN : s[Math.floor(s.length / 2)]; };
const f = (x, d = 3) => (!Number.isFinite(x) ? "  n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const months = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.44);
const weekOf = (date) => Math.floor((Date.parse(`${date}T00:00:00Z`) / 86400e3 + 3) / 7);

// ------------------------------------------------------------------ data
/** Reads the file in pieces and stops at the first line after dev: nothing later is parsed. */
function load(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const file = readdirSync(config.dataDir).find((n) => n.startsWith(`${symbol}_M1_`));
  const minSpread = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  const cap = 2_800_000;
  const o = new Float64Array(cap), h = new Float64Array(cap), l = new Float64Array(cap), c = new Float64Array(cap), cost = new Float32Array(cap);
  const day = new Int32Array(cap), hour = new Uint8Array(cap), days = [];
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
      if (d > TO) { done = true; break; }
      if (days.length === 0 || days[days.length - 1] !== d) days.push(d);
      day[n] = days.length - 1; hour[n] = +p[1].slice(0, 2);
      o[n] = +p[2]; h[n] = +p[3]; l[n] = +p[4]; c[n] = +p[5];
      cost[n] = Math.max(+p[8], minSpread) * point + 2 * config.costs.slippagePips * pip + (own.usdSide === "base" ? commission * c[n] : commission);
      n++;
    }
  }
  closeSync(fd);
  const m = { symbol, pip, n, o, h, l, c, cost, day, hour, days, dateOf: (i) => days[day[i]] };
  const agg = (keyOf) => { const bars = []; let key = -1; for (let i = 0; i < n; i++) { const k = keyOf(i); if (k !== key) { bars.push({ o: o[i], h: h[i], l: l[i], c: c[i], last: i }); key = k; } else { const t = bars[bars.length - 1]; if (h[i] > t.h) t.h = h[i]; if (l[i] < t.l) t.l = l[i]; t.c = c[i]; t.last = i; } } return bars; };
  m.tf = { H1: agg((i) => day[i] * 24 + hour[i]), H4: agg((i) => day[i] * 6 + Math.floor(hour[i] / 4)), D1: agg((i) => day[i]) };
  const dAtr = atr(m.tf.D1, 20);
  m.atrAt = (i) => (day[i] === 0 ? NaN : dAtr[day[i] - 1]); // the daily ATR(20) known at the open of the day
  return m;
}
function sma(xs, n) { const out = new Array(xs.length).fill(NaN); let s = 0; for (let i = 0; i < xs.length; i++) { s += xs[i]; if (i >= n) s -= xs[i - n]; if (i + 1 >= n) out[i] = s / n; } return out; }
function atr(bars, n) { return sma(bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)))), n); }
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
/** The highest (sign +1) or lowest (sign -1) value of the W bars before each bar. */
function rolling(xs, n, W, sign) {
  const out = new Float64Array(n).fill(NaN), q = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (i >= W) { while (head < tail && q[head] < i - W) head++; out[i] = xs[q[head]]; }
    while (head < tail && sign * xs[q[tail - 1]] <= sign * xs[i]) tail--;
    q[tail++] = i;
  }
  return out;
}

// ------------------------------------------------------------------ the measure
/** From bar j on: +1 if P + S comes first, -1 if P - S, a share at the time limit. `skipDown`: on bar j only the upper side counts (or only the lower with -1). */
function barrier(m, j, P, S, firstBarOnly = 0) {
  const up = P + S, down = P - S, end = Math.min(m.n - 1, j + LIMIT);
  for (let k = j; k <= end; k++) {
    let hitUp = m.h[k] >= up, hitDown = m.l[k] <= down;
    if (k === j && firstBarOnly !== 0) { if (firstBarOnly > 0) hitDown = false; else hitUp = false; }
    if (!hitUp && !hitDown) continue;
    if (hitUp && hitDown) return m.c[k] >= m.o[k] ? -1 : 1; // a rising bar is read as low first
    return hitUp ? 1 : -1;
  }
  return (m.c[end] - P) / S;
}
const out = new Map();
/** One touch of level L on bar i from below (side +1) or from above (-1); everything is stored in the direction of the break. */
function touch(key, m, i, L, side, S) {
  // At the level: on the minute of the touch only the side beyond the level is known to come after the touch.
  const atLevel = side * barrier(m, i, L, S, side);
  const rec = { date: m.dateOf(i), atLevel, beyond: (side * ((side > 0 ? m.h[i] : m.l[i]) - L)) / m.pip, later: [], costs: [], gap: [] };
  for (const d of DELAYS) {
    const j = i + 1 + d;
    if (j >= m.n) { rec.later.push(NaN); rec.costs.push(NaN); rec.gap.push(NaN); continue; }
    const P = m.o[j];
    rec.later.push(side * barrier(m, j, P, S));
    rec.costs.push(m.cost[j] / S);
    rec.gap.push((side * (P - L)) / m.pip);
  }
  if (!out.has(key)) out.set(key, []);
  out.get(key).push(rec);
  return atLevel;
}

for (const symbol of PAIRS) {
  const m = load(symbol);
  console.error(`${symbol}: ${m.n} one-minute bars, ${m.days[0]} .. ${m.days[m.days.length - 1]}`);
  const first = m.day.findIndex((d) => m.days[d] >= FROM);
  // A. Round numbers and the grid that is not round.
  const maxH = rolling(m.h, m.n, DAY, 1), minL = rolling(m.l, m.n, DAY, -1), step = 100 * m.pip;
  for (const [label, offsets] of [["round 00 and 50", [0, 50]], ["control grid 13/37/63/87", [13, 37, 63, 87]]]) for (const k of [0.25, 0.5]) {
    for (const off of offsets) for (let i = Math.max(first, DAY); i < m.n; i++) {
      const S = k * m.atrAt(i);
      if (!Number.isFinite(S)) continue;
      const shift = off * m.pip;
      const upL = (Math.floor((maxH[i] - shift) / step + 1e-9) + 1) * step + shift;
      if (upL <= m.h[i] && m.o[i] < upL) touch(`${label}|${k}`, m, i, upL, 1, S);
      const downL = (Math.ceil((minL[i] - shift) / step - 1e-9) - 1) * step + shift;
      if (downL >= m.l[i] && m.o[i] > downL) touch(`${label}|${k}`, m, i, downL, -1, S);
    }
  }
  // B. Earlier highs and lows; a level is dropped once it is broken.
  for (const tfName of ["H1", "H4", "D1"]) for (const k of [0.25, 0.5]) {
    const bars = m.tf[tfName];
    for (const sw of zigzag(bars)) {
      const start = bars[sw.conf].last + 1, end = Math.min(m.n - 1, start + LIFE[tfName]);
      const side = sw.type === "H" ? 1 : -1, L = sw.price;
      for (let j = start; j <= end; j++) {
        if (side > 0 ? m.h[j] < L : m.l[j] > L) continue;
        if (j < first) break;
        if (side > 0 ? m.o[j] > L : m.o[j] < L) break; // a gap through the level
        const S = k * m.atrAt(j);
        if (!Number.isFinite(S)) break;
        if (touch(`swings ${tfName}|${k}`, m, j, L, side, S) !== -1) break; // the level broke (or no outcome): dropped
        // The level held: the price is S away from it, the next return is the next test.
        let x = j + 1; while (x <= end && (side > 0 ? m.l[x] > L - S : m.h[x] < L + S)) x++;
        j = x;
      }
    }
  }
}

function tByWeeks(list, get) {
  const sum = new Map();
  for (const t of list) { const v = get(t); if (!Number.isFinite(v)) continue; const k = weekOf(t.date); sum.set(k, (sum.get(k) ?? 0) + v); }
  let a = 0, b = 0;
  for (const v of sum.values()) { a += v; b += v * v; }
  return b === 0 ? NaN : a / Math.sqrt(b);
}
console.log(`pairs ${PAIRS.join(", ")}; the result of the trade in the direction of the break, in shares of S, before costs (t by weeks); "after" is the next-minute entry after costs`);
console.log(`${pad("", 34)}touches a month   at the level     next minute      +5 min           +15 min          after     past the level in the touch minute / at the next open, pips (mean; median)   next minute: 2015-18 / 2019-21`);
for (const [key, list] of out) {
  const [label, k] = key.split("|");
  const col = (get) => `${f(mean(list.map(get).filter(Number.isFinite)))} (${f(tByWeeks(list, get), 1)})`;
  const a = list.filter((t) => t.date < SPLIT), z = list.filter((t) => t.date >= SPLIT);
  console.log(`${pad(`${label}, S ${k} ATR`, 34)}${lpad(list.length, 7)}${lpad((list.length / months).toFixed(0), 6)}   ${col((t) => t.atLevel)}   ${col((t) => t.later[0])}   ${col((t) => t.later[1])}   ${col((t) => t.later[2])}   ${f(mean(list.map((t) => t.later[0] - t.costs[0]).filter(Number.isFinite)))}    ${f(mean(list.map((t) => t.beyond)), 2)}; ${f(median(list.map((t) => t.beyond)), 2)} / ${f(mean(list.map((t) => t.gap[0]).filter(Number.isFinite)), 2)}; ${f(median(list.map((t) => t.gap[0]).filter(Number.isFinite)), 2)}        ${f(mean(a.map((t) => t.later[0]).filter(Number.isFinite)))} / ${f(mean(z.map((t) => t.later[0]).filter(Number.isFinite)))}`);
}
