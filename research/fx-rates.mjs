// Interest-rate expectations and commodities as a pointer for currency pairs
// (TZ 17.33). Dev only: nothing after 2021-12-08 is read, neither prices nor
// yields nor commodity prices.
//
// Two families of signals, both formed after the close of a server day d and
// traded from 02:00 by the server on the next trading day:
//
//  rates  the yield of the base currency's government bond minus the yield of
//         the quote currency's (2-year, and 5-year as a second look) has
//         changed over the last N days by at least Z of its usual N-day
//         change. Trade: the pair in the direction of the change (the
//         currency whose yield has risen is bought). Six pairs: New Zealand
//         has no yield file.
//  goods  a commodity has moved over the last N days by at least Z of its
//         usual N-day move. Trade: USDCAD against oil (oil up, Canadian
//         dollar up), AUDUSD with copper.
//
// Everything dated d is known before 02:00 of the next server day (the US and
// Canadian closes are the latest, 15:30-17:00 New York = 22:30-24:00 server).
// Hold: H trading days, out at 22:00 of the last one (H = 1 is 02:00-22:00 of
// one day, no swap). Two versions of a cell: every signal, and only those
// where the pair itself has done less than half of what its usual link to the
// pointer implies ("has not followed yet"). One trade per pair and cell at a
// time. Moves in basis points of the price before costs; beside them the cost
// of one trade of the project with swaps and without. t by weeks, the number
// of a week being the sum of its trades.
//
// Usage: node research/fx-rates.mjs                 the grids
//        node research/fx-rates.mjs link            how the pairs move with the pointers on the same day
//        node research/fx-rates.mjs cell <family> <N> <H> <Z> <all|lag>   one cell by pair, year, side
//          family: rates2 | rates5 | goods
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const FROM = "2015-02-02", TO = "2021-12-08", MID = "2018-07-01";
const RATE_PAIRS = { EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], USDJPY: ["USD", "JPY"], AUDUSD: ["AUD", "USD"], USDCAD: ["USD", "CAD"], USDCHF: ["USD", "CHF"] };
/** The commodity, the pair, and the side of the pair when the commodity rises. */
const GOODS = [{ good: "WTI", pair: "USDCAD", side: -1 }, { good: "COPPER", pair: "AUDUSD", side: 1 }];
const NS = [1, 5, 20], HS = [1, 5, 20], ZS = [0.5, 1, 2];
const USUAL_DAYS = 250, MIN_USUAL = 120, FILL_DAYS = 3;
const OPEN = 2 * 60, CLOSE = 22 * 60;

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function tOf(xs) {
  if (xs.length < 3) return NaN;
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / (xs.length - 1)));
  return sd === 0 ? NaN : m / (sd / Math.sqrt(xs.length));
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const dayNumber = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400e3;
const weekdayOf = (day) => (day + 4) % 7;
const MONTHS = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.4375);

// ------------------------------------------------------------------ prices: the opens at 02:00 and 22:00 of every server day
function loadPair(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  const usdBase = own.usdSide === "base";
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const days = new Map();
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after the end of dev is read
    const minute = +p[1].slice(0, 2) * 60 + +p[1].slice(3, 5);
    if (minute !== OPEN && minute !== CLOSE) continue;
    if (!days.has(date)) days.set(date, { date, day: dayNumber(date) });
    const o = +p[2], d = days.get(date);
    if (minute === OPEN) { d.open = o; d.openHalf = (Math.max(+p[8], floor) * point) / 2 / o; } else { d.close = o; d.closeHalf = (Math.max(+p[8], floor) * point) / 2 / o; }
  }
  const list = [...days.values()].filter((d) => d.open !== undefined && d.close !== undefined);
  return {
    symbol, list, index: new Map(list.map((d, i) => [d.date, i])),
    fixed: (a) => (2 * config.costs.slippagePips * pip + (usdBase ? commission * a.open : commission)) / a.open,
    swapLong: own.swapLongPips * pip, swapShort: own.swapShortPips * pip,
  };
}
/** Rollovers from the entry day to the exit day: one for the end of every weekday, three for the end of Wednesday. */
function nights(a, b) {
  let n = 0;
  for (let d = a.day; d < b.day; d++) { const wd = weekdayOf(d); if (wd >= 1 && wd <= 5) n += wd === 3 ? 3 : 1; }
  return n;
}
/** A trade from 02:00 of list[i] to 22:00 of list[j]: move, cost without swaps and the swaps, all in basis points. */
function priced(P, i, j, side) {
  const a = P.list[i], b = P.list[j];
  return {
    bp: side * Math.log(b.close / a.open) * 1e4,
    cost: (a.openHalf + b.closeHalf + P.fixed(a)) * 1e4,
    swap: ((-(side > 0 ? P.swapLong : P.swapShort) * nights(a, b)) / a.open) * 1e4,
  };
}

// ------------------------------------------------------------------ pointers: a value for every calendar date, the last known one within three days
function loadTable(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = lines[0].split(",");
  const columns = new Map(head.slice(1).map((h) => [h, new Map()]));
  for (const l of lines.slice(1)) {
    const c = l.split(",");
    if (c[0] > TO) break; // nothing after the end of dev is read
    head.slice(1).forEach((h, k) => { if (c[k + 1] !== undefined && c[k + 1] !== "") columns.get(h).set(c[0], +c[k + 1]); });
  }
  return columns;
}
const yields = loadTable("data/raw/research-rates/yields.csv");
const goods = loadTable("data/raw/research-rates/commodities.csv");
/** The value of a series on a date: that day's, or the last one not older than three calendar days before a weekend-free gap of FILL_DAYS business days. */
function at(seriesMap, date) {
  let day = dayNumber(date);
  for (let back = 0, business = 0; business <= FILL_DAYS && back < 10; back++, day--) {
    const d = new Date(day * 86400e3).toISOString().slice(0, 10), v = seriesMap.get(d);
    if (v !== undefined) return v;
    const wd = weekdayOf(day);
    if (wd >= 1 && wd <= 5) business++;
  }
  return NaN;
}

// ------------------------------------------------------------------ one pointer and one pair: every signal of every cell
/**
 * pointer(date) is the level of the pointer (a yield difference in per cent, or the log of a commodity price);
 * side is the side of the pair when the pointer rises. Returns Map "N|H|Z|all" and "N|H|Z|lag" -> trades.
 */
function signals(P, pointer, side) {
  const n = P.list.length;
  const level = P.list.map((d) => pointer(d.date));
  const close = P.list.map((d) => Math.log(d.close));
  // The usual link of the pair to the pointer: slope of the pair's daily move on the pointer's daily change over the 250 days before.
  const dx = new Float64Array(n).fill(NaN), dy = new Float64Array(n).fill(NaN);
  for (let i = 1; i < n; i++) { dx[i] = level[i] - level[i - 1]; dy[i] = close[i] - close[i - 1]; }
  const out = new Map(), busy = new Map();
  for (const N of NS) for (const H of HS) for (const Z of ZS) for (const v of ["all", "lag"]) { out.set(`${N}|${H}|${Z}|${v}`, []); busy.set(`${N}|${H}|${Z}|${v}`, -1); }
  for (let i = MIN_USUAL + NS.at(-1); i < n - 1; i++) {
    if (P.list[i + 1].date < FROM) continue;
    let sxy = 0, sxx = 0, cnt = 0;
    for (let k = Math.max(1, i - USUAL_DAYS + 1); k <= i; k++) if (Number.isFinite(dx[k]) && Number.isFinite(dy[k])) { sxy += dx[k] * dy[k]; sxx += dx[k] * dx[k]; cnt++; }
    const beta = cnt >= MIN_USUAL && sxx > 0 ? sxy / sxx : NaN;
    for (const N of NS) {
      const change = level[i] - level[i - N];
      if (!Number.isFinite(change) || change === 0) continue;
      // The usual N-day change: root mean square of the N-day changes of the 250 days before this one.
      let sq = 0, m = 0;
      for (let k = Math.max(N, i - USUAL_DAYS); k < i; k++) { const c = level[k] - level[k - N]; if (Number.isFinite(c)) { sq += c * c; m++; } }
      if (m < MIN_USUAL || sq === 0) continue;
      const z = Math.abs(change) / Math.sqrt(sq / m);
      if (z < ZS[0]) continue;
      const dir = side * Math.sign(change);
      const own = close[i] - close[i - N]; // what the pair itself has done over the same days
      let sqOwn = 0, mOwn = 0;
      for (let k = Math.max(N, i - USUAL_DAYS); k < i; k++) { sqOwn += (close[k] - close[k - N]) ** 2; mOwn++; }
      const ownSize = (dir * own) / Math.sqrt(sqOwn / mOwn);
      const lagging = Number.isFinite(beta) && beta * side > 0 && dir * own < 0.5 * Math.abs(beta * change);
      for (const H of HS) {
        const j = i + H; // entry at 02:00 of day i+1, exit at 22:00 of day i+H
        if (j >= n) continue;
        const t = priced(P, i + 1, j, dir);
        for (const Z of ZS) {
          if (z < Z) continue;
          for (const v of lagging ? ["all", "lag"] : ["all"]) {
            const key = `${N}|${H}|${Z}|${v}`;
            if (i < busy.get(key)) continue; // one trade per pair and cell at a time
            busy.set(key, j);
            out.get(key).push({ pair: P.symbol, date: P.list[i + 1].date, day: P.list[i + 1].day, dir, z, ownSize, ...t });
          }
        }
      }
    }
  }
  return out;
}

/** t by weeks: the week's number is the sum of its trades. */
function summary(recs, months = MONTHS) {
  const weeks = new Map();
  for (const r of recs) { const w = Math.floor((r.day + 3) / 7); weeks.set(w, (weeks.get(w) ?? 0) + r.bp); }
  const names = [...new Set(recs.map((r) => r.pair))];
  const part = (keep) => mean(recs.filter((r) => keep(r.date)).map((r) => r.bp));
  return {
    n: recs.length, perMonth: recs.length / months, mean: mean(recs.map((r) => r.bp)), t: tOf([...weeks.values()]),
    first: part((d) => d < MID), second: part((d) => d >= MID),
    plus: names.filter((p) => mean(recs.filter((r) => r.pair === p).map((r) => r.bp)) > 0).length, of: names.length,
    cost: mean(recs.map((r) => r.cost)), swap: mean(recs.map((r) => r.swap)),
  };
}
const HEAD = `${pad("", 34)} ${lpad("n", 5)} ${lpad("a mo", 5)} | ${lpad("move", 7)} ${lpad("t", 5)} | ${lpad("halves", 15)} | ${lpad("pairs+", 6)} | ${lpad("cost", 5)} ${lpad("swap", 5)} ${lpad("left", 7)} ${lpad("no swap", 8)}`;
const row = (label, s) => `${pad(label, 34)} ${lpad(s.n, 5)} ${lpad(s.perMonth.toFixed(1), 5)} | ${lpad(f(s.mean), 7)} ${lpad(f(s.t, 1), 5)} | ${lpad(f(s.first), 7)} ${lpad(f(s.second), 7)} | ${lpad(`${s.plus}/${s.of}`, 6)} | ${lpad(s.cost.toFixed(2), 5)} ${lpad(s.swap.toFixed(2), 5)} ${lpad(f(s.mean - s.cost - s.swap), 7)} ${lpad(f(s.mean - s.cost), 8)}`;

const pairs = new Map([...Object.keys(RATE_PAIRS), ...GOODS.map((g) => g.pair)].map((s) => [s, null]));
for (const s of pairs.keys()) pairs.set(s, loadPair(s));

// ------------------------------------------------------------------ the 15 crosses of the six currencies that have a yield file
// Prices are built from the two dollar pairs at the same moments. Costs are those of the broker's own cross as in TZ 17.29:
// commission and slippage of the config, the spread ASSUMED to be 0.7 of the two dollar spreads, swaps as read from the
// FundedNext calculator on 2026-11-21 (points per lot per night, buy / sell; a point is a tenth of a pip).
const USD_PAIR = { EUR: ["EURUSD", false], GBP: ["GBPUSD", false], AUD: ["AUDUSD", false], JPY: ["USDJPY", true], CAD: ["USDCAD", true], CHF: ["USDCHF", true] };
const CROSS_SWAP = {
  EURGBP: [-7.16, 0.056], EURAUD: [2.973, -3.08], EURJPY: [-16.6038, -49.56], EURCAD: [-11.235, 0.085], EURCHF: [-6.539, -13.32],
  GBPAUD: [-2.73, -15.135], GBPJPY: [-25.806, -44.278], GBPCAD: [-4.59, -11.835], GBPCHF: [-8.251, -26.37],
  AUDJPY: [-11.27, -19.841], AUDCAD: [-5.565, -1.32], AUDCHF: [-2.41, -9.69], CADJPY: [-15.315, -26.82], CADCHF: [-3.3456, -13.245], CHFJPY: [-6.1206, -17.37],
};
const SPREAD_SHARE = 0.7;
function buildCross(name) {
  const base = name.slice(0, 3), quote = name.slice(3), [bp, bInv] = USD_PAIR[base], [qp, qInv] = USD_PAIR[quote];
  const B = pairs.get(bp), Q = pairs.get(qp), pip = quote === "JPY" ? 0.01 : 0.0001;
  const commission = config.costs.commissionPerLotRoundTrip / 100000; // dollars for one unit of the base currency
  const list = [];
  for (const b of B.list) {
    const k = Q.index.get(b.date);
    if (k === undefined) continue;
    const q = Q.list[k];
    const usd = (x, inv) => (inv ? 1 / x : x); // dollars for one unit of the currency
    list.push({
      date: b.date, day: b.day, open: usd(b.open, bInv) / usd(q.open, qInv), close: usd(b.close, bInv) / usd(q.close, qInv),
      openHalf: SPREAD_SHARE * (b.openHalf + q.openHalf), closeHalf: SPREAD_SHARE * (b.closeHalf + q.closeHalf), baseUsd: usd(b.open, bInv),
    });
  }
  return {
    symbol: name, list, index: new Map(list.map((d, i) => [d.date, i])),
    fixed: (a) => (2 * config.costs.slippagePips * pip) / a.open + commission / a.baseUsd,
    swapLong: (CROSS_SWAP[name][0] * pip) / 10, swapShort: (CROSS_SWAP[name][1] * pip) / 10,
  };
}
const crosses = new Map(Object.keys(CROSS_SWAP).map((name) => [name, buildCross(name)]));

/** The cells of a family: Map key -> trades of all its pairs. */
function family(name) {
  const cells = new Map();
  const add = (m) => { for (const [k, recs] of m) { if (!cells.has(k)) cells.set(k, []); cells.get(k).push(...recs); } };
  if (name === "goods") for (const g of GOODS) add(signals(pairs.get(g.pair), (date) => Math.log(at(goods.get(g.good), date)), g.side));
  else {
    const tenor = name[5], set = name.slice(6);
    const one = (currency, date) => (tenor === "m" ? (at(yields.get(currency + "2"), date) + at(yields.get(currency + "5"), date)) / 2 : at(yields.get(currency + tenor), date));
    const difference = (base, quote) => (date) => one(base, date) - one(quote, date);
    if (set !== "") for (const [symbol, P] of crosses) add(signals(P, difference(symbol.slice(0, 3), symbol.slice(3)), 1));
    if (set !== "x") for (const [symbol, [base, quote]] of Object.entries(RATE_PAIRS)) add(signals(pairs.get(symbol), difference(base, quote), 1));
  }
  return cells;
}
const TITLES = {
  rates2: "the difference of 2-year yields, six dollar pairs", rates5: "the difference of 5-year yields, six dollar pairs",
  rates2x: "the difference of 2-year yields, the 15 crosses", rates5x: "the difference of 5-year yields, the 15 crosses",
  goods: "oil for the Canadian dollar, copper for the Australian dollar",
};
/** Months from the first trade of a family to the end of dev. */
const monthsOf = (cells) => { let first = TO; for (const recs of cells.values()) for (const r of recs) if (r.date < first) first = r.date; return { first, months: (Date.parse(TO) - Date.parse(first)) / (86400e3 * 30.4375) }; };
const [mode = "grid", famArg, nArg, hArg, zArg, vArg] = process.argv.slice(2);
console.log(`dev ${FROM}..${TO}; moves in basis points of the price in the direction of the pointer, before costs; t by weeks; left = move minus cost and swaps; no swap = move minus cost`);
console.log("all = every signal; lag = only when the pair has done less than half of what its usual link to the pointer implies\n");

if (mode === "grid") {
  for (const name of Object.keys(TITLES)) {
    const cells = family(name), { first, months } = monthsOf(cells);
    const list = [...cells].map(([key, recs]) => { const [N, H, Z, v] = key.split("|"); return { label: `last ${N} d, then ${H} d, size ${Z}+, ${v}`, N: +N, H: +H, Z: +Z, v, s: summary(recs, months) }; }).filter((c) => c.s.n >= 30);
    list.sort((a, b) => Math.abs(b.s.t) - Math.abs(a.s.t));
    console.log(`=== ${TITLES[name]} (trades from ${first}): ${list.length} cells with 30 trades and more, the 14 with the largest |t| ===`);
    console.log(HEAD);
    for (const c of list.slice(0, 14)) console.log(row(c.label, c.s));
    const above = list.filter((c) => c.s.mean > c.s.cost + c.s.swap), noSwap = list.filter((c) => c.s.mean > c.s.cost);
    console.log(`|t| of 2 and more: ${list.filter((c) => Math.abs(c.s.t) >= 2).length} of ${list.length} (by chance about ${(list.length * 0.0455).toFixed(0)}); of 3 and more: ${list.filter((c) => Math.abs(c.s.t) >= 3).length}; the move is larger than cost and swaps in ${above.length}, larger than the cost without swaps in ${noSwap.length}`);
    for (const c of above.sort((a, b) => b.s.t - a.s.t).slice(0, 8)) console.log(row(`  > cost: ${c.label}`, c.s));
    for (const Z of [1, 2]) {
      console.log(`--- every signal of size ${Z} and more: move and t; rows = days of the pointer's change, columns = days held`);
      console.log(`${pad("", 8)} ${HS.map((H) => lpad(`${H} d`, 14)).join("")}`);
      for (const N of NS) console.log(`${pad(`${N} d`, 8)} ${HS.map((H) => { const c = list.find((x) => x.N === N && x.H === H && x.Z === Z && x.v === "all"); return lpad(c === undefined ? "n/a" : `${f(c.s.mean, 1)} (${f(c.s.t, 1)})`, 14); }).join("")}`);
    }
    console.log("");
  }
} else if (mode === "shock") {
  // The one cell that stood out: the day after a large one-day change of the yield difference. Every tenor and set of
  // pairs, thresholds around the one first looked at, the years, and whether it is anything else than "the day after a
  // large day of the pair itself" (the idea of BigDayFollowUSD, closed on test in TZ 17.23).
  console.log("=== the day after a large one-day change of the yield difference: move, t and trades a month by the size of the change ===");
  console.log(`${pad("", 34)} ${[1.5, 2, 2.5, 3].map((Z) => lpad(`size ${Z}+`, 22)).join("")}`);
  const keep = new Map();
  for (const tenor of ["2", "5", "m"]) for (const set of ["", "x", "a"]) {
    const cells = family(`rates${tenor}${set}`), { months } = monthsOf(cells), recs = cells.get("1|1|0.5|all");
    keep.set(tenor + set, { recs, months });
    const label = `${tenor === "m" ? "mean of 2 and 5 years" : `${tenor}-year`}, ${set === "" ? "6 dollar pairs" : set === "x" ? "15 crosses" : "all 21"}`;
    console.log(`${pad(label, 34)} ${[1.5, 2, 2.5, 3].map((Z) => { const s = summary(recs.filter((r) => r.z >= Z), months); return lpad(`${f(s.mean, 1)} (${f(s.t, 1)}) ${s.perMonth.toFixed(0)}/mo`, 22); }).join("")}`);
  }
  // The control with no yields in it: the day after the pair's own large day, in its direction.
  const own = [];
  for (const P of [...Object.keys(RATE_PAIRS).map((s) => pairs.get(s)), ...crosses.values()]) own.push(...signals(P, (date) => Math.log(P.list[P.index.get(date)].close), 1).get("1|1|0.5|all"));
  for (const key of ["2a", "5a", "ma"]) {
    const { recs, months } = keep.get(key), big = recs.filter((r) => r.z >= 2);
    console.log(`\n--- ${key === "ma" ? "mean of 2 and 5 years" : `${key[0]}-year`}, all 21 pairs, changes of 2 usual days and more`);
    console.log(HEAD);
    console.log(row("all", summary(big, months)));
    for (let y = 2015; y <= 2021; y++) console.log(row(String(y), summary(big.filter((r) => r.date.startsWith(String(y))), months)));
    for (const [label, lo, hi] of [["pair went against it that day", -Infinity, 0], ["pair with it, under 1 usual day", 0, 1], ["pair with it, 1 to 2 usual days", 1, 2], ["pair with it, 2 usual days and more", 2, Infinity]]) console.log(row(label, summary(big.filter((r) => r.ownSize >= lo && r.ownSize < hi), months)));
    console.log(row("control: after the pair's own 2+ day", summary(own.filter((r) => r.z >= 2), months)));
  }
} else if (mode === "link") {
  // The same-day link: how much of a pair's daily move (22:00 to 22:00) goes with the pointer's change of that day.
  console.log(`${pad("", 28)} ${lpad("days", 6)} ${lpad("corr", 7)} ${lpad("bp per unit", 12)}   (unit: 0.01 of a percentage point of yield difference, or 1% of the commodity)`);
  const link = (label, P, pointer, unit) => {
    const xs = [], ys = [];
    for (let i = 1; i < P.list.length; i++) {
      if (P.list[i].date < FROM) continue;
      const x = pointer(P.list[i].date) - pointer(P.list[i - 1].date), y = Math.log(P.list[i].close / P.list[i - 1].close) * 1e4;
      if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
    }
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
    console.log(`${pad(label, 28)} ${lpad(xs.length, 6)} ${lpad(f(sxy / Math.sqrt(sxx * syy)), 7)} ${lpad(f((sxy / sxx) * unit), 12)}`);
  };
  for (const tenor of ["2", "5"]) for (const [symbol, [base, quote]] of Object.entries(RATE_PAIRS)) link(`${symbol}, ${tenor}-year yields`, pairs.get(symbol), (date) => at(yields.get(base + tenor), date) - at(yields.get(quote + tenor), date), 0.01);
  for (const g of GOODS) link(`${g.pair}, ${g.good}`, pairs.get(g.pair), (date) => Math.log(at(goods.get(g.good), date)), 0.01);
} else {
  const cells = family(famArg), { months } = monthsOf(cells), recs = cells.get(`${nArg}|${hArg}|${zArg}|${vArg}`) ?? [];
  const summaryOf = (list) => summary(list, months);
  console.log(`=== ${TITLES[famArg]}: last ${nArg} d, then ${hArg} d, size ${zArg}+, ${vArg} ===`);
  console.log(HEAD);
  console.log(row("all", summaryOf(recs)));
  for (const p of [...new Set(recs.map((r) => r.pair))]) console.log(row(`  ${p}`, summaryOf(recs.filter((r) => r.pair === p))));
  for (let y = 2015; y <= 2021; y++) console.log(row(String(y), summaryOf(recs.filter((r) => r.date.startsWith(String(y))))));
  for (const [label, keep] of [["buys of the pair", (r) => r.dir > 0], ["sells of the pair", (r) => r.dir < 0]]) console.log(row(label, summaryOf(recs.filter(keep))));
  for (const [lo, hi] of [[0.5, 1], [1, 1.5], [1.5, 2], [2, 3], [3, Infinity]]) console.log(row(`size ${lo}-${hi === Infinity ? "" : hi}`, summaryOf(recs.filter((r) => r.z >= lo && r.z < hi))));
}
