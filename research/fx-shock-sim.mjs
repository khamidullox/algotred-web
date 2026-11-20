// Trades of the "follow a big day" idea on the seven dollar pairs (TZ 17.23)
// with the costs of the project: the Ask is the Bid plus the spread of the bar
// (not below the floor of the config), slippage on every fill, the commission
// and the swap of the config. A simulator of its own, as fix-sim.mjs: the
// frozen rule is a few lines and has to be run on three sets the same way.
//
// Usage: node research/fx-shock-sim.mjs study                 grids, dev only
//        node research/fx-shock-sim.mjs run dev|test          the frozen rule and its control
//        node research/fx-shock-sim.mjs run holdout --i-understand-holdout
import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const [mode = "study", datasetArg = "dev", flag] = process.argv.slice(2);
if (mode === "study" && datasetArg !== "dev") throw new Error("grids run on dev only");
if (datasetArg === "holdout" && flag !== "--i-understand-holdout") throw new Error("the holdout needs --i-understand-holdout");
const SPANS = {
  dev: ["2015-02-02", "2021-12-08"],
  test: [config.datasets.testStart, "2024-11-15"],
  holdout: [config.datasets.holdoutStart, "2026-10-29"],
};
const span = SPANS[datasetArg];
if (span === undefined) throw new Error(`unknown dataset ${datasetArg}`);
const [FROM, TO] = span;

/** The frozen rule of TZ 17.23 (`BigDayFollowUSD`) and its control. */
const FROZEN = { zMin: 2, zMax: Infinity, sigmaDays: 20, entryHour: 2, exitDay: 2, exitHour: 23, stopAtr: 1.5 };
const CONTROL = { ...FROZEN, zMin: 0.5, zMax: 1.5 };

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
    // Nothing after the end of the chosen set is read at all.
    if (date > TO) break;
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
 * Trades of one pair under rule `v`. The signal day is a daily bar whose close-to-close move is
 * between zMin and zMax sigmas (sigma: root mean square of the daily moves of the `sigmaDays` days
 * before it). The trade goes the way of that day: in at the open of the `entryHour` bar of the next
 * trading day, out at the open of the `exitHour` bar `exitDay` trading days after the signal day,
 * or at the stop `stopAtr` mean true ranges (20 days, the signal day included) from the entry price.
 * `costs` false gives the move before any costs (for the cross-check with fx-shock.mjs).
 */
function simulate(symbol, v, costs = true) {
  const { s, daily, h1, firstOfDate } = market.get(symbol);
  const ret = daily.map((b, i) => (i === 0 ? 0 : Math.log(b.c / daily[i - 1].c)));
  const tr = daily.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - daily[i - 1].c), Math.abs(b.l - daily[i - 1].c))));
  const trades = [];
  let busyUntil = "";
  for (let i = Math.max(v.sigmaDays, 20) + 1; i + v.exitDay < daily.length; i++) {
    const day = daily[i];
    if (day.date < FROM) continue;
    const sigma = Math.sqrt(mean(ret.slice(i - v.sigmaDays, i).map((x) => x * x)));
    const z = ret[i] / sigma;
    if (!(Math.abs(z) >= v.zMin && Math.abs(z) < v.zMax)) continue;
    const entryDate = daily[i + 1].date, exitDate = daily[i + v.exitDay].date;
    if (entryDate <= busyUntil) continue; // one position per pair
    const start = firstOfDate.get(entryDate);
    if (start === undefined) continue;
    let k = start;
    while (k < h1.length && h1[k].date === entryDate && h1[k].hour < v.entryHour) k++;
    // The entry bar has to be the named hour or at most two hours after it, on the same day.
    if (k >= h1.length || h1[k].date !== entryDate || h1[k].hour > v.entryHour + 2) continue;
    const dir = Math.sign(z);
    const atr = mean(tr.slice(i - 19, i + 1));
    const bar = h1[k];
    const spreadOf = (b) => (costs ? Math.max(b.spread, s.minSpread) * s.point : 0);
    const slip = costs ? s.slip : 0;
    const entry = dir > 0 ? bar.o + spreadOf(bar) + slip : bar.o - slip;
    const stop = v.stopAtr === null ? null : entry - dir * v.stopAtr * atr;
    let exit = NaN, reason = "", exitAt = "";
    for (let j = k; j < h1.length; j++) {
      const b = h1[j];
      // The time exit comes first on its bar: it is filled at the open.
      if (b.date > exitDate || (b.date === exitDate && b.hour >= v.exitHour)) {
        exit = dir > 0 ? b.o - slip : b.o + spreadOf(b) + slip; reason = "time"; exitAt = `${b.date} ${b.hour}`; break;
      }
      if (stop !== null) {
        if (dir > 0 && b.l <= stop) { exit = Math.min(stop, b.o) - slip; reason = "stop"; exitAt = `${b.date} ${b.hour}`; break; }
        if (dir < 0 && b.h + spreadOf(b) >= stop) { exit = Math.max(stop, b.o + spreadOf(b)) + slip; reason = "stop"; exitAt = `${b.date} ${b.hour}`; break; }
      }
      // The day of the exit ended without its exit hour (an early close): out at the last close.
      if (b.date === exitDate && (j + 1 >= h1.length || h1[j + 1].date !== exitDate)) {
        exit = dir > 0 ? b.c - slip : b.c + spreadOf(b) + slip; reason = "time"; exitAt = `${b.date} ${b.hour} close`; break;
      }
    }
    if (!Number.isFinite(exit)) continue;
    const outDate = exitAt.slice(0, 10);
    // Swaps: one for every night between the entry day and the day of the exit, three for the night after a Wednesday.
    let swap = 0;
    if (costs) for (let d = i + 1; daily[d] !== undefined && daily[d].date < outDate; d++) swap += (dir > 0 ? s.swapLong : s.swapShort) * (weekday(daily[d].date) === 3 ? 3 : 1);
    const commission = !costs ? 0 : s.base ? (s.commission / s.contract) * entry : s.commission / s.contract;
    const move = dir * (exit - entry) + swap - commission;
    const unit = (v.stopAtr ?? 1.5) * atr;
    busyUntil = outDate;
    trades.push({ symbol, signal: day.date, entryDate, exitAt, dir, z, entry, exit, reason, r: move / unit, bp: (move / entry) * 1e4, year: entryDate.slice(0, 4) });
  }
  return trades;
}
const run = (v, costs = true) => PAIRS.flatMap((p) => simulate(p, v, costs));

function summary(trades) {
  const byDay = new Map();
  for (const t of trades) byDay.set(t.entryDate, (byDay.get(t.entryDate) ?? 0) + t.r);
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let eq = 0, peak = 0, dd = 0;
  for (const [, r] of days) { eq += r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const st = stat(trades.map((t) => t.r));
  const dayStat = stat(days.map(([, r]) => r));
  const wins = trades.filter((t) => t.r > 0), losses = trades.filter((t) => t.r <= 0);
  const months = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.44);
  return {
    n: trades.length, perMonth: trades.length / months, meanR: st.m, tDays: dayStat.t, sumR: eq, dd,
    pf: wins.reduce((a, t) => a + t.r, 0) / Math.max(1e-9, -losses.reduce((a, t) => a + t.r, 0)),
    winShare: wins.length / Math.max(1, trades.length), stops: trades.filter((t) => t.reason === "stop").length,
    pairsPlus: PAIRS.filter((p) => mean(trades.filter((t) => t.symbol === p).map((t) => t.r)) > 0).length,
    worstDay: Math.min(...days.map(([, r]) => r)), bp: mean(trades.map((t) => t.bp)),
  };
}
const line = (label, s) => `${pad(label, 34)} n ${lpad(s.n, 4)} (${s.perMonth.toFixed(1)}/mo)  R ${f(s.meanR)}  t(days) ${f(s.tDays, 1)}  PF ${s.pf.toFixed(2)}  wins ${(s.winShare * 100).toFixed(0)}%  stops ${lpad(s.stops, 3)}  sum ${f(s.sumR, 1)}R  dd ${s.dd.toFixed(1)}R  worst day ${f(s.worstDay, 1)}R  pairs+ ${s.pairsPlus}/7  bp ${f(s.bp, 1)}`;

if (mode === "study") {
  console.log(`dev ${FROM} .. ${TO}; R = the stop distance (1.5 ATR where there is no stop); after costs unless said`);
  const check = run({ ...FROZEN, stopAtr: null }, false).filter((t) => true);
  console.log(`cross-check with fx-shock.mjs (z >= 2, in 02:00, out 23:00 a day later, no costs, no stop): ${check.length} trades, ${f(mean(check.map((t) => t.bp)), 1)} bp`);
  console.log("\n-- size of the day x exit day x stop");
  for (const zMin of [1.5, 2, 2.5]) for (const exitDay of [1, 2, 3]) for (const stopAtr of [1, 1.5, 2, null]) {
    console.log(line(`z>=${zMin} out day ${exitDay} stop ${stopAtr ?? "none"}`, summary(run({ ...FROZEN, zMin, exitDay, stopAtr }))));
  }
  console.log("\n-- other ways to measure the same thing (out day 2, stop 1.5)");
  console.log(line("sigma of 60 days, z>=2", summary(run({ ...FROZEN, sigmaDays: 60 }))));
  console.log(line("sigma of 10 days, z>=2", summary(run({ ...FROZEN, sigmaDays: 10 }))));
  console.log(line("entry at 01:00", summary(run({ ...FROZEN, entryHour: 1 }))));
  console.log(line("entry at 04:00", summary(run({ ...FROZEN, entryHour: 4 }))));
  console.log(line("entry at 09:00", summary(run({ ...FROZEN, entryHour: 9 }))));
  console.log(line("exit at 16:00 of day 2", summary(run({ ...FROZEN, exitHour: 16 }))));
  console.log(line("control: days of 0.5-1.5 sigma", summary(run(CONTROL))));
  console.log("\n-- the middle cell by year and by pair");
  const mid = run(FROZEN);
  for (const year of [...new Set(mid.map((t) => t.year))].sort()) console.log(line(year, summary(mid.filter((t) => t.year === year))));
  for (const p of PAIRS) console.log(line(p, summary(mid.filter((t) => t.symbol === p))));
  console.log(line("buys", summary(mid.filter((t) => t.dir > 0))));
  console.log(line("sells", summary(mid.filter((t) => t.dir < 0))));
} else if (mode === "check") {
  // For the cross-check: the moves before costs and without a stop, to be compared trade by trade with
  // fx-shock.mjs (another piece of code), and a few trades with every cost shown, to be recounted by hand.
  if (datasetArg !== "dev") throw new Error("the check runs on dev only");
  const plain = run({ ...FROZEN, stopAtr: null }, false);
  writeFileSync(flag, JSON.stringify(plain.map((t) => ({ symbol: t.symbol, signal: t.signal, bp: t.bp }))));
  console.log(`${plain.length} trades before costs written to ${flag}`);
  for (const symbol of ["EURUSD", "USDJPY"]) {
    const { s, h1 } = market.get(symbol);
    for (const t of simulate(symbol, FROZEN).slice(3, 5)) {
      const bar = h1.find((b) => b.date === t.entryDate && b.hour >= FROZEN.entryHour);
      console.log(`${symbol} signal ${t.signal} z ${f(t.z, 2)} dir ${t.dir} | entry bar ${bar.date} ${bar.hour}h open ${bar.o} spread ${bar.spread} -> entry ${t.entry.toFixed(5)} | exit ${t.exitAt} ${t.reason} ${t.exit.toFixed(5)} | weekday of entry ${weekday(t.entryDate)} | swap long ${s.swapLong.toFixed(6)} short ${s.swapShort.toFixed(6)} | R ${f(t.r, 4)} bp ${f(t.bp, 2)}`);
    }
  }
} else if (mode === "run") {
  console.log(`${datasetArg} ${FROM} .. ${TO}`);
  const own = run(FROZEN), control = run(CONTROL), doubled = run(FROZEN).map((t) => t);
  console.log(line("BigDayFollowUSD", summary(own)));
  console.log(line("control (0.5-1.5 sigma)", summary(control)));
  console.log(line("before costs", summary(run(FROZEN, false))));
  for (const year of [...new Set(own.map((t) => t.year))].sort()) console.log(line(year, summary(own.filter((t) => t.year === year))));
  for (const p of PAIRS) console.log(line(p, summary(own.filter((t) => t.symbol === p))));
  console.log(line("buys", summary(own.filter((t) => t.dir > 0))));
  console.log(line("sells", summary(own.filter((t) => t.dir < 0))));
  const file = process.argv.find((a) => a.endsWith(".json"));
  if (file !== undefined) writeFileSync(file, JSON.stringify({ dataset: datasetArg, rule: FROZEN, trades: own, control }, null, 1));
  void doubled;
} else {
  throw new Error("usage: node research/fx-shock-sim.mjs study | run dev|test|holdout");
}
