// Trades of the two "fixing" ideas of TZ 17.21 with the project's costs:
// the Tokyo fixing on gotobi days (USDJPY, M1 bars) and the hours after the
// London 4 p.m. fixing on the last weekday of a month (the seven dollar
// pairs, M15 bars). A small simulator of its own, because the engine has
// neither one-minute execution nor a view of another instrument; the costs
// are the engine's: the Ask is the Bid plus the bar's spread (not below the
// floor of the config), slippage on every fill, the commission of the config.
//
// Usage: node research/fix-sim.mjs study            grids, dev only
//        node research/fix-sim.mjs run <dataset>    the frozen rules on dev, test or holdout
import { createReadStream, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const HOUR = 3600e3, MIN = 60e3, DAY = 86400e3;
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const [mode = "study", datasetArg = "dev"] = process.argv.slice(2);
if (mode === "study" && datasetArg !== "dev") throw new Error("grids run on dev only");

/** Calendar dates of the datasets (server days, as in config/default.json); the holdout ends where the common data end. */
const SPANS = {
  dev: ["2015-02-02", "2021-12-08"],
  test: [config.datasets.testStart, "2024-11-15"],
  holdout: [config.datasets.holdoutStart, "2026-10-29"],
};
const span = SPANS[datasetArg];
if (span === undefined) throw new Error(`unknown dataset ${datasetArg}`);
const [FROM, TO] = span;

// --- time
const athens = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Athens", hour: "2-digit", hour12: false });
const offsets = new Map();
function serverToUtc(date, time) {
  let offset = offsets.get(date);
  if (offset === undefined) {
    const noon = Date.parse(`${date}T12:00:00Z`);
    for (const hours of [2, 3]) if (+athens.format(new Date(noon - hours * HOUR)) % 24 === 12) offset = hours * HOUR;
    offsets.set(date, offset);
  }
  return Date.parse(`${date}T${time}:00Z`) - offset;
}
const london = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false });
function londonToUtc(date, hour, minute = 0) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const shown = +london.format(new Date(guess)) % 24;
  return guess - ((shown - hour + 24) % 24) * HOUR;
}
const tokyoToUtc = (date, hour, minute = 0) => Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) - 9 * HOUR;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, n) => iso(Date.parse(`${date}T00:00:00Z`) + n * DAY);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
function* dates(from, to) { for (let d = from; d <= to; d = addDays(d, 1)) yield d; }

// --- stats
const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function stat(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return { n: xs.length, m, sd, t: m / (sd / Math.sqrt(Math.max(1, xs.length))) };
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));

// --- instruments and costs, as the engine has them
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
const round = (s, x) => Math.round(x / s.point) * s.point;
const spreadOf = (s, bar) => Math.max(bar.spread, s.minSpread) * s.point;
/** The commission of a round trip as a price distance, at `price`. */
const commissionPrice = (s, price) => (s.base ? (s.commission / s.contract) * price : s.commission / s.contract);

/**
 * One trade on bars that follow each other without holes of their own choosing:
 * entry at the open of the bar at `entryTime`, exit at the open of the bar at
 * `exitTime` (or the first bar after it), a stop `stopDistance` from the fill
 * checked on every bar in between, the stop first. Returns null when there is
 * no bar to enter on.
 */
function trade(s, bars, step, direction, entryTime, exitTime, stopDistance) {
  const first = bars.get(entryTime);
  if (first === undefined) return null;
  const sign = direction === "BUY" ? 1 : -1;
  const entry = round(s, sign === 1 ? first.open + spreadOf(s, first) + s.slip : first.open - s.slip);
  const stop = round(s, entry - sign * stopDistance);
  let exit = null, reason = "time", rawExit = null, exitAt = exitTime;
  for (let t = entryTime; t < exitTime; t += step) {
    const bar = bars.get(t);
    if (bar === undefined) continue;
    const spread = spreadOf(s, bar);
    if (sign === 1) {
      if (bar.open <= stop && t > entryTime) { exit = round(s, bar.open - s.slip); rawExit = bar.open; reason = "stop"; exitAt = t; break; }
      if (bar.low <= stop) { exit = round(s, stop - s.slip); rawExit = stop; reason = "stop"; exitAt = t; break; }
    } else {
      if (round(s, bar.open + spread) >= stop && t > entryTime) { exit = round(s, bar.open + spread + s.slip); rawExit = bar.open; reason = "stop"; exitAt = t; break; }
      if (round(s, bar.high + spread) >= stop) { exit = round(s, stop + s.slip); rawExit = stop; reason = "stop"; exitAt = t; break; }
    }
  }
  if (exit === null) {
    // The bar at the exit time, or the first one within an hour after it.
    let bar;
    for (let t = exitTime; t <= exitTime + HOUR && bar === undefined; t += step) { bar = bars.get(t); exitAt = t; }
    if (bar === undefined) return null;
    exit = round(s, sign === 1 ? bar.open - s.slip : bar.open + spreadOf(s, bar) + s.slip);
    rawExit = bar.open;
  }
  const distance = sign * (entry - stop);
  const net = sign * (exit - entry) - commissionPrice(s, entry);
  return { direction, entryTime, exitTime: exitAt, entry, exit, stop, reason, gross: sign * (rawExit - first.open), net, r: net / distance };
}

// --- calendars
const holidays = new Set(Object.keys(JSON.parse(readFileSync("data/raw/research-yahoo/jp-holidays.json", "utf8"))));
// Banks in Japan are also shut on 31 December and 2-3 January.
const tokyoBusinessDay = (date) => weekday(date) >= 1 && weekday(date) <= 5 && !holidays.has(date) && !/-(12-31|01-0[123])$/.test(date);
/** Gotobi days: the 5th, 10th, ... 30th, moved to the business day before when the banks are shut. */
function gotobiDays(from, to) {
  const out = new Set();
  for (const date of dates(addDays(from, -1), addDays(to, 10))) {
    if (+date.slice(8, 10) % 5 !== 0) continue;
    let d = date;
    while (!tokyoBusinessDay(d)) d = addDays(d, -1);
    if (d >= from && d <= to) out.add(d);
  }
  return [...out].sort();
}
/** The last weekday of every month that ends inside the span. */
function monthEnds(from, to) {
  const out = [];
  for (const date of dates(from, to)) {
    if (weekday(date) < 1 || weekday(date) > 5) continue;
    let next = addDays(date, 1);
    while (weekday(next) < 1 || weekday(next) > 5) next = addDays(next, 1);
    if (next.slice(0, 7) !== date.slice(0, 7) && next <= addDays(to, 5)) out.push(date);
  }
  return out;
}

// --- files
function readTable(file) {
  const buffer = readFileSync(file);
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  const head = lines[0].split("\t").map((name) => name.replace(/[<>]/g, "").trim());
  return lines.slice(1).map((line) => { const cells = line.split("\t"); return Object.fromEntries(head.map((name, i) => [name, cells[i]])); });
}
const dot = (date) => date.replaceAll("-", ".");
function loadM15(symbol) {
  const map = new Map();
  for (const r of readTable(path.join(config.dataDir, `${symbol}_M15.csv`))) {
    if (r.DATE < dot(addDays(FROM, -1)) || r.DATE > dot(addDays(TO, 1))) continue;
    map.set(serverToUtc(r.DATE.replaceAll(".", "-"), r.TIME.slice(0, 5)), { open: +r.OPEN, high: +r.HIGH, low: +r.LOW, close: +r.CLOSE, spread: +r.SPREAD });
  }
  return map;
}
/** Daily ATR(14) by Wilder as of the last daily bar before each date. */
function loadAtr(symbol) {
  const rows = readTable(path.join(config.dataDir, `${symbol}_D1.csv`)).map((r) => ({ date: r.DATE.replaceAll(".", "-"), high: +r.HIGH, low: +r.LOW, close: +r.CLOSE }));
  const atr = [];
  let sum = 0, count = 0, last = NaN;
  rows.forEach((b, i) => {
    if (i > 0) {
      const pc = rows[i - 1].close;
      const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
      if (count < 14) { sum += tr; count++; last = count === 14 ? sum / 14 : NaN; } else last = (last * 13 + tr) / 14;
    }
    atr.push(last);
  });
  return (date) => { let k = -1; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].date < date) { k = i; break; } return k < 0 ? NaN : atr[k]; };
}
async function loadM1(symbol, wanted) {
  const file = readdirSync(config.dataDir).find((name) => name.startsWith(`${symbol}_M1_`));
  const bars = new Map();
  const lines = createInterface({ input: createReadStream(path.join(config.dataDir, file), { encoding: "utf8" }) });
  let first = true;
  for await (const line of lines) {
    if (first) { first = false; continue; }
    const date = line.slice(0, 10);
    if (date < dot(addDays(FROM, -1)) || date > dot(addDays(TO, 1))) continue;
    const cells = line.split("\t");
    const time = serverToUtc(date.replaceAll(".", "-"), cells[1].slice(0, 5));
    if (wanted(time)) bars.set(time, { open: +cells[2], high: +cells[3], low: +cells[4], close: +cells[5], spread: +cells[8] });
  }
  return bars;
}
function spxMonthToDate() {
  const rows = readTable("data/raw/research-yahoo/SPXCASH_D1.csv").map((r) => ({ date: r.DATE.replaceAll(".", "-"), close: +r.CLOSE }));
  return (date) => {
    const before = rows.filter((r) => r.date < date);
    const last = before.at(-1);
    const base = before.filter((r) => r.date.slice(0, 7) < date.slice(0, 7)).at(-1);
    return last === undefined || base === undefined || last.date.slice(0, 7) !== date.slice(0, 7) ? null : last.close / base.close - 1;
  };
}

function summary(label, list, unit, scale) {
  if (list.length === 0) { console.log(`${label}: no trades`); return; }
  const net = stat(list.map((t) => t.net / scale)), gross = stat(list.map((t) => t.gross / scale)), r = stat(list.map((t) => t.r));
  const wins = list.filter((t) => t.net > 0).length, stops = list.filter((t) => t.reason === "stop").length;
  const won = list.filter((t) => t.net > 0).reduce((a, t) => a + t.r, 0), lost = -list.filter((t) => t.net < 0).reduce((a, t) => a + t.r, 0);
  console.log(`${label.padEnd(44)} n ${String(list.length).padStart(4)} | gross ${f(gross.m)} ${unit} | net ${f(net.m)} ${unit} (t ${f(net.t, 1)}) | wins ${((100 * wins) / list.length).toFixed(0)}% stops ${((100 * stops) / list.length).toFixed(0)}% | mean R ${f(r.m, 3)} PF ${(won / lost).toFixed(2)} total ${f(r.m * list.length, 1)}R`);
}

// ============================================================ gotobi
const jpy = spec("USDJPY");
const tokyoDays = [...dates(FROM, TO)].filter(tokyoBusinessDay);
const gotobi = gotobiDays(FROM, TO);
const windowStart = (date) => tokyoToUtc(date, 7, 30), windowEnd = (date) => tokyoToUtc(date, 12, 5);
const dayOf = new Set(tokyoDays.flatMap((date) => { const out = []; for (let t = windowStart(date); t <= windowEnd(date); t += MIN) out.push(t); return out; }));
const m1 = await loadM1("USDJPY", (time) => dayOf.has(time));
const atrJpy = loadAtr("USDJPY");
const gotobiTrade = (date, direction, entry, exit, stop) =>
  trade(jpy, m1, MIN, direction, tokyoToUtc(date, ...entry), tokyoToUtc(date, ...exit), typeof stop === "number" ? stop * jpy.pip : stop.atr * atrJpy(date));
const run = (days, ...args) => days.map((date) => gotobiTrade(date, ...args)).filter((t) => t !== null);

// ============================================================ month end
const m15 = Object.fromEntries(PAIRS.map((symbol) => [symbol, loadM15(symbol)]));
const atrOf = Object.fromEntries(PAIRS.map((symbol) => [symbol, loadAtr(symbol)]));
const specs = Object.fromEntries(PAIRS.map((symbol) => [symbol, spec(symbol)]));
const ends = monthEnds(FROM, TO);
const usMonth = spxMonthToDate();
/** Trades after the London fixing on month-end days: `rule` gives the dollar side for a date, +1 buy, -1 sell, 0 none. */
function monthEndTrades(rule, exitHour, stopAtr, entry = [16, 0]) {
  const out = [];
  for (const date of ends) {
    const side = rule(date);
    if (side === 0) continue;
    for (const symbol of PAIRS) {
      const s = specs[symbol];
      const a = atrOf[symbol](date);
      if (!(a > 0)) continue;
      // Buying the dollar is buying USDxxx and selling xxxUSD.
      const direction = (symbol.startsWith("USD") ? side : -side) === 1 ? "BUY" : "SELL";
      const t = trade(s, m15[symbol], 15 * MIN, direction, londonToUtc(date, ...entry), londonToUtc(date, exitHour), stopAtr * a);
      if (t !== null) out.push({ ...t, symbol, date, netBp: (t.net / t.entry) * 1e4, grossBp: (t.gross / t.entry) * 1e4 });
    }
  }
  return out;
}
const bp = (list) => list.map((t) => ({ ...t, net: t.netBp, gross: t.grossBp }));
const PLAIN = () => 1;
const SIGNED = (date) => { const us = usMonth(date); return us === null ? 0 : us > 0 ? 1 : -1; };
const SIGNED_BIG = (date) => { const us = usMonth(date); return us === null || Math.abs(us) < 0.03 ? 0 : us > 0 ? 1 : -1; };
/** One number a month: the mean of the month's trades. */
function byMonth(list) {
  const groups = new Map();
  for (const t of list) groups.set(t.date, [...(groups.get(t.date) ?? []), t.r]);
  const s = stat([...groups.values()].map(mean));
  return `months ${s.n}, mean R of a month ${f(s.m, 3)} (t ${f(s.t, 1)})`;
}

if (mode === "study") {
  console.log(`dev: Tokyo business days ${tokyoDays.length}, gotobi days ${gotobi.length}; month ends ${ends.length}. Costs are in.`);
  console.log("\nGotobi days, USDJPY: buy before the fixing. Stop 20 pips. Moves in pips.");
  for (const entry of [[8, 0], [8, 30], [9, 0], [9, 15], [9, 30]]) {
    for (const exit of [[9, 50], [9, 54], [9, 55], [10, 0]]) {
      summary(`  buy ${entry[0]}:${String(entry[1]).padStart(2, "0")} -> ${exit[0]}:${String(exit[1]).padStart(2, "0")}`, run(gotobi, "BUY", entry, exit, 20), "pips", jpy.pip);
    }
  }
  console.log("\nGotobi days, USDJPY: sell after the fixing. Stop 20 pips.");
  for (const entry of [[9, 55], [9, 56], [10, 0]]) {
    for (const exit of [[10, 30], [11, 0], [12, 0]]) {
      summary(`  sell ${entry[0]}:${String(entry[1]).padStart(2, "0")} -> ${exit[0]}:${String(exit[1]).padStart(2, "0")}`, run(gotobi, "SELL", entry, exit, 20), "pips", jpy.pip);
    }
  }
  console.log("\nThe stop, for buy 9:00 -> 9:55 and sell 9:55 -> 10:30:");
  for (const stop of [10, 15, 20, 30, { atr: 0.25 }, { atr: 0.5 }]) {
    const label = typeof stop === "number" ? `${stop} pips` : `${stop.atr} ATR`;
    summary(`  buy, stop ${label}`, run(gotobi, "BUY", [9, 0], [9, 55], stop), "pips", jpy.pip);
    summary(`  sell, stop ${label}`, run(gotobi, "SELL", [9, 55], [10, 30], stop), "pips", jpy.pip);
  }
  console.log("\nThe same two trades on the days that are not gotobi (the control):");
  const others = tokyoDays.filter((d) => !gotobi.includes(d));
  summary("  buy 9:00 -> 9:55, other days", run(others, "BUY", [9, 0], [9, 55], 20), "pips", jpy.pip);
  summary("  sell 9:55 -> 10:30, other days", run(others, "SELL", [9, 55], [10, 30], 20), "pips", jpy.pip);
  console.log("\nBy year, buy 9:00 -> 9:55 and sell 9:55 -> 10:30, stop 20 pips:");
  for (let y = 2015; y <= 2021; y++) {
    const days = gotobi.filter((d) => d.startsWith(String(y)));
    summary(`  ${y} buy`, run(days, "BUY", [9, 0], [9, 55], 20), "pips", jpy.pip);
    summary(`  ${y} sell`, run(days, "SELL", [9, 55], [10, 30], 20), "pips", jpy.pip);
  }

  console.log("\nMonth end, seven pairs: after the London 4 p.m. fixing. Moves in basis points; stop 0.5 daily ATR.");
  for (const [name, rule] of [["buy the dollar every month end", PLAIN], ["dollar side by the month of US shares", SIGNED], ["the same, months of 3% and more only", SIGNED_BIG]]) {
    for (const exitHour of [18, 20, 22]) {
      const list = monthEndTrades(rule, exitHour, 0.5);
      summary(`  ${name}, to ${exitHour}:00`, bp(list), "bp", 1);
      console.log(`      ${byMonth(list)}`);
    }
  }
  console.log("\nThe stop and the entry, for the dollar side by the month of US shares, to 20:00:");
  for (const stopAtr of [0.25, 0.5, 1]) summary(`  stop ${stopAtr} ATR`, bp(monthEndTrades(SIGNED, 20, stopAtr)), "bp", 1);
  summary("  entry 16:15, stop 0.5 ATR", bp(monthEndTrades(SIGNED, 20, 0.5, [16, 15])), "bp", 1);
  console.log("\nBy pair, dollar side by the month of US shares, to 20:00, stop 0.5 ATR:");
  const all = monthEndTrades(SIGNED, 20, 0.5);
  for (const symbol of PAIRS) summary(`  ${symbol}`, bp(all.filter((t) => t.symbol === symbol)), "bp", 1);
  console.log("By year:");
  for (let y = 2015; y <= 2021; y++) summary(`  ${y}`, bp(all.filter((t) => t.date.startsWith(String(y)))), "bp", 1);
}

// How fast does the month-end move go? Entry minute by minute on the pairs that have M1 files, dev only.
if (mode === "timing") {
  if (datasetArg !== "dev") throw new Error("the timing table is for dev only");
  console.log("Month end, dollar side by the month of US shares, exit 20:00 London, stop 0.5 ATR: by the minute of entry (M1 files). Net of costs, basis points.");
  const minutes = [-10, -5, 0, 1, 2, 3, 5, 10, 15, 30];
  const pooled = new Map(minutes.map((k) => [k, []]));
  for (const symbol of ["EURUSD", "GBPUSD", "USDJPY"]) {
    const s = specs[symbol];
    const wantedTimes = new Set();
    for (const date of ends) for (let t = londonToUtc(date, 15, 45); t <= londonToUtc(date, 20, 5); t += MIN) wantedTimes.add(t);
    const bars = await loadM1(symbol, (time) => wantedTimes.has(time));
    const cells = [];
    for (const k of minutes) {
      const list = [];
      for (const date of ends) {
        const side = SIGNED(date);
        const a = atrOf[symbol](date);
        if (side === 0 || !(a > 0)) continue;
        const direction = (symbol.startsWith("USD") ? side : -side) === 1 ? "BUY" : "SELL";
        const t = trade(s, bars, MIN, direction, londonToUtc(date, 16, 0) + k * MIN, londonToUtc(date, 20, 0), 0.5 * a);
        if (t !== null) { list.push((t.net / t.entry) * 1e4); pooled.get(k).push({ date, bp: (t.net / t.entry) * 1e4 }); }
      }
      const st = stat(list);
      cells.push(`${k >= 0 ? "+" : ""}${k}min ${f(st.m)} (t ${f(st.t, 1)})`);
    }
    console.log(`  ${symbol}: ${cells.join(" | ")}`);
  }
  console.log("  the three pairs together, one number a month:");
  for (const k of minutes) {
    const months = new Map();
    for (const row of pooled.get(k)) months.set(row.date, [...(months.get(row.date) ?? []), row.bp]);
    const st = stat([...months.values()].map(mean));
    console.log(`    entry 16:00 ${k >= 0 ? "+" : ""}${k} min: ${f(st.m)} bp (t ${f(st.t, 1)}, months ${st.n})`);
  }
}

// ============================================================ the frozen rules (TZ 17.21)
// MonthEndFixUSD: on the last weekday of a month, at 16:00 London, take the dollar's side against the
// seven pairs by the month of US shares (up: buy the dollar), stop 0.5 daily ATR, out at 20:00 London.
// GotobiFixUSDJPY: on gotobi days buy USDJPY at 9:00 Tokyo, stop 0.25 daily ATR, out at 9:55 Tokyo.
if (mode === "run") {
  const months = (FROM, TO, (Date.parse(`${TO}T00:00:00Z`) - Date.parse(`${FROM}T00:00:00Z`)) / (30.4375 * DAY));
  console.log(`${datasetArg}: ${FROM} to ${TO} (${months.toFixed(1)} months). Costs are in.`);

  console.log("\nMonthEndFixUSD");
  const main = monthEndTrades(SIGNED, 20, 0.5);
  summary("  all trades", bp(main), "bp", 1);
  console.log(`      ${byMonth(main)}`);
  const big = main.filter((t) => Math.abs(usMonth(t.date)) >= 0.03);
  summary("  months of 3% and more in US shares", bp(big), "bp", 1);
  console.log(`      ${byMonth(big)}`);
  summary("  the other months", bp(main.filter((t) => !big.includes(t))), "bp", 1);
  let plus = 0;
  for (const symbol of PAIRS) {
    const list = main.filter((t) => t.symbol === symbol);
    if (mean(list.map((t) => t.r)) > 0) plus++;
    summary(`  ${symbol}`, bp(list), "bp", 1);
  }
  console.log(`  pairs in profit: ${plus} of ${PAIRS.length}`);
  const years = [...new Set(main.map((t) => t.date.slice(0, 4)))];
  for (const y of years) summary(`  ${y}`, bp(main.filter((t) => t.date.startsWith(y))), "bp", 1);
  // Control: the same rule at the same hour on every other weekday.
  const savedEnds = ends.slice();
  const endSet = new Set(savedEnds);
  ends.length = 0;
  for (const date of dates(FROM, TO)) if (weekday(date) >= 1 && weekday(date) <= 5 && !endSet.has(date)) ends.push(date);
  const control = monthEndTrades(SIGNED, 20, 0.5);
  ends.length = 0;
  ends.push(...savedEnds);
  summary("  control: the same on every other weekday", bp(control), "bp", 1);
  console.log(`      ${byMonth(control).replace("months", "days").replace("of a month", "of a day")}`);
  const monthR = (() => { const g = new Map(); for (const t of main) g.set(t.date, [...(g.get(t.date) ?? []), t.r]); return [...g.entries()].map(([date, list]) => `${date.slice(0, 7)} ${f(mean(list), 2)}`); })();
  console.log(`  month by month, mean R: ${monthR.join(", ")}`);

  console.log("\nGotobiFixUSDJPY");
  const long = run(gotobi, "BUY", [9, 0], [9, 55], { atr: 0.25 });
  summary("  buy 9:00 -> 9:55 on gotobi days", long, "pips", jpy.pip);
  for (const y of [...new Set(gotobi.map((d) => d.slice(0, 4)))]) summary(`  ${y}`, run(gotobi.filter((d) => d.startsWith(y)), "BUY", [9, 0], [9, 55], { atr: 0.25 }), "pips", jpy.pip);
  const others = tokyoDays.filter((d) => !gotobi.includes(d));
  summary("  control: the same on the other days", run(others, "BUY", [9, 0], [9, 55], { atr: 0.25 }), "pips", jpy.pip);
  summary("  for reference: sell 9:55 -> 10:30 on gotobi days", run(gotobi, "SELL", [9, 55], [10, 30], { atr: 0.25 }), "pips", jpy.pip);
}
