// Currency strength (TZ 17.39): buy the strongest of the eight currencies against
// the weakest. Dev only: nothing after 2021-12-08 is read.
//
// The eight currencies are USD, EUR, GBP, JPY, AUD, NZD, CAD and CHF; the value of
// each in dollars comes from its dollar pair. "Strength" over a lookback is the
// change of that value; the dollar's own change is zero, so the ranking is the
// ranking of the changes against the average of the eight.
//
// A. Days. Once a day, at 10:00 by the server, the currencies are ranked by their
//    change over the last L trading days (the close of the 09:00 bar against the
//    same close L days before). The strongest N are bought and the weakest N sold
//    in equal parts at the open of the 10:00 bar and held H days. With H above one
//    day a new part of 1/H is opened every day and the part opened H days ago is
//    closed, so every day counts and no start day is chosen.
// B. Inside the day. The same with a lookback of L hours and a hold of H hours,
//    holds one after another from 02:00 to 22:00 by the server, flat at night.
//
// Positions are held in the dollar pairs (a cross is two of them). Costs: half a
// spread (not under the floor of the config), slippage and half the commission on
// every unit of a pair bought or sold; swaps of the config for every night,
// three times after Wednesday. Only the change of a position is traded.
//
// The control has no idea in it: the same portfolios with the ranking drawn at
// random, SHUFFLES times. "ctl" is the share of those draws that the real ranking
// beats before costs; 50% is what no edge gives.
//
// Usage: node research/fx-strength.mjs            dev, both parts
//        node research/fx-strength.mjs window     the first days of January 2015, before dev begins:
//                                                 every number of a few days, for checking the mechanics
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const windowMode = process.argv[2] === "window";
// GBPUSD begins on the first day of dev, so the check of the mechanics before dev runs on the other seven currencies.
const CUR = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"].filter((c) => !windowMode || c !== "GBP"), N = CUR.length;
const PAIR = { EUR: ["EURUSD", false], GBP: ["GBPUSD", false], JPY: ["USDJPY", true], AUD: ["AUDUSD", false], NZD: ["NZDUSD", false], CAD: ["USDCAD", true], CHF: ["USDCHF", true] };
const DEV_FROM = "2015-02-02", DEV_TO = "2021-12-08", SPLIT = "2018-07-01";
const HOUR = 10; // the server hour of the daily ranking
const LOOK_DAYS = [1, 5, 21, 63, 252], HOLD_DAYS = [1, 5, 21];
const LOOK_HOURS = [4, 8, 24], HOLD_HOURS = [4, 8];
const STARTS = { 4: [2, 6, 10, 14, 18], 8: [2, 10] }; // server hours at which a hold of H hours begins
const SIDES = [1, 2]; // how many currencies are bought and how many sold
const SHUFFLES = 500;
const FROM = windowMode ? "2015-01-05" : DEV_FROM, TO = windowMode ? "2015-02-01" : DEV_TO;

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const dayNumber = (date) => Date.parse(`${date}T00:00:00Z`) / 86400e3;
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
/** Nights a position is charged for between two dates: one for every evening from Monday to Friday, three for Wednesday's. */
function nightsBetween(a, b) {
  let n = 0;
  for (let d = dayNumber(a); d < dayNumber(b); d++) { const wd = (d + 4) % 7; if (wd >= 1 && wd <= 5) n += wd === 3 ? 3 : 1; }
  return n;
}
/** A small seeded generator, so that the random control is the same on every run. */
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ------------------------------------------------------------------ data: the eight currencies hour by hour
function loadPair(pair) {
  const own = config.symbols[pair], point = 10 ** -own.digits, pip = point * 10;
  const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints, commission = own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip, base = own.usdSide === "base";
  const lines = readFileSync(`${config.dataDir}/${pair}_H1.csv`, "utf8").split(/\r?\n/), rows = new Map();
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break;
    const o = +p[2];
    rows.set(`${date} ${p[1].slice(0, 2)}`, {
      o, c: +p[5],
      // What one unit of the pair bought or sold costs, as a share of the price: half a spread, slippage, half the commission.
      oneWay: (Math.max(+p[8], floor) * point) / o / 2 + (config.costs.slippagePips * pip) / o + (base ? commission / own.contractSize : commission / (own.contractSize * o)) / 2,
      swapLong: (own.swapLongPips * pip) / o, swapShort: (own.swapShortPips * pip) / o, // a night, as a share of the price; minus = paid
    });
  }
  return rows;
}
const pairs = new Map(Object.entries(PAIR).map(([cur, [pair]]) => [cur, loadPair(pair)]));
const keys = [...pairs.get("EUR").keys()].filter((k) => CUR.slice(1).every((c) => pairs.get(c).has(k)));
const T = keys.length, indexOf = new Map(keys.map((k, i) => [k, i]));
const dates = keys.map((k) => k.slice(0, 10)), hours = keys.map((k) => +k.slice(11, 13));
// Values in dollars as logs (the dollar itself is 0), at the open and at the close of every hour; costs per currency.
const xo = [], xc = [], oneWay = [], swapPlus = [], swapMinus = [];
for (let t = 0; t < T; t++) {
  const o = new Float64Array(N), c = new Float64Array(N), w = new Float64Array(N), sp = new Float64Array(N), sm = new Float64Array(N);
  for (let i = 1; i < N; i++) {
    const r = pairs.get(CUR[i]).get(keys[t]), inv = PAIR[CUR[i]][1];
    o[i] = inv ? -Math.log(r.o) : Math.log(r.o); c[i] = inv ? -Math.log(r.c) : Math.log(r.c); w[i] = r.oneWay;
    // Holding the currency against the dollar is a long of EURUSD but a short of USDJPY.
    sp[i] = inv ? r.swapShort : r.swapLong; sm[i] = inv ? r.swapLong : r.swapShort;
  }
  xo.push(o); xc.push(c); oneWay.push(w); swapPlus.push(sp); swapMinus.push(sm);
}

// ------------------------------------------------------------------ portfolios
/** +1/n on the n strongest and -1/n on the n weakest of the eight by `score`. */
function sidesOf(score, n) {
  const order = [...score.keys()].sort((a, b) => score[b] - score[a]), w = new Float64Array(N);
  for (let k = 0; k < n; k++) { w[order[k]] += 1 / n; w[order[N - 1 - k]] -= 1 / n; }
  return w;
}
const turnoverCost = (t, w, prev) => { let c = 0; for (let i = 1; i < N; i++) c += Math.abs(w[i] - prev[i]) * oneWay[t][i]; return c; };
const swapOf = (t, w, nights) => { let s = 0; for (let i = 1; i < N; i++) s += (w[i] > 0 ? w[i] * swapPlus[t][i] : -w[i] * swapMinus[t][i]) * nights; return s; };
const moveOf = (a, b, w) => { let g = 0; for (let i = 1; i < N; i++) g += w[i] * (xo[b][i] - xo[a][i]); return g; };
const trades = (w, prev) => { let n = 0; for (let i = 1; i < N; i++) if (Math.abs(w[i] - prev[i]) > 1e-12) n++; return n; };

// A. The days: the bar of 10:00 with the bar of 09:00 before it on the same date.
const D = [];
for (let t = 1; t < T; t++) if (hours[t] === HOUR && hours[t - 1] === HOUR - 1 && dates[t - 1] === dates[t]) D.push(t);
/** Daily records of the portfolio of one cell; `pick(k)` gives the part opened on day k. */
function runDays(H, pick, first) {
  const out = [], parts = [];
  let W = new Float64Array(N);
  for (let k = first; k + 1 < D.length; k++) {
    const part = pick(k), prev = W;
    parts.push(part);
    W = new Float64Array(N);
    for (let j = Math.max(0, parts.length - H); j < parts.length; j++) for (let i = 0; i < N; i++) W[i] += parts[j][i] / H;
    const t = D[k], nights = nightsBetween(dates[t], dates[D[k + 1]]), minus = W.map((x) => -x);
    out.push({ date: dates[t], gross: moveOf(t, D[k + 1], W), cost: turnoverCost(t, W, prev), swap: swapOf(t, W, nights), swapRev: swapOf(t, minus, nights), n: trades(W, prev), W });
  }
  return out.filter((r) => r.date >= FROM);
}
const strengthDays = (k, L) => { const s = new Float64Array(N); for (let i = 0; i < N; i++) s[i] = xc[D[k] - 1][i] - xc[D[k - L] - 1][i]; return s; };

// B. Inside the day: holds of H hours one after another.
function runHours(L, H, pick) {
  const out = [];
  let prev = new Float64Array(N), prevExit = -1, last = null;
  for (let t = L + 1; t < T; t++) {
    if (!STARTS[H].includes(hours[t]) || dates[t] < FROM) continue;
    const x = indexOf.get(`${dates[t]} ${String(hours[t] + H).padStart(2, "0")}`);
    if (x === undefined) continue;
    const w = pick(t), zero = new Float64Array(N);
    // What is left of the last hold is closed at its own exit unless this hold begins there.
    if (last !== null && prevExit !== t) { last.cost += turnoverCost(prevExit, zero, prev); last.n += trades(zero, prev); prev = zero; }
    const rec = { date: dates[t], hour: hours[t], gross: moveOf(t, x, w), cost: turnoverCost(t, w, prev), swap: 0, swapRev: 0, n: trades(w, prev), W: w };
    out.push(rec); last = rec; prev = w; prevExit = x;
  }
  if (last !== null) { const zero = new Float64Array(N); last.cost += turnoverCost(prevExit, zero, prev); last.n += trades(zero, prev); }
  return out;
}
const strengthHours = (t, L) => { const s = new Float64Array(N); for (let i = 0; i < N; i++) s[i] = xc[t - 1][i] - xc[t - 1 - L][i]; return s; };

// ------------------------------------------------------------------ counting
/** Records of one cell folded into days, then: per day in basis points, a year in percent of the money in the trade, t by weeks. */
function fold(recs, value) {
  const byDay = new Map();
  for (const r of recs) byDay.set(r.date, (byDay.get(r.date) ?? 0) + value(r));
  const days = [...byDay.entries()], byWeek = new Map();
  for (const [date, v] of days) { const wk = Math.floor((dayNumber(date) + 3) / 7); byWeek.set(wk, (byWeek.get(wk) ?? 0) + v); }
  const w = [...byWeek.values()], mw = mean(w), sd = Math.sqrt(mean(w.map((x) => (x - mw) ** 2)) * (w.length / Math.max(1, w.length - 1)));
  const perDay = mean(days.map((d) => d[1]));
  return { days: days.length, bp: perDay * 1e4, year: perDay * 252 * 100, t: mw / (sd / Math.sqrt(w.length)) };
}
const yearsAbove = (recs, value) => { const by = new Map(); for (const r of recs) by.set(r.date.slice(0, 4), (by.get(r.date.slice(0, 4)) ?? 0) + value(r)); return `${[...by.values()].filter((v) => v > 0).length}/${by.size}`; };
const months = (dayNumber(DEV_TO) - dayNumber(DEV_FROM)) / 30.44;
const HEAD = `${pad("", 30)} ${lpad("days", 5)} ${lpad("tr/mo", 6)} | ${lpad("gross", 6)} ${lpad("a year", 7)} ${lpad("t", 5)} ${lpad("ctl", 4)} ${lpad("years", 5)} | ${lpad("cost", 6)} ${lpad("swaps", 6)} | ${lpad("net", 6)} ${lpad("a year", 7)} ${lpad("t", 5)} | ${lpad("no swaps", 8)} ${lpad("t", 5)} | ${lpad("halves, net", 15)} | ${lpad("reversed", 8)} ${lpad("no swaps", 8)}`;
let cells = 0;
const table = [];
function line(label, recs, shuffled) {
  const g = fold(recs, (r) => r.gross), c = fold(recs, (r) => r.cost), s = fold(recs, (r) => r.swap);
  const net = fold(recs, (r) => r.gross - r.cost + r.swap), flat = fold(recs, (r) => r.gross - r.cost);
  const a = fold(recs.filter((r) => r.date < SPLIT), (r) => r.gross - r.cost + r.swap), b = fold(recs.filter((r) => r.date >= SPLIT), (r) => r.gross - r.cost + r.swap);
  const rev = fold(recs, (r) => -r.gross - r.cost + r.swapRev), revFlat = fold(recs, (r) => -r.gross - r.cost);
  const actual = mean(recs.map((r) => r.gross)), beaten = shuffled.filter((x) => x < actual).length / shuffled.length;
  const perMonth = recs.reduce((n, r) => n + r.n, 0) / months;
  cells++;
  table.push({ label, grossT: g.t, netT: net.t, flatT: flat.t, revT: rev.t, revFlatT: revFlat.t, net: net.bp, flat: flat.bp, rev: rev.bp, revFlat: revFlat.bp });
  console.log(`${pad(label, 30)} ${lpad(g.days, 5)} ${lpad(perMonth.toFixed(0), 6)} | ${lpad(f(g.bp), 6)} ${lpad(f(g.year, 1) + "%", 7)} ${lpad(f(g.t, 1), 5)} ${lpad((beaten * 100).toFixed(0) + "%", 4)} ${lpad(yearsAbove(recs, (r) => r.gross), 5)} | ${lpad(f(-c.bp), 6)} ${lpad(f(s.bp), 6)} | ${lpad(f(net.bp), 6)} ${lpad(f(net.year, 1) + "%", 7)} ${lpad(f(net.t, 1), 5)} | ${lpad(f(flat.bp), 8)} ${lpad(f(flat.t, 1), 5)} | ${lpad(f(a.bp), 7)} ${lpad(f(b.bp), 7)} | ${lpad(f(rev.bp), 8)} ${lpad(f(revFlat.bp), 8)}`);
}

// ------------------------------------------------------------------ run
if (windowMode) {
  // Every number of a few days before dev begins: the ranking, the two sides, the move of the next day, the costs.
  console.log(`The mechanics on ${FROM} .. ${TO} (before dev begins). Strength over 1 day, hold 1 day, the strongest against the weakest.`);
  const recs = runDays(1, (k) => sidesOf(strengthDays(k, 1), 1), 1);
  recs.slice(0, 8).forEach((r) => {
    const k = D.findIndex((t) => dates[t] === r.date), s = strengthDays(k, 1);
    const next = CUR.map((c, i) => `${c} ${f((xo[D[k + 1]][i] - xo[D[k]][i]) * 1e4, 1)}`).join(" ");
    console.log(`${r.date}: strength, bp: ${CUR.map((c, i) => `${c} ${f(s[i] * 1e4, 1)}`).join(" ")}`);
    console.log(`   bought ${CUR[r.W.findIndex((x) => x > 0)]}, sold ${CUR[r.W.findIndex((x) => x < 0)]}; to the next day, bp: ${next}`);
    console.log(`   gross ${f(r.gross * 1e4, 1)} bp, cost ${f(r.cost * 1e4, 2)} bp for ${r.n} orders, swaps ${f(r.swap * 1e4, 2)} bp for ${nightsBetween(r.date, dates[D[k + 1]])} night(s)`);
  });
  console.log("\nInside the day: strength over 4 hours, hold 4 hours.");
  runHours(4, 4, (t) => sidesOf(strengthHours(t, 4), 1)).slice(0, 6).forEach((r) => console.log(`${r.date} ${String(r.hour).padStart(2, "0")}:00 bought ${CUR[r.W.findIndex((x) => x > 0)]}, sold ${CUR[r.W.findIndex((x) => x < 0)]}; gross ${f(r.gross * 1e4, 1)} bp, cost ${f(r.cost * 1e4, 2)} bp for ${r.n} orders`));
} else {
  const random = mulberry(20261123);
  const randomSides = (n) => { const score = new Float64Array(N); for (let i = 0; i < N; i++) score[i] = random(); return sidesOf(score, n); };
  console.log(`Currency strength, dev ${DEV_FROM} .. ${DEV_TO}. gross, cost, swaps, net: basis points of the money in the trade per day; "a year": percent a year with no leverage; t by weeks.`);
  console.log(`tr/mo: orders in the dollar pairs a month. ctl: the share of ${SHUFFLES} random rankings that the real one beats before costs (50% = no edge). years: years above zero before costs.`);
  console.log(`"no swaps": the net on an account without swaps. "reversed": the weakest bought against the strongest, after costs, with swaps and without.`);
  for (const n of SIDES) {
    console.log(`\n=== A. Days: the ${n === 1 ? "strongest against the weakest" : "two strongest against the two weakest"} ===`);
    console.log(HEAD);
    for (const L of LOOK_DAYS) for (const H of HOLD_DAYS) {
      const recs = runDays(H, (k) => sidesOf(strengthDays(k, L), n), L);
      const shuffled = [];
      for (let s = 0; s < SHUFFLES; s++) shuffled.push(mean(runDays(H, () => randomSides(n), L).map((r) => r.gross)));
      line(`strength ${L} d, hold ${H} d`, recs, shuffled);
    }
  }
  for (const n of SIDES) {
    console.log(`\n=== B. Inside the day: the ${n === 1 ? "strongest against the weakest" : "two strongest against the two weakest"} ===`);
    console.log(HEAD);
    for (const L of LOOK_HOURS) for (const H of HOLD_HOURS) {
      const recs = runHours(L, H, (t) => sidesOf(strengthHours(t, L), n));
      const shuffled = [];
      for (let s = 0; s < 100; s++) shuffled.push(mean(runHours(L, H, () => randomSides(n)).map((r) => r.gross)));
      line(`strength ${L} h, hold ${H} h`, recs, shuffled);
    }
  }
  const strong = (key) => table.filter((c) => Math.abs(c[key]) >= 2);
  console.log(`\nCells counted: ${cells}. Before costs |t| >= 2: ${strong("grossT").length} (${strong("grossT").filter((c) => c.grossT > 0).length} above zero), expected by chance about ${(cells * 0.05).toFixed(0)}.`);
  console.log(`After costs above zero: with swaps ${table.filter((c) => c.net > 0).length}, without swaps ${table.filter((c) => c.flat > 0).length}; reversed: with swaps ${table.filter((c) => c.rev > 0).length}, without swaps ${table.filter((c) => c.revFlat > 0).length}.`);
  console.log(`After costs t >= 2: with swaps ${table.filter((c) => c.netT >= 2).length}, without swaps ${table.filter((c) => c.flatT >= 2).length}; reversed: with swaps ${table.filter((c) => c.revT >= 2).length}, without swaps ${table.filter((c) => c.revFlatT >= 2).length}.`);
}
