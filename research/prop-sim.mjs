// Would the confirmed rule Rsi2ReversionIndexD1 pass a prop-firm challenge? (TZ 17.45)
// No rule is searched or changed here: the trades are the saved ones of TZ 17.12
// (dev, test, holdout; read from reports/, nothing is rerun) and the Nasdaq run
// of TZ 17.18 (npx tsx research/new-instrument.ts ndx reports/dev/ndx-rsi2-trades.json).
// The challenge is FundedNext Stellar 2-Step as read on its site on 2026-11-23:
// +8% then +5% of the initial balance, daily loss 5%, maximum loss 10% (static),
// five separate days with a trade in each phase, no time limit, the account
// expires after 30 calendar days without a trade.
// Usage: node research/prop-sim.mjs
import { existsSync, readFileSync } from "node:fs";
import { DateTime } from "luxon";

const SAVED = [
  "reports/dev/2026-11-19_13-38-47_Rsi2ReversionIndexD1/trades.csv",
  "reports/test/2026-11-19_14-15-32_Rsi2ReversionIndexD1/trades.csv",
  "reports/holdout/2026-11-19_14-19-16_Rsi2ReversionIndexD1/trades.csv",
];
const NASDAQ = "reports/dev/ndx-rsi2-trades.json";
const ZONE = "Europe/Athens";
const DAY = 86_400_000;

// The grid is fixed before the run; no risk is picked as "the best" afterwards.
const RISKS = [0.5, 1, 1.5, 2, 3];
const CHALLENGE = { targets: [8, 5], dailyLoss: 5, maxLoss: 10, minDays: 5, idleDays: 30 };
const NEW_DATA_FROM = Date.UTC(2021, 11, 9);

function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  const head = rows[0];
  return rows.slice(1).filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const dayOf = (ms) => DateTime.fromMillis(ms, { zone: ZONE }).toISODate();

function loadTrades() {
  const trades = [];
  for (const file of SAVED) {
    for (const r of parseCsv(readFileSync(file, "utf8"))) {
      trades.push({ symbol: r.symbol, entry: Date.parse(r.entry_utc), exit: Date.parse(r.exit_utc), r: Number(r.r), mae: Number(r.mae_r) });
    }
  }
  const three = trades.length;
  if (existsSync(NASDAQ)) {
    for (const t of JSON.parse(readFileSync(NASDAQ, "utf8"))) {
      trades.push({ symbol: "NDX", entry: t.entryTime, exit: t.exitTime, r: t.rMultiple, mae: t.maeR });
    }
  }
  for (const t of trades) {
    if (!Number.isFinite(t.entry) || !Number.isFinite(t.exit) || !Number.isFinite(t.r) || !Number.isFinite(t.mae)) throw new Error("bad trade record");
    t.entryDay = dayOf(t.entry);
    t.exitDay = dayOf(t.exit);
  }
  trades.sort((a, b) => a.entry - b.entry || a.exit - b.exit);
  return { trades, three };
}

/**
 * One phase from `from`: every trade entered at or after it is taken, the
 * balance is counted in percent of the initial one, each trade risks `risk`
 * percent. The floating loss is charged conservatively: every open trade is
 * held at its own worst point (MAE) all the time it is open.
 */
function phase(trades, from, risk, target) {
  const mine = trades.filter((t) => t.entry >= from);
  const events = [];
  for (const t of mine) { events.push({ at: t.entry, kind: 0, t }); events.push({ at: t.exit, kind: 1, t }); }
  events.sort((a, b) => a.at - b.at || b.kind - a.kind); // exits before entries at the same moment
  let realised = 0, lastTradeDay = from, idle = false;
  const open = new Set(), days = new Set(), lossByDay = new Map();
  for (const e of events) {
    if (e.kind === 0) {
      if (e.at - lastTradeDay > CHALLENGE.idleDays * DAY) idle = true;
      lastTradeDay = e.at;
      open.add(e.t);
      days.add(e.t.entryDay);
      let floating = 0;
      for (const o of open) floating += Math.min(o.mae, 1.1) * risk;
      if (realised - floating <= -CHALLENGE.maxLoss) return { end: "maxLoss", at: e.at, idle };
    } else {
      open.delete(e.t);
      realised += e.t.r * risk;
      if (e.t.r < 0) {
        const loss = (lossByDay.get(e.t.exitDay) ?? 0) - e.t.r * risk;
        lossByDay.set(e.t.exitDay, loss);
        if (loss >= CHALLENGE.dailyLoss) return { end: "dailyLoss", at: e.at, idle };
      }
      if (realised <= -CHALLENGE.maxLoss) return { end: "maxLoss", at: e.at, idle };
      if (realised >= target && days.size >= CHALLENGE.minDays) return { end: "pass", at: e.at, idle, trades: days.size };
    }
  }
  return { end: "open", at: null, idle };
}

function attempt(trades, start, risk) {
  const first = phase(trades, start, risk, CHALLENGE.targets[0]);
  if (first.end !== "pass") return { end: first.end === "open" ? "open" : "fail", why: first.end, idle: first.idle, phase: 1 };
  const second = phase(trades, first.at + 1, risk, CHALLENGE.targets[1]);
  if (second.end !== "pass") return { end: second.end === "open" ? "open" : "fail", why: second.end, idle: first.idle || second.idle, phase: 2, firstDays: (first.at - start) / DAY };
  return { end: "pass", idle: first.idle || second.idle, firstDays: (first.at - start) / DAY, days: (second.at - start) / DAY };
}

const quantile = (values, q) => {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const months = (days) => (Number.isFinite(days) ? (days / 30.44).toFixed(0) : "-");
const pct = (n, of) => (of === 0 ? "-" : `${((100 * n) / of).toFixed(0)}%`);

function monthlyStarts(from, to) {
  const out = [];
  let d = DateTime.fromMillis(from, { zone: "utc" }).startOf("month");
  if (d.toMillis() < from) d = d.plus({ months: 1 });
  for (; d.toMillis() <= to; d = d.plus({ months: 1 })) out.push(d.toMillis());
  return out;
}

function describe(name, trades) {
  const first = trades[0].entry, last = trades[trades.length - 1].exit;
  const years = (last - first) / DAY / 365.25;
  const sum = trades.reduce((a, t) => a + t.r, 0);
  // Worst day by exits, worst run of the balance, most positions at once, gaps between entries.
  const byDay = new Map();
  for (const t of trades) if (t.r < 0) byDay.set(t.exitDay, (byDay.get(t.exitDay) ?? 0) + t.r);
  const worstDay = Math.min(0, ...byDay.values());
  let peak = 0, bal = 0, dd = 0;
  for (const t of [...trades].sort((a, b) => a.exit - b.exit)) { bal += t.r; peak = Math.max(peak, bal); dd = Math.max(dd, peak - bal); }
  let most = 0;
  for (const t of trades) most = Math.max(most, trades.filter((o) => o.entry <= t.entry && o.exit > t.entry).length);
  const entries = [...new Set(trades.map((t) => t.entry))].sort((a, b) => a - b);
  const gaps = entries.slice(1).map((e, i) => (e - entries[i]) / DAY);
  console.log(`\n== ${name}`);
  console.log(`trades ${trades.length}, ${dayOf(first)} .. ${dayOf(last)}, ${years.toFixed(1)} years, ${(trades.length / years).toFixed(1)} a year; mean R ${(sum / trades.length).toFixed(3)}, sum ${sum.toFixed(1)} R, ${(sum / years).toFixed(1)} R a year`);
  console.log(`worst day by exits ${worstDay.toFixed(2)} R; worst fall of the balance ${dd.toFixed(1)} R; most positions at once ${most}`);
  console.log(`gaps between entries: longest ${Math.max(...gaps).toFixed(0)} days, longer than 30 days ${gaps.filter((g) => g > 30).length} of ${gaps.length}, median ${quantile(gaps, 0.5).toFixed(0)} days`);
  return { first, last, years, perYear: trades.length / years };
}

function walk(name, trades, from) {
  const info = describe(name, trades);
  const starts = monthlyStarts(from ?? info.first, info.last);
  console.log(`attempts: one started on the first day of each month, ${starts.length} in all`);
  console.log("risk%\tpassed\tfailed\tnot finished\tmedian months\tslowest 10% from\tphase 1 median\tfails: max loss / daily\tneeded a keep-alive trade");
  for (const risk of RISKS) {
    const res = starts.map((s) => attempt(trades, s, risk));
    const passed = res.filter((r) => r.end === "pass"), failed = res.filter((r) => r.end === "fail"), open = res.filter((r) => r.end === "open");
    const days = passed.map((r) => r.days);
    console.log([
      risk,
      `${passed.length} (${pct(passed.length, res.length)})`,
      `${failed.length} (${pct(failed.length, res.length)})`,
      `${open.length} (${pct(open.length, res.length)})`,
      months(quantile(days, 0.5)),
      months(quantile(days, 0.9)),
      months(quantile(res.filter((r) => r.firstDays !== undefined).map((r) => r.firstDays), 0.5)),
      `${failed.filter((r) => r.why === "maxLoss").length} / ${failed.filter((r) => r.why === "dailyLoss").length}`,
      pct(res.filter((r) => r.idle).length, res.length),
    ].join("\t"));
  }
  return info;
}

// A second view without the calendar: trades drawn at random with replacement,
// so losses do not come in the runs they came in (2018). Realised balance only.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleView(name, trades, perYear) {
  const rs = trades.map((t) => t.r), rand = mulberry32(1), DRAWS = 20_000, CAP = 2_000;
  console.log(`\n-- ${name}: trades drawn at random, ${DRAWS} draws, ${perYear.toFixed(1)} trades a year`);
  console.log("risk%\tpassed both\tfailed\tmedian trades\tmedian months\tslowest 10% from, months");
  for (const risk of RISKS) {
    let pass = 0;
    const counts = [];
    for (let d = 0; d < DRAWS; d++) {
      let n = 0, ok = true;
      for (const target of CHALLENGE.targets) {
        let bal = 0, k = 0;
        while (bal < target || k < CHALLENGE.minDays) {
          bal += rs[Math.floor(rand() * rs.length)] * risk;
          k++; n++;
          if (bal <= -CHALLENGE.maxLoss || n > CAP) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (ok) { pass++; counts.push(n); }
    }
    const med = quantile(counts, 0.5), slow = quantile(counts, 0.9);
    console.log([risk, pct(pass, DRAWS), pct(DRAWS - pass, DRAWS), med, ((med / perYear) * 12).toFixed(0), ((slow / perYear) * 12).toFixed(0)].join("\t"));
  }
}

const { trades, three } = loadTrades();
console.log(`saved trades of TZ 17.12: ${three}; Nasdaq of TZ 17.18: ${trades.length - three}`);
console.log(`challenge: +${CHALLENGE.targets[0]}% then +${CHALLENGE.targets[1]}%, daily loss ${CHALLENGE.dailyLoss}%, maximum loss ${CHALLENGE.maxLoss}%, ${CHALLENGE.minDays} days with a trade in a phase, expiry after ${CHALLENGE.idleDays} days without a trade`);

const small = trades.filter((t) => t.symbol !== "NDX");
const a = walk("A. Saved runs only (US500, US2000, US30 while its lot fitted): what a small account trades", small);
shuffleView("A", small, a.perYear);

const recent = trades.filter((t) => t.entry >= NEW_DATA_FROM);
const b = walk("B. From 2021-12-09 with Nasdaq: data the rule had not seen, an account large enough for the Nasdaq lot", recent, NEW_DATA_FROM);
shuffleView("B", recent, b.perYear);
