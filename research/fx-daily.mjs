// Rarer and larger (TZ 17.41): the two daily candle setups of the lab (TZ 17.24)
// that did not lose after costs on the seven dollar pairs, taken unchanged to
// the 21 crosses and to weekly candles. Dev only: nothing after 2021-12-08 is read.
//
// Pin bar at an extreme (said for a buy): a candle whose lower wick is at least
// 0.6 of its range and whose body is at most 0.3 of it, with a low not above
// the lowest low of the 20 candles before. A buy stop one pip over its high
// for the next two candles, the stop one pip under its low, the target 1 or 2
// stop distances, out after 20 candles.
// Series of inside bars: two candles in a row inside the range of the candle
// before them. Stop orders one pip beyond both ends of that range for the
// next three candles, the first one filled is the trade and its stop is the
// other end; the same targets and time limit.
// Controls with no idea in them: the same order after a candle that makes a
// 20-candle low but is not a pin bar; the same pair of orders around the
// candle two back when the two candles after it are not both inside it.
//
// A dollar pair has its true M15 bars and the costs of the config. A cross is
// built from the M15 bars of its two dollar pairs: its open and close at every
// quarter of an hour (the high and the low inside the quarter are not known),
// no bars from 22:00 to 01:00 by the server. Its costs are counted as the
// broker's own cross ("own": FundedNext swaps, the spread ASSUMED to be 0.7 of
// the two dollar spreads) and as its two dollar pairs ("two": all known).
// Execution is on M15, one position or waiting order an instrument, the stop
// before the target within a bar, the stop never closer than a tenth of the
// daily ATR(20). Results are shown with swaps and for an account without them.
//
// Usage: node research/fx-daily.mjs [gallery.html]
//        node research/fx-daily.mjs check     the seven dollar pairs on D1 alone, to be compared with the lab
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const DOLLAR = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const CUR = { EUR: ["EURUSD", false], GBP: ["GBPUSD", false], AUD: ["AUDUSD", false], NZD: ["NZDUSD", false], JPY: ["USDJPY", true], CAD: ["USDCAD", true], CHF: ["USDCHF", true] };
/** FundedNext swap calculator, read 2026-11-21: points per lot per night, buy / sell (a point is a tenth of a pip). */
const OWN_SWAP = {
  EURGBP: [-7.16, 0.056], EURAUD: [2.973, -3.08], EURNZD: [-19.005, 2.25], EURJPY: [-16.6038, -49.56], EURCAD: [-11.235, 0.085], EURCHF: [-6.539, -13.32],
  GBPAUD: [-2.73, -15.135], GBPNZD: [-10.905, -6.555], GBPJPY: [-25.806, -44.278], GBPCAD: [-4.59, -11.835], GBPCHF: [-8.251, -26.37],
  AUDNZD: [1.35, -0.78], AUDJPY: [-11.27, -19.841], AUDCAD: [-5.565, -1.32], AUDCHF: [-2.41, -9.69],
  NZDJPY: [-15.837, -21.783], NZDCAD: [-1.17, -6.818], NZDCHF: [0.347, -11.58],
  CADJPY: [-15.315, -26.82], CADCHF: [-3.3456, -13.245], CHFJPY: [-6.1206, -17.37],
};
const CROSSES = Object.keys(OWN_SWAP);
const SPREAD_SHARE = 0.7, CROSS_CLOSED = new Set([22, 23, 0]);
const checkMode = process.argv[2] === "check", frozenMode = process.argv[2] === "frozen", galleryFile = checkMode || frozenMode ? undefined : process.argv[2];
// Every mode but "frozen" reads dev only; "frozen" reads up to the end of the set it is given and counts trades inside it.
const dataset = frozenMode ? process.argv[3] ?? "dev" : "dev";
if (dataset === "holdout" && !process.argv.includes("--i-understand-holdout")) throw new Error("the holdout needs --i-understand-holdout");
const SPANS = { dev: ["2015-02-02", "2021-12-08"], test: [config.datasets.testStart, "2024-11-15"], holdout: [config.datasets.holdoutStart, "2026-10-29"] };
if (SPANS[dataset] === undefined) throw new Error(`no such set: ${dataset}`);
const [FROM, TO] = SPANS[dataset];
const SPLIT = dataset === "dev" ? "2018-07-01" : new Date((Date.parse(FROM) + Date.parse(TO)) / 2).toISOString().slice(0, 10);

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f = (x, d = 3) => (!Number.isFinite(x) ? "  n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / 86400e3;
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
/** The Monday of the week of a date: the name of its weekly candle. */
const weekOf = (date) => new Date((dayNumber(date) - ((weekday(date) + 6) % 7)) * 86400e3).toISOString().slice(0, 10);

// ------------------------------------------------------------------ data
function spec(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits;
  return {
    symbol, point, pip: point * 10, digits: own.digits, base: own.usdSide === "base", contract: own.contractSize,
    minSpread: own.minSpreadPoints ?? config.costs.minSpreadPoints,
    slip: config.costs.slippagePips * point * 10,
    commission: own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip,
    swapLong: own.swapLongPips * point * 10, swapShort: own.swapShortPips * point * 10,
  };
}
function loadM15(symbol) {
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after the end of the set is read
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
function atr(bars, n) {
  const tr = bars.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c))));
  return sma(tr, n);
}
/** Lowest low and highest high of the `n` bars before bar i (bar i itself is not in). */
function extremesBefore(bars, n) {
  const lo = new Array(bars.length).fill(NaN), hi = new Array(bars.length).fill(NaN);
  for (let i = n; i < bars.length; i++) {
    let a = Infinity, b = -Infinity;
    for (let j = i - n; j < i; j++) { if (bars[j].l < a) a = bars[j].l; if (bars[j].h > b) b = bars[j].h; }
    lo[i] = a; hi[i] = b;
  }
  return { lo, hi };
}
function finish(s, m15) {
  const tf = { D1: aggregate(m15, (b) => b.date), W1: aggregate(m15, (b) => weekOf(b.date)) };
  const dAtr = atr(tf.D1, 20), day = new Map();
  tf.D1.forEach((b, i) => { if (i > 0) day.set(b.date, dAtr[i - 1]); });
  return { s, m15, tf, day };
}
const legs = new Map(DOLLAR.map((p) => [p, loadM15(p)]));
const market = new Map(DOLLAR.map((p) => [p, finish(spec(p), legs.get(p))]));
/** A cross from the M15 bars of its two dollar pairs; every bar carries its two sets of costs in price units and shares of the price. */
function buildCross(name) {
  const X = name.slice(0, 3), Y = name.slice(3), [pairX, invX] = CUR[X], [pairY, invY] = CUR[Y];
  const sa = spec(pairX), sb = spec(pairY);
  const other = new Map(legs.get(pairY).map((b) => [`${b.date} ${b.hour} ${b.minute}`, b]));
  const digits = Y === "JPY" ? 3 : 5, point = 10 ** -digits, pip = point * 10;
  const value = (p, inv) => (inv ? 1 / p : p); // dollars for one unit of the currency
  const leg = (s, bar) => ({ spread: (Math.max(bar.spread, s.minSpread) * s.point) / bar.o, slip: s.slip / bar.o, comm: s.base ? s.commission / s.contract : s.commission / (s.contract * bar.o), swapLong: s.swapLong / bar.o, swapShort: s.swapShort / bar.o });
  const m15 = [];
  for (const a of legs.get(pairX)) {
    const b = other.get(`${a.date} ${a.hour} ${a.minute}`);
    if (b === undefined || CROSS_CLOSED.has(a.hour)) continue;
    const o = value(a.o, invX) / value(b.o, invY), c = value(a.c, invX) / value(b.c, invY), ra = leg(sa, a), rb = leg(sb, b);
    // Long the cross = long X against the dollar and short Y against the dollar.
    m15.push({
      date: a.date, hour: a.hour, minute: a.minute, o, h: Math.max(o, c), l: Math.min(o, c), c,
      cost: {
        two: { spread: (ra.spread + rb.spread) * o, slip: (ra.slip + rb.slip) * o, comm: ra.comm + rb.comm, swapLong: (invX ? ra.swapShort : ra.swapLong) + (invY ? rb.swapLong : rb.swapShort), swapShort: (invX ? ra.swapLong : ra.swapShort) + (invY ? rb.swapShort : rb.swapLong) },
        own: { spread: SPREAD_SHARE * (ra.spread + rb.spread) * o, slip: config.costs.slippagePips * pip, comm: config.costs.commissionPerLotRoundTrip / (100000 * value(a.o, invX)), swapLong: (OWN_SWAP[name][0] * point) / o, swapShort: (OWN_SWAP[name][1] * point) / o },
      },
    });
  }
  return finish({ symbol: name, point, pip, digits }, m15);
}
if (!checkMode) for (const name of CROSSES) market.set(name, buildCross(name));

// ------------------------------------------------------------------ execution (the lab's, with the costs of a cross read from its bars)
/**
 * Runs the orders of one instrument, one position (or one waiting order) at a time.
 * An order: { at, legs: [{ dir, type: "stop", price, sl }], rr, expire, timeExit, tag }.
 * `at` is the first M15 bar on which it may be filled, `expire` the last; the first leg to be triggered is the
 * trade, two legs in one bar cancel the order. Within one bar the stop is taken before the target; on the bar of
 * the fill the stop counts as hit if the bar reached it, the target never. `costs` is false, true (a dollar pair)
 * or the name of a cross's set of costs. A trade carries its result with swaps (`r`) and without them (`r0`).
 */
function execute(symbol, orders, costs) {
  const { s, m15, day } = market.get(symbol);
  const spreadOf = (b) => (!costs ? 0 : b.cost ? b.cost[costs].spread : Math.max(b.spread, s.minSpread) * s.point);
  const slipOf = (b) => (!costs ? 0 : b.cost ? b.cost[costs].slip : s.slip);
  orders.sort((a, b) => a.at - b.at);
  const trades = [];
  let free = 0;
  for (const ord of orders) {
    if (ord.at < free || ord.at >= m15.length) continue;
    if (m15[ord.at].date < FROM) continue;
    const lastTry = Math.min(ord.expire ?? ord.at, m15.length - 1);
    let fill = null, cancelled = false, i = ord.at;
    for (; i <= lastTry; i++) {
      const b = m15[i], sp = spreadOf(b), slip = slipOf(b), hits = [];
      for (const leg of ord.legs) {
        if (leg.dir > 0 && b.h + sp >= leg.price) hits.push({ leg, price: Math.max(leg.price, b.o + sp) + slip });
        if (leg.dir < 0 && b.l <= leg.price) hits.push({ leg, price: Math.min(leg.price, b.o) - slip });
      }
      if (hits.length > 1) { cancelled = true; break; }
      if (hits.length === 1) { fill = hits[0]; break; }
    }
    // The next order may stand only from the bar after the last bar of this one (TZ 17.38).
    if (fill === null) { free = Math.min(i, lastTry) + 1; continue; }
    const { leg, price: entry } = fill, dir = leg.dir, dAtr = day.get(m15[i].date);
    if (!Number.isFinite(dAtr)) { free = i + 1; continue; }
    let dist = dir * (entry - leg.sl);
    if (!(dist >= 0.1 * dAtr)) dist = 0.1 * dAtr; // a tighter stop is only a way to pay the spread
    const sl = entry - dir * dist, tp = entry + dir * ord.rr * dist;
    let exit = NaN, reason = "", j = i;
    for (; j < m15.length; j++) {
      const b = m15[j], sp = spreadOf(b), slip = slipOf(b), entryBar = j === i;
      if (!entryBar && ord.timeExit !== undefined && j >= ord.timeExit) { exit = dir > 0 ? b.o - slip : b.o + sp + slip; reason = "time"; break; }
      if (dir > 0) {
        if (b.l <= sl) { exit = (entryBar ? sl : Math.min(sl, b.o)) - slip; reason = "stop"; break; }
        if (b.h >= tp && !entryBar) { exit = tp - slip; reason = "target"; break; }
      } else {
        if (b.h + sp >= sl) { exit = (entryBar ? sl : Math.max(sl, b.o + sp)) + slip; reason = "stop"; break; }
        if (b.l + sp <= tp && !entryBar) { exit = tp + slip; reason = "target"; break; }
      }
    }
    if (!Number.isFinite(exit)) break; // the data ended with the position open
    let swap = 0, commission = 0;
    if (costs) {
      const k = m15[i].cost ? m15[i].cost[costs] : null;
      const night = k ? (dir > 0 ? k.swapLong : k.swapShort) * entry : dir > 0 ? s.swapLong : s.swapShort;
      for (let n = i + 1; n <= j; n++) if (m15[n].date !== m15[n - 1].date) swap += night * (weekday(m15[n - 1].date) === 3 ? 3 : 1);
      commission = k ? k.comm * entry : s.base ? (s.commission / s.contract) * entry : s.commission / s.contract;
    }
    const move = dir * (exit - entry);
    trades.push({ symbol, date: m15[i].date, dir, r: (move + swap - commission) / dist, r0: (move - commission) / dist, reason, e: i, x: j, entry, sl, tp, tag: ord.tag });
    free = reason === "time" ? j : j + 1; // an exit by time is at the open of its bar: that bar is free
  }
  return trades;
}

// ------------------------------------------------------------------ setups (the lab's rules, unchanged) and their controls
const after = (bars, j) => bars[j].last + 1;
const isPin = (b, side) => {
  const range = b.h - b.l, body = Math.abs(b.c - b.o), lower = Math.min(b.o, b.c) - b.l, upper = b.h - Math.max(b.o, b.c);
  return range > 0 && body <= 0.3 * range && (side > 0 ? lower : upper) >= 0.6 * range;
};
/** `control` false: a pin bar at a 20-candle extreme. `control` true: a candle at that extreme that is not a pin bar. */
function pinBar(m, { tf, rr, control }) {
  const bars = m.tf[tf], ext = extremesBefore(bars, 20), buf = m.s.pip, orders = [];
  for (let j = 21; j + 1 < bars.length; j++) {
    const b = bars[j];
    if (!(b.h - b.l > 0)) continue;
    const atLow = b.l <= ext.lo[j], atHigh = b.h >= ext.hi[j];
    let dir = 0;
    if (!control) { if (atLow && isPin(b, 1)) dir = 1; if (atHigh && isPin(b, -1)) dir = -1; } else if (atLow !== atHigh) dir = atLow ? (isPin(b, 1) ? 0 : 1) : isPin(b, -1) ? 0 : -1;
    if (dir === 0) continue;
    orders.push({
      at: after(bars, j), expire: bars[Math.min(j + 2, bars.length - 1)].last, rr, tag: { tf, j, from: j },
      legs: [dir > 0 ? { dir, type: "stop", price: b.h + buf, sl: b.l - buf } : { dir, type: "stop", price: b.l - buf, sl: b.h + buf }],
      timeExit: j + 20 < bars.length ? after(bars, j + 20) : undefined,
    });
  }
  return orders;
}
/** `control` false: two candles inside the candle before them. `control` true: the same orders when they are not both inside it. */
function insideSeries(m, { tf, rr, control }) {
  const bars = m.tf[tf], buf = m.s.pip, orders = [];
  for (let j = 3; j + 1 < bars.length; j++) {
    const mother = bars[j - 2], inside = (b) => b.h <= mother.h && b.l >= mother.l;
    if ((inside(bars[j - 1]) && inside(bars[j])) === control) continue;
    orders.push({
      at: after(bars, j), expire: bars[Math.min(j + 3, bars.length - 1)].last, rr, tag: { tf, j, from: j - 2 },
      legs: [{ dir: 1, type: "stop", price: mother.h + buf, sl: mother.l - buf }, { dir: -1, type: "stop", price: mother.l - buf, sl: mother.h + buf }],
      timeExit: j + 20 < bars.length ? after(bars, j + 20) : undefined,
    });
  }
  return orders;
}

// ------------------------------------------------------------------ counting
function summary(trades, value = (t) => t.r) {
  if (trades.length === 0) return { n: 0, meanR: NaN, t: NaN, win: NaN };
  const byWeek = new Map();
  for (const t of trades) { const wk = Math.floor((dayNumber(t.date) + 3) / 7); byWeek.set(wk, (byWeek.get(wk) ?? 0) + value(t)); }
  const w = [...byWeek.values()], mw = mean(w), sd = Math.sqrt(mean(w.map((x) => (x - mw) ** 2)) * (w.length / Math.max(1, w.length - 1)));
  const rs = trades.map(value);
  return { n: rs.length, meanR: mean(rs), t: mw / (sd / Math.sqrt(w.length)), win: rs.filter((r) => r > 0).length / rs.length };
}
const months = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.44);
/** One setup on a list of instruments: trades before costs, after costs (a cross as the broker's own), and a cross as its two dollar pairs. */
function run(fn, params, symbols) {
  const net = [], gross = [], two = [];
  for (const symbol of symbols) {
    const m = market.get(symbol), cross = m.m15[0].cost !== undefined;
    net.push(...execute(symbol, fn(m, params), cross ? "own" : true));
    gross.push(...execute(symbol, fn(m, params), false));
    two.push(...execute(symbol, fn(m, params), cross ? "two" : true));
  }
  return { net, gross, two };
}
const HEAD = `${pad("", 30)} ${lpad("n", 5)} ${lpad("/mo", 5)} | ${lpad("before", 7)} ${lpad("t", 5)} ${lpad("wins", 5)} | ${lpad("after", 7)} ${lpad("t", 5)} | ${lpad("no swaps", 8)} ${lpad("t", 5)} | ${lpad("1st", 7)} ${lpad("2nd", 7)} | ${lpad("in plus", 7)} | ${lpad("2 legs", 7)} || control: n, before, after, no swaps`;
const cells = [];
function row(label, fn, params, symbols) {
  const real = run(fn, { ...params, control: false }, symbols), ctl = run(fn, { ...params, control: true }, symbols);
  const g = summary(real.gross), n = summary(real.net), z = summary(real.net, (t) => t.r0), two = summary(real.two);
  const a = summary(real.net.filter((t) => t.date < SPLIT)), b = summary(real.net.filter((t) => t.date >= SPLIT));
  const plus = symbols.filter((p) => mean(real.net.filter((t) => t.symbol === p).map((t) => t.r)) > 0).length;
  const cg = summary(ctl.gross), cn = summary(ctl.net), cz = summary(ctl.net, (t) => t.r0);
  cells.push({ label, n: n.n, after: n.meanR, t: n.t, flat: z.meanR, flatT: z.t, before: g.meanR, control: cg.meanR, a: a.meanR, b: b.meanR, plus, of: symbols.length });
  console.log(`${pad(label, 30)} ${lpad(n.n, 5)} ${lpad((n.n / months).toFixed(1), 5)} | ${lpad(f(g.meanR), 7)} ${lpad(f(g.t, 1), 5)} ${lpad((g.win * 100).toFixed(0) + "%", 5)} | ${lpad(f(n.meanR), 7)} ${lpad(f(n.t, 1), 5)} | ${lpad(f(z.meanR), 8)} ${lpad(f(z.t, 1), 5)} | ${lpad(f(a.meanR), 7)} ${lpad(f(b.meanR), 7)} | ${lpad(`${plus}/${symbols.length}`, 7)} | ${lpad(f(two.meanR), 7)} || ${lpad(cn.n, 6)} ${lpad(f(cg.meanR), 7)} ${lpad(f(cn.meanR), 7)} ${lpad(f(cz.meanR), 7)}`);
  return real;
}

// ------------------------------------------------------------------ the picture of one trade
function card(t, title) {
  const m = market.get(t.symbol), bars = m.tf[t.tag.tf], of = (i) => { let k = t.tag.j; while (k + 1 < bars.length && bars[k + 1].first <= i) k++; return k; };
  const entryBar = of(t.e), exitBar = of(t.x), from = Math.max(0, t.tag.from - 24), to = Math.min(bars.length - 1, exitBar + 5), view = bars.slice(from, to + 1);
  const W = 760, H = 320, padL = 8, padR = 70, n1 = (v) => v.toFixed(1);
  const top = Math.max(...view.map((b) => b.h), t.tp, t.sl), bottom = Math.min(...view.map((b) => b.l), t.tp, t.sl);
  const x = (i) => padL + ((i - from + 0.5) * (W - padL - padR)) / view.length, y = (p) => 12 + ((top - p) * (H - 24)) / (top - bottom);
  const bw = Math.max(1.5, ((W - padL - padR) / view.length) * 0.6);
  const candles = view.map((b, k) => { const i = from + k, up = b.c >= b.o; return `<line x1="${n1(x(i))}" x2="${n1(x(i))}" y1="${n1(y(b.h))}" y2="${n1(y(b.l))}" class="${up ? "up" : "dn"}"/><rect x="${n1(x(i) - bw / 2)}" y="${n1(y(Math.max(b.o, b.c)))}" width="${n1(bw)}" height="${n1(Math.max(1, Math.abs(y(b.o) - y(b.c))))}" class="${up ? "upf" : "dnf"}"/>`; }).join("");
  let boxTop = -Infinity, boxBottom = Infinity;
  for (let k = t.tag.from; k <= t.tag.j; k++) { boxTop = Math.max(boxTop, bars[k].h); boxBottom = Math.min(boxBottom, bars[k].l); }
  const box = `<rect x="${n1(x(t.tag.from) - bw)}" y="${n1(y(boxTop) - 3)}" width="${n1(x(t.tag.j) - x(t.tag.from) + 2 * bw)}" height="${n1(y(boxBottom) - y(boxTop) + 6)}" class="box"/>`;
  const hline = (p, cls, label) => `<line x1="${n1(x(entryBar))}" x2="${W - padR}" y1="${n1(y(p))}" y2="${n1(y(p))}" class="${cls}"/><text x="${W - padR + 4}" y="${n1(y(p) + 4)}" class="lbl">${label}</text>`;
  const mark = `<line x1="${n1(x(entryBar))}" x2="${n1(x(entryBar))}" y1="12" y2="${H - 12}" class="entry"/>`;
  const ends = { stop: "стоп", target: "цель", time: "закрыта по сроку" }, d = m.s.digits === 3 ? 3 : 5;
  return `<section><h2>${title}</h2><p>${t.dir > 0 ? "Покупка" : "Продажа"} ${t.entry.toFixed(d)}, стоп ${t.sl.toFixed(d)}, цель ${t.tp.toFixed(d)}. Итог: ${ends[t.reason]} (${f(t.r, 2)} R после издержек и свопов).</p><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${candles}${box}${mark}${hline(t.entry, "ent", "вход")}${hline(t.sl, "stp", "стоп")}${hline(t.tp, "tp", "цель")}</svg></section>`;
}
function page(heading, lead, cards) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Дневные свечи</title><style>
:root{--bg:#fff;--fg:#1c1c1c;--mut:#6b6b6b;--up:#1a8f5a;--dn:#c0392b;--fig:#2456c7;--line:#888}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--mut:#a0a0a0;--up:#3fbf85;--dn:#e06c5c;--fig:#7aa2ff;--line:#999}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px;max-width:820px;margin-inline:auto}
h1{font-size:22px}h2{font-size:17px;margin:28px 0 4px}p{margin:4px 0 8px;color:var(--mut)}svg{width:100%;height:auto;display:block}
.up{stroke:var(--up)}.dn{stroke:var(--dn)}.upf{fill:var(--up)}.dnf{fill:var(--dn)}.box{fill:none;stroke:var(--fig);stroke-width:1.5}
.entry{stroke:var(--line);stroke-dasharray:4 4}.ent{stroke:var(--fg)}.stp{stroke:var(--dn);stroke-dasharray:6 3}.tp{stroke:var(--up);stroke-dasharray:6 3}.lbl{fill:var(--fg);font-size:12px}
</style></head><body><h1>${heading}</h1><p>${lead}</p>${cards.join("\n")}</body></html>`;
}

// ------------------------------------------------------------------ run
const SETUPS = [["pin bar at an extreme", pinBar], ["series of inside bars", insideSeries]];
// The cell that met the conditions on dev (TZ 17.41), frozen on 2026-11-23 before it is read on test:
// a pin bar at a 20-day extreme on daily candles, the target two stop distances, for an account without swaps.
const FROZEN = { name: "PinBarExtremeD1", fn: pinBar, params: { tf: "D1", rr: 2 } };
if (frozenMode) {
  // One cell with its control: by group, then on all 28 by year, by side and by instrument, with swaps and without.
  const cell = FROZEN ?? { name: "the cell under study (not frozen yet)", fn: pinBar, params: { tf: "D1", rr: 2 } };
  if (FROZEN === null && dataset !== "dev") throw new Error("no cell is frozen yet: test and holdout are read only by the frozen cell");
  console.log(`${cell.name}: ${dataset} ${FROM} .. ${TO}. R = the stop distance; "before" and "wins" are before costs; t counts weeks.\n${HEAD}`);
  row("7 dollar pairs", cell.fn, cell.params, DOLLAR);
  row("21 crosses", cell.fn, cell.params, CROSSES);
  const everything = [...DOLLAR, ...CROSSES], real = row("all 28", cell.fn, cell.params, everything), flat = (t) => t.r0, done = cells.at(-1);
  const show = (name, part) => { const w = summary(part), z = summary(part, flat); console.log(`  ${pad(name, 14)} ${lpad(w.n, 4)} trades | with swaps ${lpad(f(w.meanR), 7)} (t ${lpad(f(w.t, 1), 5)}) | no swaps ${lpad(f(z.meanR), 7)} (t ${lpad(f(z.t, 1), 5)})`); };
  console.log("\nAll 28, after costs:");
  show("first half", real.net.filter((t) => t.date < SPLIT)); show("second half", real.net.filter((t) => t.date >= SPLIT));
  for (const y of [...new Set(real.net.map((t) => t.date.slice(0, 4)))].sort()) show(y, real.net.filter((t) => t.date.startsWith(y)));
  show("buys", real.net.filter((t) => t.dir > 0)); show("sells", real.net.filter((t) => t.dir < 0));
  const plusFlat = everything.filter((p) => mean(real.net.filter((t) => t.symbol === p).map(flat)) > 0).length;
  const ends = {};
  for (const t of real.net) ends[t.reason] = (ends[t.reason] ?? 0) + 1;
  const curve = (value) => { let run = 0, peak = 0, fall = 0; for (const t of real.net.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) { run += value(t); peak = Math.max(peak, run); fall = Math.max(fall, peak - run); } return { run, fall }; };
  const cs = curve((t) => t.r), cf = curve(flat);
  console.log(`  instruments above zero: with swaps ${done.plus}/28, no swaps ${plusFlat}/28; ended: ${Object.entries(ends).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  console.log(`  the sum of R: with swaps ${f(cs.run, 1)} (the deepest fall ${cs.fall.toFixed(1)} R), no swaps ${f(cf.run, 1)} (the deepest fall ${cf.fall.toFixed(1)} R); ${(real.net.length / months).toFixed(1)} trades a month`);
  const pips = real.net.map((t) => Math.abs(t.entry - t.sl) / market.get(t.symbol).s.pip).sort((a, b) => a - b), heldDays = real.net.map((t) => dayNumber(market.get(t.symbol).m15[t.x].date) - dayNumber(t.date)).sort((a, b) => a - b);
  console.log(`  median stop ${pips[Math.floor(pips.length / 2)].toFixed(0)} pips; median hold ${heldDays[Math.floor(heldDays.length / 2)]} days`);
  if (dataset !== "dev") console.log(`\nStage on ${dataset}: after costs on an account without swaps ${done.flat > 0 ? "above" : "not above"} zero (${f(done.flat)} R, t ${f(done.flatT, 1)}); before costs ${f(done.before)} R against ${f(done.control)} R of the control: ${done.flat > 0 && done.before > done.control ? "PASSED" : "NOT PASSED"}.`);
} else if (checkMode) {
  // The seven dollar pairs on D1 alone: these rows must repeat the lab's (TZ 17.24 after the fix of 17.38).
  console.log(`The seven dollar pairs, D1, dev ${FROM} .. ${TO}: to be compared with the lab.\n${HEAD}`);
  for (const [name, fn] of SETUPS) for (const rr of [1, 2]) row(`${name}, rr ${rr}`, fn, { tf: "D1", rr }, DOLLAR);
} else {
  console.log(`Daily and weekly candle setups on 28 instruments, dev ${FROM} .. ${TO}. R = the stop distance; "before" and "wins" are before costs; t counts weeks.`);
  console.log(`"after": with the costs and swaps of the config (a cross as the broker's own cross, its spread assumed); "no swaps": the same on an account without swaps; "2 legs": a cross as its two dollar pairs, with swaps.`);
  const kept = new Map();
  for (const tf of ["D1", "W1"]) for (const [name, fn] of SETUPS) for (const rr of [1, 2]) {
    console.log(`\n=== ${name}, ${tf}, target ${rr} stop distances ===\n${HEAD}`);
    row("7 dollar pairs", fn, { tf, rr }, DOLLAR);
    row("21 crosses", fn, { tf, rr }, CROSSES);
    kept.set(`${name}|${tf}|${rr}`, row("all 28", fn, { tf, rr }, [...DOLLAR, ...CROSSES]));
  }
  const all = cells.filter((c) => c.label === "all 28");
  console.log(`\nCells on all 28: ${all.length}. After costs above zero: ${all.filter((c) => c.after > 0).length}; of them t >= 2: ${all.filter((c) => c.t >= 2).length}. On an account without swaps above zero: ${all.filter((c) => c.flat > 0).length}; of them t >= 2: ${all.filter((c) => c.flatT >= 2).length}.`);
  if (galleryFile !== undefined) {
    // The first cases in time order on EURUSD from 2019, with no selection by result.
    const first = (key, n) => kept.get(key).net.filter((t) => t.symbol === "EURUSD" && t.date >= "2019-01-01").sort((a, b) => a.e - b.e).slice(0, n);
    const cards = [
      ...first("pin bar at an extreme|D1|2", 6).map((t) => card(t, `Пин-бар у 20-дневного экстремума — ${t.symbol}, ${t.date}`)),
      ...first("series of inside bars|D1|2", 6).map((t) => card(t, `Серия внутренних баров — ${t.symbol}, ${t.date}`)),
    ];
    mkdirSync(path.dirname(galleryFile), { recursive: true });
    writeFileSync(galleryFile, page("Как программа видит пин-бар и серию внутренних баров на дневных свечах", "Дневные свечи. Первые по порядку случаи на EURUSD с 2019 года, без отбора по результату: среди них есть и убыточные. В рамке — свеча или свечи, по которым ставится ордер. Серый пунктир — день входа.", cards));
    console.log(`\n${cards.length} pictures written to ${galleryFile}`);
  }
}
