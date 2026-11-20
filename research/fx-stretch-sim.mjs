// Trades against a stretched move of several days on the seven dollar pairs
// (TZ 17.24): after k days that carried the pair further than z sigmas, trade
// back for h days. Same costs and fills as fx-shock-sim.mjs; the swaps can be
// switched off to see a swap-free account.
//
// Usage: node research/fx-stretch-sim.mjs study                 grids, dev only
//        node research/fx-stretch-sim.mjs run dev|test [file.json]
//        node research/fx-stretch-sim.mjs run holdout --i-understand-holdout [file.json]
import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const args = process.argv.slice(2);
const [mode = "study", datasetArg = "dev"] = args;
if (mode === "study" && datasetArg !== "dev") throw new Error("grids run on dev only");
if (datasetArg === "holdout" && !args.includes("--i-understand-holdout")) throw new Error("the holdout needs --i-understand-holdout");
const SPANS = {
  dev: ["2015-02-02", "2021-12-08"],
  test: [config.datasets.testStart, "2024-11-15"],
  holdout: [config.datasets.holdoutStart, "2026-10-29"],
};
const span = SPANS[datasetArg];
if (span === undefined) throw new Error(`unknown dataset ${datasetArg}`);
const [FROM, TO] = span;

/** The middle cell of the study (TZ 17.24) and its control; the study found no edge, so nothing was frozen or taken to test. */
const FROZEN = { days: 10, zMin: 1.5, zMax: Infinity, hold: 5, entryHour: 2, exitHour: 23, stopAtr: 3 };
const CONTROL = { ...FROZEN, zMin: 0.25, zMax: 1 };

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function stat(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return { n: xs.length, m, sd, t: m / (sd / Math.sqrt(Math.max(1, xs.length))) };
}
const f = (x, d = 3) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
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
    swapLong: own.swapLongPips * point * 10, swapShort: own.swapShortPips * point * 10,
  };
}
function load(symbol, tf) {
  const lines = readFileSync(`${config.dataDir}/${symbol}_${tf}.csv`, "utf8").split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 8) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after the end of the chosen set is read
    if (tf === "D1") rows.push({ date, o: +p[1], h: +p[2], l: +p[3], c: +p[4], spread: +p[7] });
    else rows.push({ date, hour: +p[1].slice(0, 2), o: +p[2], h: +p[3], l: +p[4], c: +p[5], spread: +p[8] });
  }
  return rows;
}
const market = new Map();
for (const symbol of PAIRS) {
  const daily = load(symbol, "D1");
  const h1 = load(symbol, "H1");
  const firstOfDate = new Map();
  h1.forEach((b, i) => { if (!firstOfDate.has(b.date)) firstOfDate.set(b.date, i); });
  market.set(symbol, { s: spec(symbol), daily, h1, firstOfDate });
}

/**
 * Trades of one pair. Signal on the close of day D: z = ln(C_D / C_{D-days}) / (sigma * sqrt(days)),
 * sigma = root mean square of the twenty daily moves ending with D. With zMin <= |z| < zMax the trade
 * goes AGAINST the move: in at the open of the `entryHour` bar of the next trading day, out at the
 * open of the `exitHour` bar `hold` trading days after D, or at the stop `stopAtr` mean true ranges
 * (twenty days ending with D) from the entry. One position per pair.
 * costs: "all" | "no swaps" | "none".
 */
function simulate(symbol, v, costs = "all") {
  const { s, daily, h1, firstOfDate } = market.get(symbol);
  const ret = daily.map((b, i) => (i === 0 ? 0 : Math.log(b.c / daily[i - 1].c)));
  const tr = daily.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - daily[i - 1].c), Math.abs(b.l - daily[i - 1].c))));
  const paid = costs !== "none";
  const trades = [];
  let busyUntil = "";
  for (let i = Math.max(v.days, 20) + 1; i + v.hold < daily.length; i++) {
    const day = daily[i];
    if (day.date < FROM) continue;
    const sigma = Math.sqrt(mean(ret.slice(i - 19, i + 1).map((x) => x * x)));
    const z = Math.log(day.c / daily[i - v.days].c) / (sigma * Math.sqrt(v.days));
    if (!(Math.abs(z) >= v.zMin && Math.abs(z) < v.zMax)) continue;
    const entryDate = daily[i + 1].date, exitDate = daily[i + v.hold].date;
    if (entryDate <= busyUntil) continue;
    const start = firstOfDate.get(entryDate);
    if (start === undefined) continue;
    let k = start;
    while (k < h1.length && h1[k].date === entryDate && h1[k].hour < v.entryHour) k++;
    if (k >= h1.length || h1[k].date !== entryDate || h1[k].hour > v.entryHour + 2) continue;
    const dir = -Math.sign(z);
    const atr = mean(tr.slice(i - 19, i + 1));
    const bar = h1[k];
    const spreadOf = (b) => (paid ? Math.max(b.spread, s.minSpread) * s.point : 0);
    const slip = paid ? s.slip : 0;
    const entry = dir > 0 ? bar.o + spreadOf(bar) + slip : bar.o - slip;
    const stop = v.stopAtr === null ? null : entry - dir * v.stopAtr * atr;
    let exit = NaN, reason = "", exitAt = "";
    for (let j = k; j < h1.length; j++) {
      const b = h1[j];
      if (b.date > exitDate || (b.date === exitDate && b.hour >= v.exitHour)) { exit = dir > 0 ? b.o - slip : b.o + spreadOf(b) + slip; reason = "time"; exitAt = `${b.date} ${b.hour}`; break; }
      if (stop !== null) {
        if (dir > 0 && b.l <= stop) { exit = Math.min(stop, b.o) - slip; reason = "stop"; exitAt = `${b.date} ${b.hour}`; break; }
        if (dir < 0 && b.h + spreadOf(b) >= stop) { exit = Math.max(stop, b.o + spreadOf(b)) + slip; reason = "stop"; exitAt = `${b.date} ${b.hour}`; break; }
      }
      if (b.date === exitDate && (j + 1 >= h1.length || h1[j + 1].date !== exitDate)) { exit = dir > 0 ? b.c - slip : b.c + spreadOf(b) + slip; reason = "time"; exitAt = `${b.date} ${b.hour} close`; break; }
    }
    if (!Number.isFinite(exit)) continue;
    const outDate = exitAt.slice(0, 10);
    let swap = 0;
    if (costs === "all") for (let d = i + 1; daily[d] !== undefined && daily[d].date < outDate; d++) swap += (dir > 0 ? s.swapLong : s.swapShort) * (weekday(daily[d].date) === 3 ? 3 : 1);
    const commission = !paid ? 0 : s.base ? (s.commission / s.contract) * entry : s.commission / s.contract;
    const move = dir * (exit - entry) + swap - commission;
    const unit = (v.stopAtr ?? 3) * atr;
    busyUntil = outDate;
    trades.push({ symbol, signal: day.date, entryDate, exitAt, dir, z, entry, exit, reason, r: move / unit, bp: (move / entry) * 1e4, year: entryDate.slice(0, 4) });
  }
  return trades;
}
const run = (v, costs = "all") => PAIRS.flatMap((p) => simulate(p, v, costs));

function summary(trades) {
  const byDay = new Map();
  for (const t of trades) byDay.set(t.entryDate, (byDay.get(t.entryDate) ?? 0) + t.r);
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let eq = 0, peak = 0, dd = 0;
  for (const [, r] of days) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  // Trades of one week move together (one dollar move): the t-value counts weeks, not trades.
  const byWeek = new Map();
  for (const t of trades) { const wk = Math.floor((Date.parse(`${t.entryDate}T00:00:00Z`) / 86400e3 + 3) / 7); byWeek.set(wk, (byWeek.get(wk) ?? 0) + t.r); }
  const wins = trades.filter((t) => t.r > 0), losses = trades.filter((t) => t.r <= 0);
  const months = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.44);
  return {
    n: trades.length, perMonth: trades.length / months, meanR: mean(trades.map((t) => t.r)), tWeeks: stat([...byWeek.values()]).t, sumR: eq, dd,
    pf: wins.reduce((a, t) => a + t.r, 0) / Math.max(1e-9, -losses.reduce((a, t) => a + t.r, 0)),
    winShare: wins.length / Math.max(1, trades.length), stops: trades.filter((t) => t.reason === "stop").length,
    pairsPlus: PAIRS.filter((p) => mean(trades.filter((t) => t.symbol === p).map((t) => t.r)) > 0).length, bp: mean(trades.map((t) => t.bp)),
  };
}
const line = (label, s) => `${pad(label, 36)} n ${lpad(s.n, 4)} (${lpad(s.perMonth.toFixed(1), 4)}/mo)  R ${f(s.meanR)}  t(weeks) ${f(s.tWeeks, 1)}  PF ${s.pf.toFixed(2)}  wins ${(s.winShare * 100).toFixed(0)}%  stops ${lpad(s.stops, 3)}  sum ${f(s.sumR, 1)}R  dd ${s.dd.toFixed(1)}R  pairs+ ${s.pairsPlus}/7  bp ${f(s.bp, 1)}`;

if (mode === "study") {
  console.log(`dev ${FROM} .. ${TO}; trades AGAINST the stretch; R = the stop distance (3 ATR where there is no stop)`);
  for (const costs of ["all", "no swaps"]) {
    console.log(`\n== costs: ${costs} ==`);
    for (const days of [5, 10, 15, 20]) for (const zMin of [1.5, 2]) for (const hold of [3, 5, 10]) {
      console.log(line(`${days} days, z>=${zMin}, hold ${hold}, stop 3`, summary(run({ ...FROZEN, days, zMin, hold }, costs))));
    }
  }
  console.log("\n== the middle cell (10 days, z>=1.5, hold 5): stops, years, pairs ==");
  for (const stopAtr of [2, 3, 4, null]) for (const costs of ["all", "no swaps"]) console.log(line(`stop ${stopAtr ?? "none"}, ${costs}`, summary(run({ ...FROZEN, stopAtr }, costs))));
  console.log(line("before any costs", summary(run(FROZEN, "none"))));
  console.log(line("control: stretch of 0.25-1 sigma", summary(run(CONTROL))));
  for (const costs of ["all", "no swaps"]) {
    const mid = run(FROZEN, costs);
    console.log(`-- by year, costs: ${costs}`);
    for (const year of [...new Set(mid.map((t) => t.year))].sort()) console.log(line(year, summary(mid.filter((t) => t.year === year))));
  }
  const mid = run(FROZEN);
  for (const p of PAIRS) console.log(line(p, summary(mid.filter((t) => t.symbol === p))));
  console.log(line("buys", summary(mid.filter((t) => t.dir > 0))));
  console.log(line("sells", summary(mid.filter((t) => t.dir < 0))));
} else if (mode === "run") {
  console.log(`${datasetArg} ${FROM} .. ${TO}`);
  const own = run(FROZEN), free = run(FROZEN, "no swaps"), control = run(CONTROL);
  console.log(line("StretchFadeUSD", summary(own)));
  console.log(line("  on a swap-free account", summary(free)));
  console.log(line("  before any costs", summary(run(FROZEN, "none"))));
  console.log(line("control (0.25-1 sigma)", summary(control)));
  console.log(line("  control, swap-free", summary(run(CONTROL, "no swaps"))));
  for (const year of [...new Set(own.map((t) => t.year))].sort()) console.log(line(year, summary(own.filter((t) => t.year === year))));
  for (const p of PAIRS) console.log(line(p, summary(own.filter((t) => t.symbol === p))));
  console.log(line("buys", summary(own.filter((t) => t.dir > 0))));
  console.log(line("sells", summary(own.filter((t) => t.dir < 0))));
  const file = args.find((a) => a.endsWith(".json"));
  if (file !== undefined) writeFileSync(file, JSON.stringify({ dataset: datasetArg, rule: FROZEN, trades: own, swapFree: free, control }, null, 1));
} else {
  throw new Error("usage: node research/fx-stretch-sim.mjs study | run dev|test|holdout");
}
