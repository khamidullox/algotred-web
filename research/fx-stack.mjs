// All the small effects of the scans put together (TZ 17.23). Dev only.
// Three fixed slots a day on each dollar pair: 02:00-09:00, 09:00-15:00 and
// 15:00-23:00 server time (Asia, London morning, New York; no night is held).
// A linear forecast of the move of the slot from what is known at its start;
// the forecast for a year is fitted on the years before it only (walk
// forward), so every trade below is made with numbers that existed then.
// A trade is taken when the forecast is larger than k times the costs.
//
// Usage: node research/fx-stack.mjs
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const FROM = "2015-02-02", TO = "2021-12-08";
const SLOTS = [["asia", 2, 9], ["london", 9, 15], ["newyork", 15, 23]];
const RIDGE = 5;

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function stat(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return { n: xs.length, m, sd, t: m / (sd / Math.sqrt(Math.max(1, xs.length))) };
}
function byDate(rows, value) {
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.date)) groups.set(r.date, []); groups.get(r.date).push(value(r)); }
  const st = stat([...groups.values()].map((g) => g.reduce((a, b) => a + b, 0)));
  return { n: rows.length, dates: groups.size, m: mean(rows.map(value)), t: st.t };
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function spec(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits;
  return {
    symbol, point, pip: point * 10, base: own.usdSide === "base", contract: own.contractSize,
    minSpread: own.minSpreadPoints ?? config.costs.minSpreadPoints,
    slip: config.costs.slippagePips * point * 10,
    commission: own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip,
  };
}
function costOf(s, bar) {
  const commission = s.base ? (s.commission / s.contract) * bar.o : s.commission / s.contract;
  return Math.max(bar.spread, s.minSpread) * s.point + 2 * s.slip + commission;
}
function load(symbol, tf) {
  const lines = readFileSync(`${config.dataDir}/${symbol}_${tf}.csv`, "utf8").split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 8) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break;
    if (tf === "D1") rows.push({ date, o: +p[1], h: +p[2], l: +p[3], c: +p[4], spread: +p[7] });
    else rows.push({ date, hour: +p[1].slice(0, 2), o: +p[2], h: +p[3], l: +p[4], c: +p[5], spread: +p[8] });
  }
  return rows;
}

// --- the S&P 500 day session, standardised by the sixty sessions before it
const spxByDate = new Map();
{
  const m = new Map();
  for (const b of load("US500", "H1")) { if (!m.has(b.date)) m.set(b.date, new Map()); m.get(b.date).set(b.hour, b); }
  const list = [];
  for (const [date, hours] of m) if (date >= "2016-03-01" && hours.has(16) && hours.has(22)) list.push({ date, ret: Math.log(hours.get(22).c / hours.get(16).o) });
  for (let i = 60; i < list.length; i++) {
    const sd = Math.sqrt(mean(list.slice(i - 60, i).map((x) => x.ret ** 2)));
    spxByDate.set(list[i].date, list[i].ret / sd);
  }
}

// --- samples
const perPair = new Map();
for (const symbol of PAIRS) {
  const s = spec(symbol);
  const daily = load(symbol, "D1");
  const tr = daily.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - daily[i - 1].c), Math.abs(b.l - daily[i - 1].c))));
  const atr = new Map();
  for (let i = 20; i < daily.length; i++) atr.set(daily[i].date, mean(tr.slice(i - 20, i)));
  const hours = new Map();
  for (const b of load(symbol, "H1")) { if (!hours.has(b.date)) hours.set(b.date, new Map()); hours.get(b.date).set(b.hour, b); }
  const dates = [...hours.keys()].sort();
  const days = new Map();
  for (let i = 6; i < dates.length; i++) {
    const date = dates[i];
    const today = hours.get(date), prev = hours.get(dates[i - 1]), prev2 = hours.get(dates[i - 2]), back5 = hours.get(dates[i - 5]);
    const a = atr.get(date);
    if (a === undefined || date < FROM) continue;
    const o = (m, h) => m?.get(h)?.o;
    if ([o(today, 0), o(today, 2), o(today, 9), o(today, 15), o(today, 23), o(prev, 0), o(prev, 15), o(prev, 23), o(prev2, 0), o(back5, 0)].some((x) => x === undefined)) continue;
    const usd = s.base ? 1 : -1; // +1 when a rise of the pair is a rise of the dollar
    days.set(date, {
      date, a, usd,
      prevDay: (o(today, 0) - o(prev, 0)) / a,
      prevNy: (o(prev, 23) - o(prev, 15)) / a,
      five: (o(today, 0) - o(back5, 0)) / a / Math.sqrt(5),
      p0: o(today, 0), p2: o(today, 2), p9: o(today, 9), p15: o(today, 15), p23: o(today, 23),
      cost: Object.fromEntries(SLOTS.map(([name, from]) => [name, (costOf(s, today.get(from)) / a) * 100])),
      spx: spxByDate.get(dates[i - 1]) ?? 0,
    });
  }
  perPair.set(symbol, days);
}
// The move of the dollar as a whole on the day before: the mean over the pairs, in the dollar direction.
const dollarPrev = new Map();
{
  const allDates = new Set([...perPair.values()].flatMap((d) => [...d.keys()]));
  for (const date of allDates) {
    const xs = PAIRS.map((p) => perPair.get(p).get(date)).filter((d) => d !== undefined).map((d) => d.usd * d.prevDay);
    dollarPrev.set(date, mean(xs));
  }
}

function features(d, slot) {
  const shock = Math.sign(d.prevDay) * Math.max(Math.abs(d.prevDay) - 1, 0);
  const sinceOpen = slot === "asia" ? (d.p2 - d.p0) / d.a : slot === "london" ? (d.p9 - d.p0) / d.a : (d.p15 - d.p0) / d.a;
  const before = slot === "asia" ? d.prevNy : slot === "london" ? (d.p9 - d.p2) / d.a : (d.p15 - d.p9) / d.a;
  return [1, d.prevDay, sinceOpen, before, d.five, shock, d.usd * dollarPrev.get(d.date), d.spx];
}
const target = (d, slot) => (slot === "asia" ? (d.p9 - d.p2) / d.a : slot === "london" ? (d.p15 - d.p9) / d.a : (d.p23 - d.p15) / d.a) * 100;
const NAMES = ["mean of the slot", "day before", "since 00:00", "slot before", "five days", "big day before", "dollar the day before", "S&P session before"];

/** Ridge regression by the normal equations; the intercept is not shrunk. */
function fit(X, y) {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  for (let r = 0; r < X.length; r++) for (let i = 0; i < k; i++) { A[i][k] += X[r][i] * y[r]; for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j]; }
  for (let i = 1; i < k; i++) A[i][i] += RIDGE;
  for (let i = 0; i < k; i++) {
    let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    for (let r = 0; r < k; r++) if (r !== i) { const m = A[r][i] / A[i][i]; for (let c = i; c <= k; c++) A[r][c] -= m * A[i][c]; }
  }
  return A.map((row, i) => row[k] / row[i]);
}

const trades = [];
const lastFit = new Map();
for (const symbol of PAIRS) for (const [slot] of SLOTS) {
  const rows = [...perPair.get(symbol).values()].map((d) => ({ d, x: features(d, slot), y: target(d, slot) }));
  for (const year of ["2017", "2018", "2019", "2020", "2021"]) {
    const train = rows.filter((r) => r.d.date < `${year}-01-01`);
    const beta = fit(train.map((r) => r.x), train.map((r) => r.y));
    lastFit.set(`${symbol}|${slot}`, beta);
    for (const r of rows.filter((q) => q.d.date.startsWith(year))) {
      const pred = r.x.reduce((a, v, i) => a + v * beta[i], 0);
      trades.push({ symbol, slot, date: r.d.date, year, pred, y: r.y, cost: r.d.cost[slot] });
    }
  }
}

console.log(`Slots forecast out of sample (2017-2021 of dev): ${trades.length}. Units: % of the daily ATR. Costs of a round trip: ${mean(trades.map((x) => x.cost)).toFixed(2)} on average.`);
{
  // Does the forecast say anything at all? Mean realised move in the forecast direction by size of the forecast.
  const sorted = trades.slice().sort((a, b) => Math.abs(a.pred) - Math.abs(b.pred));
  const parts = 10;
  console.log("\n== Realised move in the direction of the forecast, by tenths of the forecast size (before costs) ==");
  for (let p = 0; p < parts; p++) {
    const g = sorted.slice(Math.floor((p * sorted.length) / parts), Math.floor(((p + 1) * sorted.length) / parts));
    const r = byDate(g, (x) => Math.sign(x.pred) * x.y);
    console.log(`   tenth ${lpad(p + 1, 2)}: forecast ${f(mean(g.map((x) => Math.abs(x.pred))))}  realised ${f(r.m)} (t ${f(r.t, 1)})  cost ${mean(g.map((x) => x.cost)).toFixed(2)}`);
  }
}
console.log("\n== Trades: forecast larger than k times the costs; result after costs ==");
for (const k of [0.5, 1, 1.5, 2]) {
  const g = trades.filter((x) => Math.abs(x.pred) > k * x.cost);
  const net = (x) => Math.sign(x.pred) * x.y - x.cost;
  const r = byDate(g, net);
  const gross = mean(g.map((x) => Math.sign(x.pred) * x.y));
  const years = ["2017", "2018", "2019", "2020", "2021"].map((yy) => `${yy} ${f(mean(g.filter((x) => x.year === yy).map(net)))} (${g.filter((x) => x.year === yy).length})`).join("  ");
  const slots = SLOTS.map(([s]) => `${s} ${f(mean(g.filter((x) => x.slot === s).map(net)))} (${g.filter((x) => x.slot === s).length})`).join("  ");
  const pairs = PAIRS.map((p) => `${p} ${f(mean(g.filter((x) => x.symbol === p).map(net)))} (${g.filter((x) => x.symbol === p).length})`).join("  ");
  console.log(`   k ${k}: trades ${g.length} (${(g.length / 59).toFixed(1)} a month)  before costs ${f(gross)}  after ${f(r.m)} (t ${f(r.t, 1)})`);
  console.log(`        by year: ${years}`);
  console.log(`        by slot: ${slots}`);
  console.log(`        by pair: ${pairs}`);
}
console.log("\n== The last fit (data to the end of 2020): what each thing adds to the forecast, % of ATR per unit ==");
console.log(`   ${pad("pair slot", 18)} ${NAMES.map((n) => lpad(n.slice(0, 14), 15)).join("")}`);
for (const [key, beta] of lastFit) console.log(`   ${pad(key.replace("|", " "), 18)} ${beta.map((b) => lpad(f(b), 15)).join("")}`);
