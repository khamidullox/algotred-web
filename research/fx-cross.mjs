// Mean reversion on the 21 crosses built from the seven dollar pairs (TZ 17.29),
// on three horizons: inside the day, over days, over weeks. Dev only: nothing
// after 2021-12-08 is read.
//
// A cross is built from the hourly bars of its two dollar pairs (same hour,
// open and close). The rule in every cell is the same: when the close is
// further than Z standard deviations from the mean of the last N hours, trade
// back toward the mean at the next open; out when a close is back at the mean,
// or at the end of the day (inside the day), or after N hours (the other two).
// One position per pair; after an exit that was not at the mean, no new trade
// until the price has been back at the mean.
//
// Costs are shown two ways:
//  - "two legs": the cross traded as two dollar pairs with the costs of the
//    config (spread of each bar not below the floor, slippage on every fill,
//    commission, swaps of both pairs). All of it is known.
//  - "own cross": the broker's own cross. Commission and slippage as in the
//    config, swaps as read from the FundedNext swap calculator on 2026-11-21,
//    and the spread ASSUMED to be SPREAD_SHARE of the two-leg spread (there are
//    no bars of the crosses in the project yet).
// No fills in the hours 22-01 by the server: the spread is wide there and the
// Bid files of two pairs do not move together (TZ 17.23).
//
// Usage: node research/fx-cross.mjs                    the first rule, the grid
//        node research/fx-cross.mjs stretch            the second rule: against the move of several days, fixed hold
//        node research/fx-cross.mjs family             the one cell of the second rule that stands out: its neighbours,
//                                                      the size of the move, the years, an account without swaps
//        node research/fx-cross.mjs detail <h> <z>     one cell by pair and by year (h = 0, 1, 2)
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const FROM = "2015-02-02", TO = "2021-12-08", MID = "2018-07-01";
const CUR = { EUR: ["EURUSD", false], GBP: ["GBPUSD", false], AUD: ["AUDUSD", false], NZD: ["NZDUSD", false], JPY: ["USDJPY", true], CAD: ["USDCAD", true], CHF: ["USDCHF", true] };
const DOLLAR = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
/** Crosses inside one bloc of linked economies (Australia, New Zealand, Canada; euro area, Britain, Switzerland): named before any run. */
const SAME_BLOC = new Set(["AUDNZD", "AUDCAD", "NZDCAD", "EURGBP", "EURCHF", "GBPCHF"]);
/** FundedNext swap calculator, read 2026-11-21: points per lot per night, buy / sell (a point is a tenth of a pip). */
const OWN_SWAP = {
  EURGBP: [-7.16, 0.056], EURAUD: [2.973, -3.08], EURNZD: [-19.005, 2.25], EURJPY: [-16.6038, -49.56], EURCAD: [-11.235, 0.085], EURCHF: [-6.539, -13.32],
  GBPAUD: [-2.73, -15.135], GBPNZD: [-10.905, -6.555], GBPJPY: [-25.806, -44.278], GBPCAD: [-4.59, -11.835], GBPCHF: [-8.251, -26.37],
  AUDNZD: [1.35, -0.78], AUDJPY: [-11.27, -19.841], AUDCAD: [-5.565, -1.32], AUDCHF: [-2.41, -9.69],
  NZDJPY: [-15.837, -21.783], NZDCAD: [-1.17, -6.818], NZDCHF: [0.347, -11.58],
  CADJPY: [-15.315, -26.82], CADCHF: [-3.3456, -13.245], CHFJPY: [-6.1206, -17.37],
};
/** The assumed spread of the broker's own cross as a share of the two-leg spread. */
const SPREAD_SHARE = 0.7;
const HORIZONS = [
  { name: "inside the day (mean of 24 h)", n: 24, intraday: true },
  { name: "days (mean of 120 h)", n: 120, maxHold: 120 },
  { name: "weeks (mean of 480 h)", n: 480, maxHold: 480 },
];
const ZS = [1.5, 2, 2.5, 3];
const SIGMA_BARS = 480;

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function tOf(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return sd === 0 ? NaN : m / (sd / Math.sqrt(xs.length));
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const hoursOf = (date, hour) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hour) / 3600e3;
const T0 = hoursOf(FROM, 0); // a Monday
const WEEKS = Math.ceil((hoursOf(TO, 24) - T0) / 168);
const MONTHS = (hoursOf(TO, 24) - T0) / 24 / 30.4375;

// ------------------------------------------------------------------ the dollar pairs, hour by hour
function loadPair(pair) {
  const own = config.symbols[pair];
  const point = 10 ** -own.digits, pip = point * 10;
  const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip;
  const base = own.usdSide === "base";
  const lines = readFileSync(`${config.dataDir}/${pair}_H1.csv`, "utf8").split(/\r?\n/);
  const rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after the end of dev is read
    const o = +p[2];
    rows.set(`${date} ${p[1].slice(0, 2)}`, {
      o, c: +p[5],
      // All as a share of the price (of the money in the trade).
      spread: (Math.max(+p[8], floor) * point) / o,
      slip: (2 * config.costs.slippagePips * pip) / o,
      comm: base ? commission / own.contractSize : commission / (own.contractSize * o),
      swapLong: (own.swapLongPips * pip) / o, swapShort: (own.swapShortPips * pip) / o,
    });
  }
  return rows;
}
const pairs = new Map(DOLLAR.map((p) => [p, loadPair(p)]));

/** One instrument as arrays: a dollar pair as it is, or a cross of two currencies. */
function build(name, group, keys, at) {
  const len = keys.length;
  const m = { name, group, len, date: new Array(len), hour: new Uint8Array(len), wd: new Uint8Array(len), t: new Float64Array(len), o: new Float64Array(len), l: new Float64Array(len) };
  for (const k of ["spread2", "slip2", "comm2", "swap2Long", "swap2Short", "ownSpread", "ownSlip", "ownComm", "ownSwapLong", "ownSwapShort", "sigma"]) m[k] = new Float64Array(len);
  keys.forEach((key, i) => {
    const date = key.slice(0, 10), hour = +key.slice(11, 13), r = at(key);
    m.date[i] = date; m.hour[i] = hour; m.t[i] = hoursOf(date, hour); m.wd[i] = new Date(`${date}T00:00:00Z`).getUTCDay();
    m.o[i] = r.o; m.l[i] = Math.log(r.c);
    for (const k of ["spread2", "slip2", "comm2", "swap2Long", "swap2Short", "ownSpread", "ownSlip", "ownComm", "ownSwapLong", "ownSwapShort"]) m[k][i] = r[k];
  });
  // The usual move of a day: root mean square of the hourly moves of the last 480 hours, times the root of 24.
  const sq = new Float64Array(len + 1);
  for (let i = 1; i < len; i++) sq[i + 1] = sq[i] + (m.l[i] - m.l[i - 1]) ** 2;
  for (let i = SIGMA_BARS; i < len; i++) m.sigma[i] = Math.sqrt(((sq[i + 1] - sq[i + 1 - SIGMA_BARS]) / SIGMA_BARS) * 24);
  m.cum = new Float64Array(len + 1); m.cum2 = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) { m.cum[i + 1] = m.cum[i] + m.l[i]; m.cum2[i + 1] = m.cum2[i] + m.l[i] ** 2; }
  m.stats = new Map();
  return m;
}
/** Mean and standard deviation of the last n log closes, the bar itself included. */
function stats(m, n) {
  if (m.stats.has(n)) return m.stats.get(n);
  const mu = new Float64Array(m.len), sd = new Float64Array(m.len);
  for (let i = n - 1; i < m.len; i++) {
    const a = (m.cum[i + 1] - m.cum[i + 1 - n]) / n;
    mu[i] = a; sd[i] = Math.sqrt(Math.max(0, (m.cum2[i + 1] - m.cum2[i + 1 - n]) / n - a * a));
  }
  const out = { mu, sd };
  m.stats.set(n, out);
  return out;
}

const markets = [];
for (const pair of DOLLAR) {
  const rows = pairs.get(pair);
  markets.push(build(pair, "dollar pairs", [...rows.keys()], (key) => {
    const r = rows.get(key);
    return { o: r.o, c: r.c, spread2: r.spread, slip2: r.slip, comm2: r.comm, swap2Long: r.swapLong, swap2Short: r.swapShort, ownSpread: r.spread, ownSlip: r.slip, ownComm: r.comm, ownSwapLong: r.swapLong, ownSwapShort: r.swapShort };
  }));
}
for (const name of Object.keys(OWN_SWAP)) {
  const X = name.slice(0, 3), Y = name.slice(3);
  const [pairX, invX] = CUR[X], [pairY, invY] = CUR[Y];
  const A = pairs.get(pairX), B = pairs.get(pairY);
  const keys = [...A.keys()].filter((k) => B.has(k));
  const point = Y === "JPY" ? 0.001 : 0.00001;
  const commission = config.costs.commissionPerLotRoundTrip;
  markets.push(build(name, SAME_BLOC.has(name) ? "crosses inside a bloc" : "other crosses", keys, (key) => {
    const a = A.get(key), b = B.get(key);
    const value = (r, inv, field) => (inv ? 1 / r[field] : r[field]); // dollars for one unit of the currency
    const o = value(a, invX, "o") / value(b, invY, "o"), c = value(a, invX, "c") / value(b, invY, "c");
    // Long the cross = long X against the dollar and short Y against the dollar.
    return {
      o, c,
      spread2: a.spread + b.spread, slip2: a.slip + b.slip, comm2: a.comm + b.comm,
      swap2Long: (invX ? a.swapShort : a.swapLong) + (invY ? b.swapLong : b.swapShort),
      swap2Short: (invX ? a.swapLong : a.swapShort) + (invY ? b.swapShort : b.swapLong),
      ownSpread: SPREAD_SHARE * (a.spread + b.spread),
      ownSlip: (2 * config.costs.slippagePips * point * 10) / o,
      ownComm: commission / (100000 * value(a, invX, "o")), // a lot is 100 000 units of X
      ownSwapLong: (OWN_SWAP[name][0] * point) / o, ownSwapShort: (OWN_SWAP[name][1] * point) / o,
    };
  }));
}

// ------------------------------------------------------------------ the rules
/** A trade from the open of bar e to the price px at bar x, signal on the close of bar i: the move and both sets of costs, as shares of the price. */
function priced(m, i, e, x, px, dir, reason) {
  let nights = 0;
  for (let k = e + 1; k <= x; k++) if (m.date[k] !== m.date[k - 1]) nights += m.wd[k - 1] === 3 ? 3 : 1; // the night after Wednesday is charged three times
  const spread2 = (m.spread2[e] + m.spread2[x]) / 2, ownSpread = (m.ownSpread[e] + m.ownSpread[x]) / 2;
  const gross = dir * Math.log(px / m.o[e]);
  const two = spread2 + m.slip2[e] + m.comm2[e], twoSwap = (dir > 0 ? m.swap2Long[e] : m.swap2Short[e]) * nights;
  const own = ownSpread + m.ownSlip[e] + m.ownComm[e], ownSwap = (dir > 0 ? m.ownSwapLong[e] : m.ownSwapShort[e]) * nights;
  return { name: m.name, group: m.group, date: m.date[e], week: Math.floor((m.t[e] - T0) / 168), dir, hold: x - e, nights, sig: m.sigma[i], gross, two, twoSwap, own, ownSwap, net2: gross - two + twoSwap, netOwn: gross - own + ownSwap, reason };
}
/**
 * The second rule, the one the scan of TZ 17.23 pointed at: once a day, at 21:00 by the server, the move of the
 * last k days in units of the usual move of k days; further than Z, trade against it at that hour's open and
 * leave at the same hour `hold` trading days later. One position per pair.
 */
function stretch(m, k, Z, hold, zMax = Infinity) {
  const pts = [];
  for (let i = 0; i < m.len; i++) if (m.hour[i] === 20) pts.push(i);
  const trades = [];
  let busyUntil = -1;
  for (let d = k; d + hold < pts.length; d++) {
    const i = pts[d];
    if (i < SIGMA_BARS + 1 || m.date[i] < FROM || d < busyUntil || !(m.sigma[i] > 0)) continue;
    const z = (m.l[i] - m.l[pts[d - k]]) / (m.sigma[i] * Math.sqrt(k));
    if (Math.abs(z) < Z || Math.abs(z) >= zMax) continue;
    const e = i + 1, x = pts[d + hold] + 1;
    if (x >= m.len || m.t[e] - m.t[i] !== 1 || m.hour[x] !== 21) continue;
    trades.push(priced(m, i, e, x, m.o[x], z > 0 ? -1 : 1, "time"));
    busyUntil = d + hold;
  }
  return trades;
}
function simulate(m, h, Z) {
  const { mu, sd } = stats(m, h.n);
  const trades = [];
  let armed = true, lastSide = 0;
  for (let i = Math.max(h.n, SIGMA_BARS + 1); i + 1 < m.len; i++) {
    const dev = m.l[i] - mu[i];
    if (!armed) { if (dev * lastSide <= 0) armed = true; else continue; }
    if (m.date[i] < FROM || !(sd[i] > 0)) continue;
    const z = dev / sd[i];
    if (Math.abs(z) < Z) continue;
    const hr = m.hour[i];
    if (h.intraday ? !(hr >= 3 && hr <= 16) : !(hr >= 2 && hr <= 20)) continue;
    if (m.t[i + 1] - m.t[i] !== 1) continue; // no entry over a hole in the bars
    const e = i + 1, dir = z > 0 ? -1 : 1;
    let x = -1, px = NaN, reason = "";
    for (let j = e; j < m.len; j++) {
      if (h.intraday) {
        if (m.date[j] !== m.date[e]) { x = j - 1; px = Math.exp(m.l[j - 1]); reason = "day end"; break; }
        if (m.hour[j] >= 22) { x = j; px = m.o[j]; reason = "day end"; break; }
      } else if (j - e >= h.maxHold && m.hour[j] >= 3 && m.hour[j] <= 21) { x = j; px = m.o[j]; reason = "time"; break; }
      const back = dir > 0 ? m.l[j] >= mu[j] : m.l[j] <= mu[j];
      if (back && j + 1 < m.len && (h.intraday ? m.date[j + 1] === m.date[e] : m.hour[j] >= 2 && m.hour[j] <= 20)) { x = j + 1; px = m.o[j + 1]; reason = "mean"; break; }
    }
    if (x < 0) break;
    trades.push(priced(m, i, e, x, px, dir, reason));
    if (reason !== "mean") { armed = false; lastSide = -dir; }
    i = x - 1;
  }
  return trades;
}

// ------------------------------------------------------------------ the tables
const GROUPS = ["crosses inside a bloc", "other crosses", "dollar pairs"];
const HEAD = `${pad("", 30)} ${lpad("n", 6)} ${lpad("a mo", 6)} ${lpad("hold h", 6)} ${lpad("win", 4)} | ${lpad("before", 7)} ${lpad("in sig", 7)} ${lpad("t", 5)} | ${lpad("2 legs", 6)} ${lpad("swaps", 6)} ${lpad("after", 7)} ${lpad("t", 5)} | ${lpad("own", 6)} ${lpad("swaps", 6)} ${lpad("after", 7)} ${lpad("t", 5)} | ${lpad("halves, own", 15)} | pairs+ | worst`;
/** By weeks: every trade is put into the week of its entry in units of the usual daily move, the weeks without a trade count as zero. */
function weeklyT(ts, field) {
  const w = new Array(WEEKS).fill(0);
  for (const x of ts) w[x.week] += x[field] / x.sig;
  return tOf(w);
}
function line(label, ts) {
  if (ts.length === 0) return `${pad(label, 30)} ${lpad(0, 6)}`;
  const bp = (field) => mean(ts.map((x) => x[field])) * 1e4, sig = (field, xs = ts) => mean(xs.map((x) => x[field] / x.sig));
  const names = [...new Set(ts.map((x) => x.name))];
  const plus = names.filter((nm) => sig("netOwn", ts.filter((x) => x.name === nm)) > 0).length;
  const first = ts.filter((x) => x.date < MID), second = ts.filter((x) => x.date >= MID);
  return `${pad(label, 30)} ${lpad(ts.length, 6)} ${lpad((ts.length / MONTHS).toFixed(1), 6)} ${lpad(mean(ts.map((x) => x.hold)).toFixed(0), 6)} ${lpad(((ts.filter((x) => x.gross > 0).length / ts.length) * 100).toFixed(0) + "%", 4)} | ${lpad(f(bp("gross"), 1), 7)} ${lpad(f(sig("gross"), 3), 7)} ${lpad(f(weeklyT(ts, "gross"), 1), 5)} | ${lpad(f(-bp("two"), 1), 6)} ${lpad(f(bp("twoSwap"), 1), 6)} ${lpad(f(sig("net2"), 3), 7)} ${lpad(f(weeklyT(ts, "net2"), 1), 5)} | ${lpad(f(-bp("own"), 1), 6)} ${lpad(f(bp("ownSwap"), 1), 6)} ${lpad(f(sig("netOwn"), 3), 7)} ${lpad(f(weeklyT(ts, "netOwn"), 1), 5)} | ${lpad(f(sig("netOwn", first), 3), 7)} ${lpad(f(sig("netOwn", second), 3), 7)} | ${lpad(`${plus}/${names.length}`, 6)} | ${f(Math.min(...ts.map((x) => x.netOwn / x.sig)), 1)}`;
}

const [mode = "grid", hArg = "0", zArg = "2"] = process.argv.slice(2);
console.log(`dev ${FROM}..${TO}: ${WEEKS} weeks, ${MONTHS.toFixed(1)} months; ${markets.length} instruments`);
console.log("before / 2 legs / own / swaps: basis points of the price per trade; 'in sig' and 'after': in usual daily moves of the pair; t by weeks");
console.log(`own cross: spread assumed at ${SPREAD_SHARE} of the two-leg spread; halves split at ${MID}; pairs+ and worst trade after the own-cross costs\n`);
if (mode === "grid") {
  for (const h of HORIZONS) {
    console.log(`=== ${h.name}: against a close further than Z deviations from the mean ===`);
    console.log(HEAD);
    for (const Z of ZS) {
      const all = markets.flatMap((m) => simulate(m, h, Z));
      for (const g of GROUPS) console.log(line(`Z ${Z.toFixed(1)}  ${g}`, all.filter((x) => x.group === g)));
    }
    console.log("");
  }
} else if (mode === "stretch") {
  console.log("=== against the move of the last k days further than Z usual moves, held for a fixed number of days ===");
  console.log(HEAD);
  for (const k of [5, 10]) for (const hold of [2, 5]) for (const Z of [1.5, 2, 2.5]) {
    const all = markets.flatMap((m) => stretch(m, k, Z, hold));
    for (const g of GROUPS) console.log(line(`k ${k} hold ${hold} Z ${Z.toFixed(1)} ${g.slice(0, 13)}`, all.filter((x) => x.group === g)));
  }
  // The one family with the same sign everywhere, on an account without swaps and with all 28 instruments together.
  console.log("");
  console.log("=== the move of 10 days, Z 1.5: with swaps, and the same trades on an account without swaps ===");
  console.log(HEAD);
  const noSwaps = (ts) => ts.map((x) => ({ ...x, twoSwap: 0, ownSwap: 0, net2: x.gross - x.two, netOwn: x.gross - x.own }));
  for (const hold of [2, 5]) {
    const all = markets.flatMap((m) => stretch(m, 10, 1.5, hold));
    console.log(line(`hold ${hold} all 28, with swaps`, all));
    console.log(line(`hold ${hold} all 28, no swaps`, noSwaps(all)));
    for (const g of GROUPS) console.log(line(`hold ${hold} no swaps ${g.slice(0, 13)}`, noSwaps(all.filter((x) => x.group === g))));
  }
} else if (mode === "family") {
  // Is the cell "10 days, 5 days" a plateau or a lone peak; year by year; and what the same trade gives after an ordinary move.
  const noSwaps = (ts) => ts.map((x) => ({ ...x, twoSwap: 0, ownSwap: 0, net2: x.gross - x.two, netOwn: x.gross - x.own }));
  console.log("=== all 28 instruments together, Z 1.5, on an account WITHOUT swaps: the length of the move k and the days held ===");
  console.log(HEAD);
  for (const k of [5, 7, 10, 15, 20]) for (const hold of [2, 3, 5, 7, 10]) console.log(line(`k ${k} hold ${hold}`, noSwaps(markets.flatMap((m) => stretch(m, k, 1.5, hold)))));
  console.log("");
  console.log("=== k 10, hold 5, all 28: by the size of the move (the first row is the control: after an ordinary move), without swaps ===");
  console.log(HEAD);
  for (const [lo, hi] of [[0.25, 1], [1, 1.5], [1.5, 2], [2, 2.5], [2.5, Infinity], [1.5, Infinity]]) console.log(line(`move ${lo} to ${hi}`, noSwaps(markets.flatMap((m) => stretch(m, 10, lo, 5, hi)))));
  const all = markets.flatMap((m) => stretch(m, 10, 1.5, 5));
  console.log("");
  console.log("=== k 10, hold 5, Z 1.5, all 28: by year, with swaps and without ===");
  console.log(HEAD);
  for (let y = 2015; y <= 2021; y++) {
    const ts = all.filter((x) => x.date.startsWith(String(y)));
    console.log(line(`${y} with swaps`, ts));
    console.log(line(`${y} no swaps`, noSwaps(ts)));
  }
  console.log("");
  console.log("=== k 10, hold 5, Z 1.5: by side and by instrument, without swaps ===");
  console.log(HEAD);
  console.log(line("buys", noSwaps(all.filter((x) => x.dir > 0))));
  console.log(line("sales", noSwaps(all.filter((x) => x.dir < 0))));
  for (const m of markets) console.log(line(`  ${m.name}`, noSwaps(all.filter((x) => x.name === m.name))));
  // The weeks: how deep the worst run is, in usual daily moves (one unit per trade).
  const weeks = new Array(WEEKS).fill(0);
  for (const x of noSwaps(all)) weeks[x.week] += x.netOwn / x.sig;
  let run = 0, peak = 0, dd = 0;
  for (const w of weeks) { run += w; peak = Math.max(peak, run); dd = Math.max(dd, peak - run); }
  console.log("");
  console.log(`without swaps, own-cross costs: total ${f(run, 1)} usual daily moves over ${WEEKS} weeks, the deepest fall ${dd.toFixed(1)}, the worst week ${f(Math.min(...weeks), 1)}, the best ${f(Math.max(...weeks), 1)}, weeks above zero ${((weeks.filter((w) => w > 0).length / weeks.filter((w) => w !== 0).length) * 100).toFixed(0)}% of those with trades`);
} else {
  const h = HORIZONS[+hArg], Z = +zArg;
  const all = markets.flatMap((m) => simulate(m, h, Z));
  console.log(`=== ${h.name}, Z ${Z}: by pair ===`);
  console.log(HEAD);
  for (const g of GROUPS) {
    console.log(line(g, all.filter((x) => x.group === g)));
    for (const m of markets.filter((x) => x.group === g)) console.log(line(`  ${m.name}`, all.filter((x) => x.name === m.name)));
  }
  console.log(`\n=== ${h.name}, Z ${Z}: by year ===`);
  console.log(HEAD);
  for (const g of GROUPS) for (let y = 2015; y <= 2021; y++) console.log(line(`${g.slice(0, 22)} ${y}`, all.filter((x) => x.group === g && x.date.startsWith(String(y)))));
  console.log(`\n=== ${h.name}, Z ${Z}: by the way out and by side ===`);
  console.log(HEAD);
  for (const g of GROUPS) {
    const ts = all.filter((x) => x.group === g);
    for (const reason of [...new Set(ts.map((x) => x.reason))]) console.log(line(`${g.slice(0, 20)} ${reason}`, ts.filter((x) => x.reason === reason)));
    console.log(line(`${g.slice(0, 20)} buys`, ts.filter((x) => x.dir > 0)));
    console.log(line(`${g.slice(0, 20)} sales`, ts.filter((x) => x.dir < 0)));
  }
}
