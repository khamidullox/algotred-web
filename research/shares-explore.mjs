// Exploration on the baskets already seen in TZ 17.22 (they are "dev" for shares from now on).
// A standalone daily simulation, no engine code: RSI(2) dip rule with a choice of sides, stop and
// time limit. Costs: 0.078% of the price a round trip, financing 0.017767% a calendar night for buys
// and 0.004832% for sells. The unit R is 2 x ATR(20) at the signal whatever the stop is, so the
// variants are comparable: a position is sized so that 2 ATR is the same money in every variant.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = "data/raw/research-yahoo";
export const baskets = JSON.parse(readFileSync("research/share-baskets.json", "utf8"));
const FROM = "2015.02.02";
const mean = (list) => (list.length === 0 ? NaN : list.reduce((a, b) => a + b, 0) / list.length);
const sd = (list) => Math.sqrt(mean(list.map((x) => (x - mean(list)) ** 2)) * (list.length / Math.max(1, list.length - 1)));
export const fmt = (x, d = 3) => (Number.isNaN(x) ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
const dayNumber = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400000;

const cache = new Map();
export function series(ticker) {
  if (cache.has(ticker)) return cache.get(ticker);
  const rows = readFileSync(`${dir}/ST${ticker}_D1.csv`, "utf8").trim().split(/\r?\n/).slice(1).map((line) => { const p = line.split("\t"); return { date: p[0], open: +p[1], high: +p[2], low: +p[3], close: +p[4] }; });
  // Indicators on closed bars: Wilder RSI(2), Wilder ATR(20), SMA(200), SMA(5).
  let avgGain = null, avgLoss = null, atr = null, trSum = 0, sum200 = 0, sum5 = 0;
  rows.forEach((row, i) => {
    sum200 += row.close; if (i >= 200) sum200 -= rows[i - 200].close;
    sum5 += row.close; if (i >= 5) sum5 -= rows[i - 5].close;
    row.sma200 = i >= 199 ? sum200 / 200 : NaN;
    row.sma5 = i >= 4 ? sum5 / 5 : NaN;
    row.rsi = NaN; row.atr = NaN;
    if (i === 0) return;
    const change = row.close - rows[i - 1].close;
    const gain = Math.max(change, 0), loss = Math.max(-change, 0);
    if (i === 1) { avgGain = gain; avgLoss = loss; }
    else { avgGain = (avgGain + gain) / 2; avgLoss = (avgLoss + loss) / 2; }
    if (i >= 2) row.rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    const tr = Math.max(row.high - row.low, Math.abs(row.high - rows[i - 1].close), Math.abs(row.low - rows[i - 1].close));
    if (i <= 20) { trSum += tr; if (i === 20) atr = trSum / 20; } else atr = (atr * 19 + tr) / 20;
    if (i >= 20) row.atr = atr;
  });
  cache.set(ticker, rows);
  return rows;
}

/**
 * v: { entry: "dip"|"neutral", sides: "both"|"long"|"short", stopAtr: number|null, maxDays: number|null, holdDays?: number, rsiBelow?: number }
 */
export function simulate(ticker, v, from = FROM, to = "9999") {
  const rows = series(ticker);
  const out = [];
  let open = null;
  const threshold = v.rsiBelow ?? 5;
  for (let i = 200; i < rows.length; i++) {
    const row = rows[i];
    if (open !== null) {
      // The bar is a day in the trade: the stop first (a gap through it fills at the open), then the rule at the close.
      let exitPrice = null, reason = null;
      if (open.exitNextOpen) { exitPrice = row.open; reason = "rule"; }
      else if (open.stop !== null) {
        if (open.side === 1 && row.low <= open.stop) { exitPrice = Math.min(row.open, open.stop); reason = "stop"; }
        if (open.side === -1 && row.high >= open.stop) { exitPrice = Math.max(row.open, open.stop); reason = "stop"; }
      }
      if (exitPrice === null) {
        open.held++;
        const ruleOut = v.entry === "neutral" ? open.held >= (v.holdDays ?? 4) : open.side * (row.close - row.sma5) > 0;
        if (ruleOut || (v.maxDays !== null && v.maxDays !== undefined && open.held >= v.maxDays)) open.exitNextOpen = true;
        continue;
      }
      const nights = dayNumber(row.date) - dayNumber(open.date);
      const gross = open.side * (exitPrice / open.price - 1) * 100;
      const cost = 0.078 + nights * (open.side === 1 ? 0.017767 : 0.004832);
      out.push({ ticker, date: open.date, exit: row.date, side: open.side, gross, net: gross - cost, r: (gross - cost) / open.unitPct, reason, nights, month: open.date.slice(0, 7) });
      open = null;
      // A position closed at this open or inside this day leaves the close of the day free for a new signal.
    }
    if (open === null && i + 1 < rows.length && rows[i + 1].date >= from && rows[i + 1].date < to && !Number.isNaN(row.atr)) {
      let side = 0;
      if (v.entry === "neutral") {
        if (row.rsi >= 45 && row.rsi <= 55) side = row.close > row.sma200 ? 1 : row.close < row.sma200 ? -1 : 0;
      } else if (row.close > row.sma200 && row.rsi < threshold) side = 1;
      else if (row.close < row.sma200 && row.rsi > 100 - threshold) side = -1;
      if (side === 1 && v.sides === "short") side = 0;
      if (side === -1 && v.sides === "long") side = 0;
      if (side !== 0) {
        const price = rows[i + 1].open;
        open = { side, price, date: rows[i + 1].date, held: 0, exitNextOpen: false, unitPct: ((2 * row.atr) / price) * 100, stop: v.stopAtr === null ? null : price - side * v.stopAtr * row.atr };
      }
    }
  }
  return out;
}

export function stats(trades) {
  const r = trades.map((t) => t.r);
  const byMonth = new Map();
  for (const t of trades) byMonth.set(t.month, (byMonth.get(t.month) ?? 0) + t.r);
  const first = trades.reduce((a, t) => (t.month < a ? t.month : a), "9999.99");
  const last = trades.reduce((a, t) => (t.month > a ? t.month : a), "0000.00");
  // Every calendar month of the span, the empty ones as zero.
  const months = [];
  if (trades.length > 0) {
    let [y, m] = first.split(".").map(Number);
    const [ly, lm] = last.split(".").map(Number);
    while (y < ly || (y === ly && m <= lm)) { months.push(byMonth.get(`${y}.${String(m).padStart(2, "0")}`) ?? 0); m++; if (m > 12) { m = 1; y++; } }
  }
  const ordered = [...trades].sort((a, b) => (a.exit < b.exit ? -1 : a.exit > b.exit ? 1 : 0));
  let sum = 0, peak = 0, dd = 0;
  for (const t of ordered) { sum += t.r; peak = Math.max(peak, sum); dd = Math.max(dd, peak - sum); }
  const bySymbol = new Map();
  for (const t of trades) bySymbol.set(t.ticker, (bySymbol.get(t.ticker) ?? 0) + t.r);
  return {
    n: trades.length, gross: mean(trades.map((t) => t.gross)), net: mean(trades.map((t) => t.net)), r: mean(r), sumR: sum,
    tMonth: months.length < 3 ? NaN : mean(months) / (sd(months) / Math.sqrt(months.length)), months: months.length, monthsPlus: months.filter((x) => x > 0).length,
    worstMonth: months.length === 0 ? NaN : Math.min(...months), worstTrade: r.length === 0 ? NaN : Math.min(...r), dd, perMonth: trades.length / Math.max(1, months.length),
    symbolsPlus: [...bySymbol.values()].filter((x) => x > 0).length, symbols: bySymbol.size, stops: trades.filter((t) => t.reason === "stop").length,
  };
}
export const row = (label, s) => `${label.padEnd(32)} n ${String(s.n).padStart(5)} | gross ${fmt(s.gross)}% net ${fmt(s.net)}% | R ${fmt(s.r)} sum ${fmt(s.sumR, 1).padStart(7)} tMonth ${fmt(s.tMonth, 2)} | months+ ${s.monthsPlus}/${s.months} worstMonth ${fmt(s.worstMonth, 1)} worstTrade ${fmt(s.worstTrade, 1)} dd ${s.dd.toFixed(1)} | /month ${s.perMonth.toFixed(1)} | symbols+ ${s.symbolsPlus}/${s.symbols} | stops ${s.stops}`;

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "grid") {
  const CUT = "2021.12.09";
  for (const name of ["DOW2015", "ETFS", "BROKER"]) {
    console.log(`\n===== ${name}`);
    const run = (v) => baskets[name].flatMap((ticker) => simulate(ticker, v));
    const variants = [];
    for (const sides of ["both", "long", "short"]) for (const stopAtr of [2, 3, 4, 6, null]) variants.push({ label: `dip ${sides} stop ${stopAtr ?? "none"}`, v: { entry: "dip", sides, stopAtr, maxDays: null } });
    variants.push({ label: "dip long stop none max10d", v: { entry: "dip", sides: "long", stopAtr: null, maxDays: 10 } });
    variants.push({ label: "dip long stop 4 max10d", v: { entry: "dip", sides: "long", stopAtr: 4, maxDays: 10 } });
    variants.push({ label: "CONTROL neutral long stop none", v: { entry: "neutral", sides: "long", stopAtr: null, maxDays: null } });
    variants.push({ label: "CONTROL neutral long stop 2", v: { entry: "neutral", sides: "long", stopAtr: 2, maxDays: null } });
    variants.push({ label: "CONTROL neutral short stop none", v: { entry: "neutral", sides: "short", stopAtr: null, maxDays: null } });
    for (const { label, v } of variants) {
      const all = run(v);
      console.log(row(label, stats(all)));
      const before = stats(all.filter((t) => t.date < CUT)), after = stats(all.filter((t) => t.date >= CUT));
      console.log(`${"".padEnd(32)} before 2021-12-09: R ${fmt(before.r)} (${before.n}), net ${fmt(before.net)}%, tMonth ${fmt(before.tMonth, 2)} | after: R ${fmt(after.r)} (${after.n}), net ${fmt(after.net)}%, tMonth ${fmt(after.tMonth, 2)}, symbols+ ${after.symbolsPlus}/${after.symbols}`);
    }
  }
}
