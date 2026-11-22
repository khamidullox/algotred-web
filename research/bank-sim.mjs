// Four frozen rules around central-bank decisions (TZ 17.32) with the costs of
// the project: the Ask is the Bid plus the spread of the bar (not below the
// floor of the config), slippage on every fill, the commission and the swap of
// the config. A simulator of its own, as fx-shock-sim.mjs: each rule is a few
// lines and has to be run on three sets the same way.
//
//   FedEveDollar      24 hours before a scheduled decision of the Fed: sell the
//                     dollar against all seven pairs; out 15 minutes before the decision.
//   RbaEveAud         24 hours before a scheduled decision of the Reserve Bank of
//                     Australia: buy AUDUSD; out 15 minutes before the decision.
//   BocEveCad         24 hours before a scheduled decision of the Bank of Canada:
//                     buy USDCAD; out 15 minutes before the decision.
//   FadeIntoDecision  15 minutes before a scheduled decision of each of the seven
//                     banks other than the Fed: the bank's pair against its own move
//                     of the last 6 hours; out 2 hours after the decision. A stop hit
//                     on the way is filled at the worst price of that quarter-hour.
// A fifth rule is measured on dev only and is not frozen (too weak there):
//   FedMorningAfter   at 02:00 by the server after a scheduled decision of the Fed:
//                     each of the seven pairs in the direction of its own move since
//                     15 minutes before the decision; out at 06:00.
//
// The day of a decision comes from the MT5 calendar, the clock from the bank's
// own schedule (the calendar's clock is an hour off in places after 2023).
// Decisions taken outside the schedule are left out. Stop: two usual days of
// the pair from the entry. Control of every rule: the same trade 7 and 14 days
// later, when that bank decides nothing within two days.
//
// Usage: node research/bank-sim.mjs dev|test [file.json]
//        node research/bank-sim.mjs holdout --i-understand-holdout [file.json]
import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const [datasetArg = "dev"] = process.argv.slice(2);
if (datasetArg === "holdout" && !process.argv.includes("--i-understand-holdout")) throw new Error("the holdout needs --i-understand-holdout");
const SPANS = {
  dev: ["2015-02-02", "2021-12-08"],
  test: [config.datasets.testStart, "2024-11-15"],
  holdout: [config.datasets.holdoutStart, "2026-10-29"],
};
const span = SPANS[datasetArg];
if (span === undefined) throw new Error(`unknown dataset ${datasetArg}`);
const [FROM, TO] = span;

/** The frozen numbers of TZ 17.32. */
const FROZEN = { eveHours: 24, beforeMinutes: 15, fadeBackHours: 6, fadeOutMinutes: 120, afterEntryMinute: 2 * 60, afterHoldMinutes: 240, stopUsualDays: 2, usualDays: 20, controlShiftDays: [7, 14] };
/**
 * The banks: the calendar row that gives the day, the pair, the local clock of the announcement (a window where the bank
 * has no fixed minute), the decisions outside the schedule, and the calendar days known to be wrong.
 */
const BANKS = {
  fed: { name: "Fed", code: "fed-interest-rate-decision", currency: "USD", zone: "America/New_York", clock: () => [[14, 0], [14, 0]], unscheduled: ["2020-03-03", "2020-03-15"] },
  ecb: { name: "ECB", code: "ecb-interest-rate-decision", currency: "EUR", pair: "EURUSD", zone: "Europe/Berlin", clock: (d) => (d >= "2023-01-01" ? [[14, 15], [14, 15]] : [[13, 45], [13, 45]]), unscheduled: [] },
  boe: { name: "Bank of England", code: "boe-interest-rate-decision", currency: "GBP", pair: "GBPUSD", zone: "Europe/London", clock: (d) => (["2020-05-07", "2020-08-06", "2020-11-05"].includes(d) ? [[7, 0], [7, 0]] : [[12, 0], [12, 0]]), unscheduled: ["2020-03-11", "2020-03-19"] },
  boj: { name: "Bank of Japan", code: "boj-interest-rate-decision", currency: "JPY", pair: "USDJPY", zone: "Asia/Tokyo", clock: () => [[11, 0], [15, 0]], unscheduled: ["2020-03-16", "2020-05-22"] },
  rba: { name: "Reserve Bank of Australia", code: "rba-rate-statement", currency: "AUD", pair: "AUDUSD", zone: "Australia/Sydney", clock: () => [[14, 30], [14, 30]], unscheduled: ["2020-03-19"] },
  boc: { name: "Bank of Canada", code: "boc-interest-rate-decision", currency: "CAD", pair: "USDCAD", zone: "America/Toronto", clock: (d) => (d >= "2024-01-01" ? [[9, 45], [9, 45]] : [[10, 0], [10, 0]]), unscheduled: ["2020-03-13", "2020-03-27"] },
  snb: { name: "Swiss National Bank", code: "snb-interest-rate-decision", currency: "CHF", pair: "USDCHF", zone: "Europe/Zurich", clock: () => [[9, 30], [9, 30]], unscheduled: ["2015-01-15"] },
  rbnz: { name: "Reserve Bank of New Zealand", code: "rbnz-interest-rate-decision", currency: "NZD", pair: "NZDUSD", zone: "Pacific/Auckland", clock: (d) => (d >= "2019-01-01" ? [[14, 0], [14, 0]] : [[9, 0], [9, 0]]), unscheduled: ["2020-03-16"], moved: { "2024-10-08": "2024-10-09" } },
};
const dollarSide = (symbol) => (config.symbols[symbol].usdSide === "base" ? 1 : -1);
const OTHER_SEVEN = [BANKS.ecb, BANKS.boe, BANKS.boj, BANKS.rba, BANKS.boc, BANKS.snb, BANKS.rbnz];
const RULES = [
  { name: "FedEveDollar", kind: "eve", banks: [BANKS.fed], pairs: () => PAIRS, side: (symbol) => -dollarSide(symbol) },
  { name: "RbaEveAud", kind: "eve", banks: [BANKS.rba], pairs: () => ["AUDUSD"], side: () => 1 },
  { name: "BocEveCad", kind: "eve", banks: [BANKS.boc], pairs: () => ["USDCAD"], side: () => 1 },
  { name: "FadeIntoDecision", kind: "fade", banks: OTHER_SEVEN, pairs: (bank) => [bank.pair] },
  { name: "FedMorningAfter", kind: "after", banks: [BANKS.fed], pairs: () => PAIRS, devOnly: true },
];

/** Stage 1 on test was run once on 2026-11-22: only the rules that passed it are read on the holdout (TZ 17.32). */
const PASSED_TEST = ["FedEveDollar", "RbaEveAud"];

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function stat(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return { n: xs.length, m, sd, t: xs.length < 3 || sd === 0 ? NaN : m / (sd / Math.sqrt(xs.length)) };
}
/** t by days: the number of a day is the sum of the decisions of that day. */
function tByDays(records, value) {
  const days = new Map();
  for (const r of records) days.set(r.date, (days.get(r.date) ?? 0) + value(r));
  return stat([...days.values()]).t;
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const two = (n) => String(n).padStart(2, "0");
const dayNumber = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400e3;
const dateOf = (day) => new Date(day * 86400e3).toISOString().slice(0, 10);
const weekdayOf = (day) => (day + 4) % 7; // 0 is Sunday

// ------------------------------------------------------------------ clocks
/** The wall clock of a zone at a moment in UTC. */
function clockOf(zone) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (utc) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(utc)).map((x) => [x.type, +x.value]));
    return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, minute: p.hour * 60 + p.minute, asUtc: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) };
  };
}
/** The moment in UTC of a wall-clock time in a zone. */
function momentOf(clock, date, [hh, mm]) {
  const want = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm);
  let utc = want;
  for (let k = 0; k < 3; k++) utc += want - clock(utc).asUtc;
  return utc;
}
const server = clockOf(config.brokerTimeZone);
/** A moment in UTC as a quarter-hour of the server clock. */
const serverSlot = (utc) => { const c = server(utc); return dayNumber(c.date) * 96 + Math.floor(c.minute / 15); };

// ------------------------------------------------------------------ data
const READ_FROM = dateOf(dayNumber(FROM) - 60); // the usual move needs the 20 trading days before the first trade
function load(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  const usdBase = own.usdSide === "base";
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const rows = [], squares = new Map();
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date < READ_FROM) continue;
    if (date > TO) break; // nothing after the end of the set is read
    const hh = +p[1].slice(0, 2), mm = +p[1].slice(3, 5), o = +p[2], day = dayNumber(date), minute = hh * 60 + mm;
    rows.push({ date, day, minute, slot: day * 96 + Math.floor(minute / 15), o, h: +p[3], l: +p[4], spread: Math.max(+p[8], floor) * point });
    if (minute >= 120 && minute < 22 * 60) squares.set(date, (squares.get(date) ?? 0) + Math.log(+p[5] / o) ** 2);
  }
  // The usual move of a day (02:00-22:00) as a share of the price: from the quarter-hour moves of the 20 trading days before.
  const dates = [...squares.keys()], usual = new Map();
  for (let d = 0; d < dates.length; d++) {
    const back = dates.slice(Math.max(0, d - FROZEN.usualDays), d).map((k) => squares.get(k));
    if (back.length >= FROZEN.usualDays / 2) usual.set(dates[d], Math.sqrt(mean(back)));
  }
  const bySlot = new Map(rows.map((b, i) => [b.slot, i]));
  const ok = (b) => b.minute >= 120 && b.minute <= 22 * 60;
  function lower(slot) { let lo = 0, hi = rows.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].slot < slot) lo = mid + 1; else hi = mid; } return lo; }
  return {
    symbol, rows, usual, pip,
    slip: config.costs.slippagePips * pip,
    swapLong: own.swapLongPips * pip, swapShort: own.swapShortPips * pip,
    commissionShare: (o) => (usdBase ? commission : commission / o),
    exact: (slot) => bySlot.get(slot) ?? -1,
    /** The last price between 02:00 and 22:00 at or before the moment, the first at or after it; not further than `reach` quarter-hours. */
    atOrBefore(slot, reach) { let i = lower(slot + 1) - 1; while (i >= 0 && !ok(rows[i])) i--; return i < 0 || slot - rows[i].slot > reach ? -1 : i; },
    atOrAfter(slot, reach) { let i = lower(slot); while (i < rows.length && !ok(rows[i])) i++; return i >= rows.length || rows[i].slot - slot > reach ? -1 : i; },
    /** The first bar after the moment that opens at the given minute of the server day. */
    nextAt(slot, minute, reach) { let i = lower(slot + 1); while (i < rows.length && rows[i].minute !== minute) i++; return i >= rows.length || rows[i].slot - slot > reach ? -1 : i; },
  };
}
const data = new Map(PAIRS.map((s) => [s, load(s)]));

/** Rollovers between two bars: one for the end of every weekday, three for the end of Wednesday. */
function nights(a, b) {
  let n = 0;
  for (let d = a.day; d < b.day; d++) { const wd = weekdayOf(d); if (wd >= 1 && wd <= 5) n += wd === 3 ? 3 : 1; }
  return n;
}

/**
 * One trade from the open of bar i to the open of bar j, the stop watched on every bar between.
 * gross: Bid to Bid, in basis points of the entry price; net: with spread, slippage, commission and swaps; r: net in stops.
 * worst: a stop is filled at the worst price of its quarter-hour (for a trade held through an announcement).
 */
function trade(P, i, j, side, worst = false) {
  const a = P.rows[i], usual = P.usual.get(a.date);
  if (usual === undefined) return null;
  const entry = side > 0 ? a.o + a.spread + P.slip : a.o - P.slip;
  const risk = FROZEN.stopUsualDays * usual * a.o;
  const stop = entry - side * risk;
  let exit = NaN, exitBid = NaN, last = j, stopped = false;
  for (let k = i; k < j && !stopped; k++) {
    const b = P.rows[k];
    if (side > 0 && b.l <= stop) { const bid = worst ? b.l : k > i && b.o < stop ? b.o : stop; exit = bid - P.slip; exitBid = bid; stopped = true; last = k; }
    if (side < 0 && b.h + b.spread >= stop) { const ask = worst ? b.h + b.spread : k > i && b.o + b.spread > stop ? b.o + b.spread : stop; exit = ask + P.slip; exitBid = ask - b.spread; stopped = true; last = k; }
  }
  if (!stopped) { const b = P.rows[j]; exitBid = b.o; exit = side > 0 ? b.o - P.slip : b.o + b.spread + P.slip; }
  const swap = ((side > 0 ? P.swapLong : P.swapShort) * nights(a, P.rows[last])) / a.o;
  const gross = ((side * (exitBid - a.o)) / a.o) * 1e4;
  const net = ((side * (exit - entry)) / a.o - P.commissionShare(a.o) + swap) * 1e4;
  return { pair: P.symbol, side, entryDate: a.date, entryMinute: a.minute, exitDate: P.rows[last].date, gross, net, r: net / ((risk / a.o) * 1e4), stopped };
}

// ------------------------------------------------------------------ the calendar
const buffer = readFileSync(config.calendar.file);
const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
const head = lines[0].split("\t").map((n) => n.replace(/[<>]/g, "").trim());
const col = (n) => head.indexOf(n);
const hasUtc = col("UTC") >= 0, shift = (config.calendar.exportOffsetHours ?? 0) * 3600e3;
/** For every bank: the local dates of its scheduled decisions. */
const decisionDays = new Map(Object.values(BANKS).map((b) => [b, new Set()]));
for (const line of lines.slice(1)) {
  const c = line.split("\t");
  const bank = Object.values(BANKS).find((b) => b.code === c[col("EVENT_CODE")] && b.currency === c[col("CURRENCY")]);
  if (bank === undefined) continue;
  const [date, clock] = hasUtc ? c[col("UTC")].split(" ") : [c[col("DATE")], c[col("TIME")]];
  const utc = Date.parse(`${date.replaceAll(".", "-")}T${clock.slice(0, 5)}:00Z`) - (hasUtc ? 0 : shift);
  let local = clockOf(bank.zone)(utc).date;
  local = bank.moved?.[local] ?? local;
  if (!bank.unscheduled.includes(local)) decisionDays.get(bank).add(local);
}

// ------------------------------------------------------------------ the rules
/** The trades of one rule; shiftDays 0 is the rule itself, 7 and 14 its control. Returns one record a decision: { date, bank, trades }. */
function run(rule, shiftDays) {
  const out = [];
  for (const bank of rule.banks) {
    const days = [...decisionDays.get(bank)].sort(), numbers = days.map(dayNumber), clock = clockOf(bank.zone), pairs = rule.pairs(bank);
    for (const day of days) {
      const local = dateOf(dayNumber(day) + shiftDays);
      if (shiftDays !== 0 && numbers.some((n) => Math.abs(n - dayNumber(local)) <= 2)) continue;
      const [first, lastClock] = bank.clock(local);
      const at = serverSlot(momentOf(clock, local, first)), end = serverSlot(momentOf(clock, local, lastClock)); // the decision by the server clock
      const trades = [];
      for (const symbol of pairs) {
        const P = data.get(symbol);
        const before = P.atOrBefore(at - FROZEN.beforeMinutes / 15, 8); // 15 minutes before the decision (two hours back at most)
        if (before < 0) continue;
        let t = null;
        if (rule.kind === "eve") {
          const entry = P.atOrBefore(P.rows[before].slot - FROZEN.eveHours * 4, 5 * 96);
          if (entry < 0 || entry >= before || P.rows[entry].date < FROM) continue;
          t = trade(P, entry, before, rule.side(symbol));
        } else if (rule.kind === "fade") {
          const start = P.atOrBefore(P.rows[before].slot - FROZEN.fadeBackHours * 4, 5 * 96);
          const exit = P.atOrAfter(end + FROZEN.fadeOutMinutes / 15, 5 * 96);
          if (start < 0 || start >= before || exit < 0 || exit <= before || P.rows[start].date < FROM) continue;
          const moved = Math.sign(P.rows[before].o - P.rows[start].o);
          if (moved === 0) continue;
          t = trade(P, before, exit, -moved, true);
        } else {
          const entry = P.nextAt(at, FROZEN.afterEntryMinute, 4 * 96);
          const exit = entry < 0 ? -1 : P.exact(P.rows[entry].slot + FROZEN.afterHoldMinutes / 15);
          if (entry < 0 || exit < 0 || P.rows[before].date < FROM) continue;
          const dir = Math.sign(P.rows[entry].o - P.rows[before].o);
          if (dir === 0) continue;
          t = trade(P, entry, exit, dir);
        }
        if (t !== null) trades.push(t);
      }
      if (trades.length === pairs.length || (rule.kind === "after" && trades.length >= pairs.length - 1)) out.push({ date: local, bank: bank.name, trades });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

console.log(`${datasetArg} ${FROM} .. ${TO}; basis points of the price; one number a decision = the mean of its pairs; t by days`);
const saved = {};
for (const rule of RULES) {
  if (rule.devOnly && datasetArg !== "dev") { console.log(""); console.log(`=== ${rule.name}: measured on dev only, not frozen, not run on ${datasetArg} ===`); continue; }
  if (datasetArg === "holdout" && !PASSED_TEST.includes(rule.name)) { console.log(""); console.log(`=== ${rule.name}: did not pass stage 1 on test, not run on the holdout ===`); continue; }
  const own = run(rule, 0);
  const control = FROZEN.controlShiftDays.flatMap((d) => run(rule, d));
  const netOf = (e) => mean(e.trades.map((t) => t.net)), grossOf = (e) => mean(e.trades.map((t) => t.gross));
  const net = own.map(netOf), gross = own.map(grossOf), controlGross = control.map(grossOf);
  const all = own.flatMap((e) => e.trades);
  const sn = stat(net), sg = stat(gross), cg = stat(controlGross);
  const welch = (sg.m - cg.m) / Math.sqrt(sg.sd ** 2 / sg.n + cg.sd ** 2 / cg.n);
  console.log(`\n=== ${rule.name} ===`);
  console.log(`decisions ${own.length}, trades ${all.length}, stops ${all.filter((t) => t.stopped).length}`);
  console.log(`before costs ${f(sg.m)} bp a decision (t ${f(tByDays(own, grossOf), 1)});  after costs ${f(sn.m)} bp (t ${f(tByDays(own, netOf), 1)}), above zero in ${net.filter((v) => v > 0).length} of ${net.length};  ${f(mean(all.map((t) => t.r)), 3)} R a trade`);
  console.log(`control (the same trade 7 and 14 days later): windows ${control.length}, before costs ${f(cg.m)} bp (t ${f(tByDays(control, grossOf), 1)}), after costs ${f(mean(control.map(netOf)))} bp;  rule minus control ${f(sg.m - cg.m)} bp (t ${f(welch, 1)})`);
  const years = [...new Set(own.map((e) => e.date.slice(0, 4)))];
  console.log(`by year, after costs: ${years.map((y) => `${y} ${f(mean(own.filter((e) => e.date.startsWith(y)).map(netOf)), 1)} (${own.filter((e) => e.date.startsWith(y)).length})`).join("; ")}`);
  if (rule.banks.length > 1) console.log(`by bank, after costs: ${rule.banks.map((b) => `${b.name} ${f(mean(own.filter((e) => e.bank === b.name).map(netOf)), 1)} (${own.filter((e) => e.bank === b.name).length})`).join("; ")}`);
  else if (rule.pairs(rule.banks[0]).length > 1) console.log(`by pair, after costs: ${rule.pairs(rule.banks[0]).map((p) => `${p} ${f(mean(all.filter((t) => t.pair === p).map((t) => t.net)), 1)}`).join("; ")}`);
  const a = sn.m > 0, b = sg.m > cg.m;
  console.log(`condition (a) after costs above zero: ${a ? "yes" : "NO"};  (b) before costs above the control: ${b ? "yes" : "NO"};  ${a && b ? "PASSED" : "NOT PASSED"}`);
  saved[rule.name] = { decisions: own, controlWindows: control.length, netMean: sn.m, grossMean: sg.m, controlGrossMean: cg.m, passed: a && b };
}
const file = process.argv.find((x) => x.endsWith(".json"));
if (file !== undefined) writeFileSync(file, JSON.stringify({ dataset: datasetArg, from: FROM, to: TO, frozen: FROZEN, rules: saved }, null, 1));
