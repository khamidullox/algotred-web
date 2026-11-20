// Do levels hold on currencies? (TZ 17.27.) Two kinds of level from the last
// batch of the videos: round numbers ("the market rounds like people do") and
// earlier highs and lows by the number of the test ("a zone tested for the
// third time is weaker"). Seven dollar pairs, M15, dev only.
//
// One measure for every level. When the price comes to a level L, a trade
// against the approach is opened at L with the stop and the target at the same
// distance S (a share of the daily ATR) on the two sides. Without an edge it
// wins half of the time. More than half: the level holds (fade it). Less than
// half: the level breaks (trade the break). The two trades are mirror images
// before costs, so one number serves both.
//
// The control is a grid of levels that are not round (13, 37, 63 and 87 pips
// inside a hundred): the same approach, the same trade, no idea in the level.
//
// On the bar of the touch the far side of the stop counts (it lies beyond the
// level, so it came after the touch), the target does not (that part of the
// bar came before the touch). When a later bar holds both, a rising bar is
// read as low first, a falling bar as high first.
//
// Parts: A round numbers, B earlier highs and lows by the number of the test
// (mode touch); C a market order after the touch in the direction of the break
// (follow); D the same by the hour, the age and the roundness of the level, and
// the extremes of the day and the week before (where); E hour by hour (ny);
// F the day of the Fed decision, one number a day (fed); G the move in pips
// against the costs, pair by pair (pips).
//
// Usage: node research/fx-levels.mjs [touch|follow|where|ny|fed|pips|all]
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = (process.env.PAIRS ?? "EURUSD,GBPUSD,USDJPY,AUDUSD,NZDUSD,USDCAD,USDCHF").split(",");
const FROM = "2015-02-02", TO = "2021-12-08", SPLIT = "2019-01-01";
const ZIGZAG = 2;            // ATR(14) of pullback that confirms a swing (as in fx-classic.mjs)
const LIMIT = 5 * 96;        // M15 bars a trade may last
const FOLLOW_LIMIT = 10 * 96; // the same for a trade that follows the break
const mode = process.argv[2] ?? "all";
const touchMode = mode === "all" || mode === "touch", followMode = mode === "all" || mode === "follow";
const weekday = (date) => new Date(date + "T00:00:00Z").getUTCDay();
const LIFE = { H1: 20 * 96, H4: 60 * 96, D1: 180 * 96 }; // M15 bars a swing level is watched

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f = (x, d = 3) => (!Number.isFinite(x) ? "  n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const months = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.44);
const weekOf = (date) => Math.floor((Date.parse(`${date}T00:00:00Z`) / 86400e3 + 3) / 7);

// ------------------------------------------------------------------ data
function load(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const date = [], o = [], h = [], l = [], c = [], cost = [], hour = [];
  const minSpread = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const d = p[0].replaceAll(".", "-");
    if (d > TO) break; // nothing after dev is read
    date.push(d); hour.push(+p[1].slice(0, 2)); o.push(+p[2]); h.push(+p[3]); l.push(+p[4]); c.push(+p[5]);
    // One round trip as a price distance: spread (not below the floor), slippage on two fills, commission.
    cost.push(Math.max(+p[8], minSpread) * point + 2 * config.costs.slippagePips * pip + (own.usdSide === "base" ? commission * +p[5] : commission));
  }
  const m = { symbol, pip, date, hour, o, h, l, c, cost, n: date.length, swapLong: own.swapLongPips * pip, swapShort: own.swapShortPips * pip };
  // Swap nights charged before each bar: one a night, three after a Wednesday.
  m.nights = new Array(m.n).fill(0);
  for (let i = 1; i < m.n; i++) m.nights[i] = m.nights[i - 1] + (date[i] === date[i - 1] ? 0 : weekday(date[i - 1]) === 3 ? 3 : 1);
  // Bars of higher timeframes; `last` is the M15 bar that closes them.
  const agg = (keyOf) => { const bars = []; let key = null; for (let i = 0; i < m.n; i++) { const k = keyOf(i); if (k !== key) { bars.push({ date: date[i], o: o[i], h: h[i], l: l[i], c: c[i], last: i }); key = k; } else { const t = bars[bars.length - 1]; t.h = Math.max(t.h, h[i]); t.l = Math.min(t.l, l[i]); t.c = c[i]; t.last = i; } } return bars; };
  m.tf = { H1: agg((i) => `${date[i]} ${hour[i]}`), H4: agg((i) => `${date[i]} ${Math.floor(hour[i] / 4)}`), D1: agg((i) => date[i]) };
  // The daily ATR(20) known at the open of a day.
  const dAtr = atr(m.tf.D1, 20);
  m.atrOfDay = new Map();
  m.tf.D1.forEach((b, i) => { if (i > 0) m.atrOfDay.set(b.date, dAtr[i - 1]); });
  return m;
}
function sma(xs, n) { const out = new Array(xs.length).fill(NaN); let s = 0; for (let i = 0; i < xs.length; i++) { s += xs[i]; if (i >= n) s -= xs[i - n]; if (i + 1 >= n) out[i] = s / n; } return out; }
function atr(bars, n) { return sma(bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)))), n); }
/** Swings with no look-ahead: a high is confirmed by a close ZIGZAG x ATR(14) below it (bar `conf`). */
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
function rolling(xs, W, sign) {
  const out = new Array(xs.length).fill(NaN), q = [];
  for (let i = 0; i < xs.length; i++) {
    if (i >= W) { while (q.length > 0 && q[0] < i - W) q.shift(); out[i] = xs[q[0]]; }
    while (q.length > 0 && sign * xs[q[q.length - 1]] <= sign * xs[i]) q.pop();
    q.push(i);
  }
  return out;
}

// ------------------------------------------------------------------ the measure
/**
 * The trade against the approach at level L touched on bar i. `side` +1: the price came from below
 * (sell at L), -1: from above (buy at L). Stop and target S away. Returns r (+1 the level held,
 * -1 it broke, a share when the time ran out) and the bar of the exit.
 */
function fade(m, i, L, side, S) {
  const up = L + S, down = L - S;
  // The bar of the touch: only the side beyond the level is known to come after the touch.
  if (side > 0 ? m.h[i] >= up : m.l[i] <= down) return { r: -1, x: i };
  const end = Math.min(m.n - 1, i + LIMIT);
  for (let j = i + 1; j <= end; j++) {
    const hitUp = m.h[j] >= up, hitDown = m.l[j] <= down;
    if (!hitUp && !hitDown) continue;
    const first = hitUp && hitDown ? (m.c[j] >= m.o[j] ? "down" : "up") : hitUp ? "up" : "down";
    return { r: (first === "down") === (side > 0) ? 1 : -1, x: j };
  }
  return { r: (side * (L - m.c[end])) / S, x: end };
}
function record(list, m, i, L, side, S, extra) {
  const { r, x } = fade(m, i, L, side, S);
  list.push({ r, cost: m.cost[i] / S, date: m.date[i], symbol: m.symbol, ...extra });
  return { r, x };
}
/** t of the mean result with the weeks as the unit: touches of one week are not independent. */
function tByWeeks(list) {
  const sum = new Map();
  for (const t of list) { const k = weekOf(t.date); sum.set(k, (sum.get(k) ?? 0) + t.r); }
  let a = 0, b = 0;
  for (const v of sum.values()) { a += v; b += v * v; }
  return b === 0 ? NaN : a / Math.sqrt(b);
}
function row(label, list) {
  if (list.length < 20) { console.log(`${pad(label, 38)}${lpad(list.length, 7)}   too few`); return; }
  const decided = list.filter((t) => Math.abs(t.r) === 1);
  const hit = decided.filter((t) => t.r === 1).length / decided.length;
  const g = mean(list.map((t) => t.r)), cost = mean(list.map((t) => t.cost));
  const a = list.filter((t) => t.date < SPLIT), z = list.filter((t) => t.date >= SPLIT);
  console.log(`${pad(label, 38)}${lpad(list.length, 7)}${lpad((list.length / months).toFixed(1), 8)}   ${lpad((hit * 100).toFixed(1), 5)}%   ${f(g)} (${f(tByWeeks(list), 1)})   ${f(g - cost)}   ${f(-g - cost)}    ${f(mean(a.map((t) => t.r)))} / ${f(mean(z.map((t) => t.r)))}`);
}
const HEAD = `${pad("", 38)} touches  a month   held    fade before costs (t by weeks)   fade after   break after    fade before: 2015-18 / 2019-21`;

const market = PAIRS.map(load);

// ------------------------------------------------------------------ A. round numbers
const GRIDS = [["00 (every 100 pips)", [0]], ["50", [50]], ["25 and 75", [25, 75]], ["control: 13, 37, 63, 87", [13, 37, 63, 87]]];
console.log(`== A. Round numbers: the first touch of a level after W bars away from it; stop and target k x daily ATR ==`);
for (const W of touchMode ? [96, 480] : []) for (const k of [0.125, 0.25, 0.5]) {
  console.log(`\n-- not touched for ${W / 96} day(s) before, stop and target ${k} ATR --\n${HEAD}`);
  for (const [label, offsets] of GRIDS) {
    const list = [];
    for (const m of market) {
      const step = 100 * m.pip, maxH = rolling(m.h, W, 1), minL = rolling(m.l, W, -1);
      for (const off of offsets) for (let i = W; i < m.n; i++) {
        if (m.date[i] < FROM) continue;
        const S = k * m.atrOfDay.get(m.date[i]);
        if (!Number.isFinite(S)) continue;
        const shift = off * m.pip;
        // From below: the lowest grid level above everything seen in the window and inside this bar.
        const upL = (Math.floor((maxH[i] - shift) / step + 1e-9) + 1) * step + shift;
        if (upL <= m.h[i] && m.o[i] < upL) record(list, m, i, upL, 1, S, {});
        const downL = (Math.ceil((minL[i] - shift) / step - 1e-9) - 1) * step + shift;
        if (downL >= m.l[i] && m.o[i] > downL) record(list, m, i, downL, -1, S, {});
      }
    }
    row(label, list);
  }
}

// ------------------------------------------------------------------ B. earlier highs and lows by the number of the test
console.log(`\n== B. Earlier highs and lows (swings confirmed by a pullback of ${ZIGZAG} ATR): every return to the level is a test; the swing itself is test 1 ==`);
console.log(`   a level lives while it holds: after a break (or ${LIMIT / 96} days without an outcome) it is dropped; "pressure": the lows before a high are rising (the highs before a low are falling)`);
for (const tfName of touchMode ? ["H1", "H4", "D1"] : []) for (const k of [0.25, 0.5]) {
  const list = [];
  for (const m of market) {
    const bars = m.tf[tfName], swings = zigzag(bars);
    swings.forEach((sw, si) => {
      const start = bars[sw.conf].last + 1, end = Math.min(m.n - 1, start + LIFE[tfName]);
      const side = sw.type === "H" ? 1 : -1, L = sw.price;
      // The structure before the level: the two swings of the other kind confirmed before this one.
      const others = [];
      for (let q = si - 1; q >= 0 && others.length < 2; q--) if (swings[q].type !== sw.type) others.push(swings[q]);
      const pressure = others.length === 2 && (side > 0 ? others[0].price > others[1].price : others[0].price < others[1].price);
      let test = 2;
      for (let j = start; j <= end; j++) {
        if (side > 0 ? m.h[j] < L : m.l[j] > L) continue;
        if (m.date[j] < FROM) break;
        if (side > 0 ? m.o[j] > L : m.o[j] < L) break; // a gap through the level: no fill at it
        const S = k * m.atrOfDay.get(m.date[j]);
        if (!Number.isFinite(S)) break;
        const { r, x } = record(list, m, j, L, side, S, { test, pressure });
        if (r !== 1) break; // broken, or no outcome in time
        test++; j = x;
      }
    });
  }
  console.log(`\n-- swings of ${tfName}, stop and target ${k} ATR --\n${HEAD}`);
  row("all tests", list);
  for (const n of [2, 3, 4]) row(`test ${n}`, list.filter((t) => t.test === n));
  row("test 5 and later", list.filter((t) => t.test >= 5));
  row("test 2, pressure into the level", list.filter((t) => t.test === 2 && t.pressure));
  row("test 2, no pressure", list.filter((t) => t.test === 2 && !t.pressure));
  row("test 3+, pressure into the level", list.filter((t) => t.test >= 3 && t.pressure));
  row("test 3+, no pressure", list.filter((t) => t.test >= 3 && !t.pressure));
}

// ------------------------------------------------------------------ C. following the break
/** A market order at the open of bar i in the direction `side`: stop S behind, target rr x S ahead. */
function follow(m, i, side, S, rr) {
  const P = m.o[i], stop = P - side * S, target = P + side * rr * S, end = Math.min(m.n - 1, i + FOLLOW_LIMIT);
  let r = NaN, x = end;
  for (let j = i; j <= end; j++) {
    const hitStop = side > 0 ? m.l[j] <= stop : m.h[j] >= stop;
    const hitTarget = side > 0 ? m.h[j] >= target : m.l[j] <= target;
    if (!hitStop && !hitTarget) continue;
    // Both in one bar: a rising bar is read as low first, a falling bar as high first.
    const lowFirst = m.c[j] >= m.o[j];
    r = hitStop && (!hitTarget || (side > 0) === lowFirst) ? -1 : rr;
    x = j;
    break;
  }
  if (Number.isNaN(r)) r = (side * (m.c[end] - P)) / S;
  return { r, x, cost: m.cost[i] / S, swap: ((m.nights[x] - m.nights[i]) * (side > 0 ? m.swapLong : m.swapShort)) / S };
}
function rowFollow(label, list, rr) {
  if (list.length < 20) { console.log(`${pad(label, 40)}${lpad(list.length, 7)}   too few`); return; }
  const g = mean(list.map((t) => t.r)), cost = mean(list.map((t) => t.cost)), swap = mean(list.map((t) => t.swap));
  const a = list.filter((t) => t.date < SPLIT), z = list.filter((t) => t.date >= SPLIT);
  const up = list.filter((t) => t.side > 0), down = list.filter((t) => t.side < 0);
  const pairs = PAIRS.filter((p) => mean(list.filter((t) => t.symbol === p).map((t) => t.r)) > 0).length;
  console.log(`${pad(label, 40)}${lpad(list.length, 7)}${lpad((list.length / months).toFixed(1), 8)}   ${lpad(((list.filter((t) => t.r === rr).length / list.length) * 100).toFixed(1), 5)}% / ${(100 / (1 + rr)).toFixed(0)}%   ${f(g)} (${f(tByWeeks(list), 1)})   ${f(g - cost)}   ${f(g - cost + swap)}    ${f(mean(a.map((t) => t.r)))} / ${f(mean(z.map((t) => t.r)))}    ${f(mean(up.map((t) => t.r)))} / ${f(mean(down.map((t) => t.r)))}    ${pairs} of ${PAIRS.length}`);
}
const HEAD_C = `${pad("", 40)} trades  a month   target hit / coin   before costs (t by weeks)   no swaps   with swaps    before: 2015-18 / 2019-21    up / down    pairs above zero`;
/** Every touch of every swing level of a timeframe; a level is dropped once the price has gone 0.5 ATR beyond it. */
function swingEvents(tfName) {
  const events = [];
  for (const m of market) {
    const bars = m.tf[tfName], swings = zigzag(bars);
    swings.forEach((sw, si) => {
      const start = bars[sw.conf].last + 1, end = Math.min(m.n - 2, start + LIFE[tfName]);
      const side = sw.type === "H" ? 1 : -1, L = sw.price;
      const others = [];
      for (let q = si - 1; q >= 0 && others.length < 2; q--) if (swings[q].type !== sw.type) others.push(swings[q]);
      const pressure = others.length === 2 && (side > 0 ? others[0].price > others[1].price : others[0].price < others[1].price);
      let test = 2;
      for (let j = start; j <= end; j++) {
        if (side > 0 ? m.h[j] < L : m.l[j] > L) continue;
        if (m.date[j] < FROM) break;
        if (side > 0 ? m.o[j] > L : m.o[j] < L) break;
        const atrNow = m.atrOfDay.get(m.date[j]);
        if (!Number.isFinite(atrNow)) break;
        const { r, x } = fade(m, j, L, side, 0.5 * atrNow);
        events.push({ m, j, i: j + 1, side, L, test, pressure, held: r, age: (j - bars[sw.idx].last) / 96 });
        if (r !== 1) break;
        test++; j = x;
      }
    });
  }
  return events;
}
function followAll(events, k, rr) {
  const list = [];
  for (const e of events) {
    const S = k * e.m.atrOfDay.get(e.m.date[e.i]);
    if (!Number.isFinite(S)) continue;
    list.push({ ...e, ...follow(e.m, e.i, e.side, S, rr), date: e.m.date[e.i], symbol: e.m.symbol });
  }
  return list;
}
if (followMode) {
  console.log(`\n== C. Following the break: after a touch of an earlier high or low, a market order at the open of the next M15 bar in the direction of the break ==`);
  console.log(`   the level is watched as in B (dropped once the price has gone 0.5 ATR beyond it); every touch is a trade here, positions are not limited`);
  for (const tfName of ["H1", "H4", "D1"]) {
    const events = swingEvents(tfName);
    for (const rr of [1, 2]) {
      console.log(`\n-- swings of ${tfName}, target ${rr} x stop --\n${HEAD_C}`);
      for (const k of [0.25, 0.5, 1, 2]) {
        const list = followAll(events, k, rr);
        rowFollow(`stop ${k} ATR`, list, rr);
        if (k === 1) {
          rowFollow("  stop 1 ATR, test 2", list.filter((t) => t.test === 2), rr);
          rowFollow("  stop 1 ATR, test 3 and later", list.filter((t) => t.test >= 3), rr);
          rowFollow("  stop 1 ATR, pressure into the level", list.filter((t) => t.pressure), rr);
          rowFollow("  stop 1 ATR, no pressure", list.filter((t) => !t.pressure), rr);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ D. where the break is stronger, and the levels of the day and of the week
if (mode === "all" || mode === "where") {
  console.log(`\n== D. Where the move after a touch is larger: the trade of C with stop and target 0.5 ATR, by the hour, the age and the roundness of the level ==`);
  const blocks = [["23-01 rollover", (h) => h >= 23 || h < 1], ["01-09 Asia", (h) => h >= 1 && h < 9], ["09-15 London morning", (h) => h >= 9 && h < 15], ["15-19 New York morning", (h) => h >= 15 && h < 19], ["19-23 New York afternoon", (h) => h >= 19 && h < 23]];
  for (const tfName of ["H1", "H4"]) {
    const list = followAll(swingEvents(tfName), 0.5, 1);
    console.log(`\n-- swings of ${tfName} --\n${HEAD_C}`);
    rowFollow("all", list, 1);
    for (const [label, test] of blocks) rowFollow(`touch at ${label}`, list.filter((t) => test(t.m.hour[t.j])), 1);
    rowFollow("level younger than 1 day", list.filter((t) => t.age < 1), 1);
    rowFollow("level 1 to 5 days old", list.filter((t) => t.age >= 1 && t.age < 5), 1);
    rowFollow("level older than 5 days", list.filter((t) => t.age >= 5), 1);
    const nearRound = (t) => { const x = t.L / (50 * t.m.pip); return Math.abs(x - Math.round(x)) * 50 <= 3; };
    rowFollow("level within 3 pips of a 00 or 50", list.filter(nearRound), 1);
    rowFollow("level not near a round number", list.filter((t) => !nearRound(t)), 1);
  }
  // The high and the low of the day before (watched for one day) and of the week before (watched for one week).
  console.log(`\n-- the high and the low of the day before and of the week before: first touch --`);
  console.log(`${pad("", 40)} touches  a month   held    fade before costs (t by weeks)   fade after   break after    fade before: 2015-18 / 2019-21`);
  const families = { "day before": [], "week before": [] };
  for (const m of market) {
    const days = m.tf.D1;
    const firstOf = (d) => (d === 0 ? 0 : days[d - 1].last + 1);
    for (let d = 1; d < days.length; d++) families["day before"].push({ m, from: firstOf(d), to: days[d].last, hi: days[d - 1].h, lo: days[d - 1].l });
    // Weeks: runs of days with the same week number.
    const weeks = [];
    days.forEach((b, d) => { const w = weekOf(b.date); const t = weeks[weeks.length - 1]; if (t === undefined || t.w !== w) weeks.push({ w, first: d, last: d, h: b.h, l: b.l }); else { t.last = d; t.h = Math.max(t.h, b.h); t.l = Math.min(t.l, b.l); } });
    for (let w = 1; w < weeks.length; w++) families["week before"].push({ m, from: firstOf(weeks[w].first), to: days[weeks[w].last].last, hi: weeks[w - 1].h, lo: weeks[w - 1].l });
  }
  const followLists = [];
  for (const [name, levels] of Object.entries(families)) for (const k of [0.25, 0.5]) {
    const touches = [], follows = [];
    for (const lv of levels) for (const [L, side] of [[lv.hi, 1], [lv.lo, -1]]) {
      const m = lv.m;
      if (m.date[lv.from] < FROM || (side > 0 ? m.o[lv.from] >= L : m.o[lv.from] <= L)) continue; // the period opens beyond the level
      for (let j = lv.from; j <= lv.to && j < m.n - 1; j++) {
        if (side > 0 ? m.h[j] < L : m.l[j] > L) continue;
        const S = k * m.atrOfDay.get(m.date[j]);
        if (Number.isFinite(S)) {
          record(touches, m, j, L, side, S, {});
          follows.push({ ...follow(m, j + 1, side, S, 1), date: m.date[j + 1], side, symbol: m.symbol, m, j });
        }
        break;
      }
    }
    row(`${name}, stop and target ${k} ATR`, touches);
    followLists.push([`${name}, stop ${k} ATR`, follows]);
  }
  console.log(`\n-- the same levels, the trade of C (market order at the next M15 open in the direction of the break, target = stop) --\n${HEAD_C}`);
  for (const [label, list] of followLists) rowFollow(label, list, 1);
}

// ------------------------------------------------------------------ E. the hours of New York in full
if (mode === "all" || mode === "ny") {
  console.log("\n== E. The trade of C by the hour of the touch (server time, New York is seven hours behind), swings of H1, H4 and D1; stop and target 0.5 ATR ==");
  const all = {};
  for (const tfName of ["H1", "H4", "D1"]) all[tfName] = swingEvents(tfName);
  for (const tfName of ["H1", "H4", "D1"]) {
    console.log("\n-- swings of " + tfName + ", by the hour of the touch --\n" + HEAD_C);
    const list = followAll(all[tfName], 0.5, 1);
    for (let h = 0; h < 24; h += 2) rowFollow("touch at " + String(h).padStart(2, "0") + "-" + String(h + 2).padStart(2, "0"), list.filter((t) => t.m.hour[t.j] >= h && t.m.hour[t.j] < h + 2), 1);
  }
  const late = (t) => t.m.hour[t.j] >= 19 && t.m.hour[t.j] < 23;
  for (const tfName of ["H1", "H4", "D1"]) for (const rr of [1, 2]) {
    console.log("\n-- swings of " + tfName + ", touch at 19-23, target " + rr + " x stop --\n" + HEAD_C);
    for (const k of [0.25, 0.5, 1, 2]) rowFollow("stop " + k + " ATR", followAll(all[tfName], k, rr).filter(late), rr);
  }
  console.log("\n-- swings of H4, touch at 19-23, stop and target 0.5 ATR: by year and by pair (mean R before costs, trades) --");
  const list = followAll(all.H4, 0.5, 1).filter(late);
  console.log([2015, 2016, 2017, 2018, 2019, 2020, 2021].map((y) => { const ts = list.filter((t) => t.date.startsWith(String(y))); return y + ": " + f(mean(ts.map((t) => t.r))) + " (" + ts.length + ")"; }).join("   "));
  console.log(PAIRS.map((p) => { const ts = list.filter((t) => t.symbol === p); return p + ": " + f(mean(ts.map((t) => t.r))) + " (" + ts.length + ")"; }).join("   "));
  console.log("by test: " + [2, 3, 4].map((n) => { const ts = list.filter((t) => (n < 4 ? t.test === n : t.test >= 4)); return (n < 4 ? "test " + n : "test 4+") + " " + f(mean(ts.map((t) => t.r))) + " (" + ts.length + ")"; }).join("   "));
  console.log("by weekday of the touch: " + [1, 2, 3, 4, 5].map((d) => { const ts = list.filter((t) => weekday(t.m.date[t.j]) === d); return "day " + d + " " + f(mean(ts.map((t) => t.r))) + " (" + ts.length + ")"; }).join("   "));
  // Wednesday 21:00 server time is the hour of the Fed decision (eight a year): many levels of all pairs go at once.
  console.log("\n-- the same, Wednesdays apart --\n" + HEAD_C);
  rowFollow("H4, 19-23, Wednesdays only", list.filter((t) => weekday(t.m.date[t.j]) === 3), 1);
  rowFollow("H4, 19-23, the other days", list.filter((t) => weekday(t.m.date[t.j]) !== 3), 1);
  const h1 = followAll(all.H1, 0.5, 1).filter(late);
  rowFollow("H1, 19-23, Wednesdays only", h1.filter((t) => weekday(t.m.date[t.j]) === 3), 1);
  rowFollow("H1, 19-23, the other days", h1.filter((t) => weekday(t.m.date[t.j]) !== 3), 1);
  const days = new Set(list.filter((t) => weekday(t.m.date[t.j]) === 3).map((t) => t.m.date[t.j]));
  const busy = [...days].map((d) => [d, list.filter((t) => t.m.date[t.j] === d).length]).sort((a, b) => b[1] - a[1]);
  console.log("Wednesdays with touches: " + days.size + "; the ten busiest: " + busy.slice(0, 10).map((x) => x[0] + " (" + x[1] + ")").join(", "));
}

// ------------------------------------------------------------------ F. the day of the Fed decision
if (mode === "all" || mode === "fed") {
  // Scheduled decisions come at 21:00 server time (14:00 New York); the export writes the summer ones as 20:00.
  const cal = readFileSync(config.calendar.file, "utf16le").split(/\r?\n/);
  const fedDays = new Set();
  for (const line of cal) {
    const p = line.split("\t");
    if (p.length < 9 || p[4] !== "fed-interest-rate-decision" || p[7] !== "USD") continue;
    const date = p[0].replace(/^\uFEFF/, "").replaceAll(".", "-");
    if (date < FROM || date > TO || (p[1] !== "20:00" && p[1] !== "21:00")) continue; // unscheduled cuts are left out
    fedDays.add(date);
  }
  console.log("\n== F. The day of the Fed decision: touches from 21:00 to 23:00 server time; scheduled decisions in dev: " + fedDays.size + " ==");
  const all = {};
  for (const tfName of ["H1", "H4", "D1"]) all[tfName] = swingEvents(tfName);
  const inWindow = (t, from, to) => t.m.hour[t.j] >= from && t.m.hour[t.j] < to;
  /** One number for a day: the mean over its trades; t over the days. */
  const byDay = (list) => {
    const sum = new Map();
    for (const t of list) { const d = t.m.date[t.j]; const s = sum.get(d) ?? { r: 0, net: 0, n: 0 }; s.r += t.r; s.net += t.r - t.cost; s.n++; sum.set(d, s); }
    const xs = [...sum.values()].map((s) => s.r / s.n), ys = [...sum.values()].map((s) => s.net / s.n);
    const sdOf = (v) => { const mu = mean(v); return Math.sqrt(v.reduce((a, x) => a + (x - mu) ** 2, 0) / Math.max(1, v.length - 1)); };
    return "days " + xs.length + ", mean of a day " + f(mean(xs)) + " (t " + f(mean(xs) / (sdOf(xs) / Math.sqrt(xs.length)), 1) + "), after costs " + f(mean(ys)) + " (t " + f(mean(ys) / (sdOf(ys) / Math.sqrt(ys.length)), 1) + "), days above zero " + xs.filter((x) => x > 0).length;
  };
  for (const tfName of ["H1", "H4", "D1"]) for (const rr of [1, 2]) {
    console.log("\n-- swings of " + tfName + ", target " + rr + " x stop --\n" + HEAD_C);
    for (const k of [0.25, 0.5, 1]) {
      const list = followAll(all[tfName], k, rr);
      const fed = list.filter((t) => fedDays.has(t.m.date[t.j]) && inWindow(t, 21, 23));
      rowFollow("Fed day 21-23, stop " + k + " ATR", fed, rr);
      console.log("      " + byDay(fed));
      if (k === 0.5) {
        rowFollow("  Fed day 15-21 (before it)", list.filter((t) => fedDays.has(t.m.date[t.j]) && inWindow(t, 15, 21)), rr);
        rowFollow("  other days 21-23", list.filter((t) => !fedDays.has(t.m.date[t.j]) && inWindow(t, 21, 23)), rr);
        rowFollow("  other Wednesdays 19-23", list.filter((t) => !fedDays.has(t.m.date[t.j]) && weekday(t.m.date[t.j]) === 3 && inWindow(t, 19, 23)), rr);
        // The first touch of a pair after the decision only: one trade a pair a decision.
        const seen = new Set();
        const firsts = fed.slice().sort((a, b) => a.j - b.j).filter((t) => { const key = t.symbol + t.m.date[t.j]; if (seen.has(key)) return false; seen.add(key); return true; });
        rowFollow("  Fed day 21-23, first touch of a pair", firsts, rr);
        console.log("      " + byDay(firsts));
      }
    }
  }
  // The same day with no level in it: a market order at 21:15 in the direction of the first 15 minutes.
  console.log("\n-- the control with no level: at 21:15 on the day of the decision, in the direction of the bar of 21:00; stop and target 0.5 ATR --\n" + HEAD_C);
  const plain = [];
  for (const m of market) for (let i = 1; i < m.n - 1; i++) {
    if (!fedDays.has(m.date[i]) || m.hour[i] !== 21 || m.hour[i - 1] === 21) continue; // the bar of 21:00
    const side = Math.sign(m.c[i] - m.o[i]), S = 0.5 * m.atrOfDay.get(m.date[i]);
    if (side === 0 || !Number.isFinite(S)) continue;
    plain.push({ ...follow(m, i + 1, side, S, 1), m, j: i, side, date: m.date[i], symbol: m.symbol });
  }
  rowFollow("after the first bar, all pairs", plain, 1);
  console.log("      " + byDay(plain));
}

// ------------------------------------------------------------------ G. the move in pips, pair by pair: the costs it would take to break even
if (mode === "all" || mode === "pips") {
  console.log("\n== G. The trade of C in pips (stop and target 0.5 ATR): the move before costs against the costs of the config, pair by pair ==");
  for (const tfName of ["H1", "H4", "D1"]) {
    const list = followAll(swingEvents(tfName), 0.5, 1);
    console.log("\n-- swings of " + tfName + " --");
    console.log(pad("", 10) + " trades  a month   move, pips (t by weeks)   costs, pips   2015-18 / 2019-21, pips");
    const line = (label, ts) => {
      const S = (t) => 0.5 * t.m.atrOfDay.get(t.date) / t.m.pip; // the stop in pips
      const pips = ts.map((t) => ({ date: t.date, r: t.r * S(t) }));
      const a = pips.filter((t) => t.date < SPLIT), z = pips.filter((t) => t.date >= SPLIT);
      console.log(pad(label, 10) + lpad(ts.length, 7) + lpad((ts.length / months).toFixed(1), 8) + "   " + f(mean(pips.map((t) => t.r)), 2) + " (" + f(tByWeeks(pips), 1) + ")" + "            " + mean(ts.map((t) => t.cost * S(t))).toFixed(2) + "          " + f(mean(a.map((t) => t.r)), 2) + " / " + f(mean(z.map((t) => t.r)), 2));
    };
    for (const p of PAIRS) line(p, list.filter((t) => t.symbol === p));
    line("all", list);
  }
}
