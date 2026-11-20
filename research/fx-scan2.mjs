// Second scan of the dollar pairs, four more families (TZ 17.23). Dev only.
//   night    fading a stretch away from the 20-bar mean on M15 in the quiet hours
//   narrow   the day after a narrow day: a break of its high or low
//   risk     the S&P 500 day session and the currencies in the Asian hours after it
//   strength the strongest currency against the weakest over the next part of the day
// Measurements before costs with the costs beside them; dates are the unit of counting.
//
// Usage: node research/fx-scan2.mjs night|narrow|risk|strength|all
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const FROM = "2015-02-02", TO = "2021-12-08", MID = "2018-07-01";
const mode = process.argv[2] ?? "all";

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function stat(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return { n: xs.length, m, sd, t: m / (sd / Math.sqrt(Math.max(1, xs.length))) };
}
function byDate(rows, value) {
  const groups = new Map();
  for (const r of rows) { if (!groups.has(r.date)) groups.set(r.date, []); groups.get(r.date).push(value(r)); }
  const st = stat([...groups.values()].map(mean));
  return { n: rows.length, dates: groups.size, m: mean(rows.map(value)), t: st.t };
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const inDev = (date) => date >= FROM && date <= TO;

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
function load(symbol, tf, dir = config.dataDir) {
  const lines = readFileSync(`${dir}/${symbol}_${tf}.csv`, "utf8").split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 8) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break;
    if (tf === "D1") rows.push({ date, o: +p[1], h: +p[2], l: +p[3], c: +p[4], spread: +p[7] });
    else rows.push({ date, hour: +p[1].slice(0, 2), minute: +p[1].slice(3, 5), ms: Date.parse(`${date}T${p[1]}Z`), o: +p[2], h: +p[3], l: +p[4], c: +p[5], spread: +p[8] });
  }
  return rows;
}
function atrBefore(daily) {
  const out = new Map();
  const tr = daily.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - daily[i - 1].c), Math.abs(b.l - daily[i - 1].c))));
  for (let i = 20; i < daily.length; i++) out.set(daily[i].date, mean(tr.slice(i - 20, i)));
  return out;
}

// ---------------------------------------------------------------- night: fading a stretch on M15
function night() {
  console.log("\n== A. Quiet hours, M15: close beyond the band (20 bars, w sigmas) -> trade back to the mean; pips ==");
  console.log("   in at the next open; out at the first close back at the 20-bar mean or after 16 bars; one trade at a time per pair");
  const windows = { "23-02 (rollover)": (h) => h >= 23 || h < 2, "02-08 (Tokyo)": (h) => h >= 2 && h < 8, "08-15 (London am)": (h) => h >= 8 && h < 15, "15-23 (New York)": (h) => h >= 15 && h < 23 };
  for (const width of [2, 2.5, 3]) {
    console.log(`   -- band ${width} sigmas`);
    for (const [wname, test] of Object.entries(windows)) {
      const all = [];
      const perPair = [];
      for (const symbol of PAIRS) {
        const s = spec(symbol);
        const m15 = load(symbol, "M15").filter((b) => b.date >= "2015-01-20");
        const trades = [];
        let sum = 0, sumSq = 0, busyUntil = -1;
        for (let i = 0; i + 17 < m15.length; i++) {
          sum += m15[i].c; sumSq += m15[i].c ** 2;
          if (i >= 20) { sum -= m15[i - 20].c; sumSq -= m15[i - 20].c ** 2; }
          if (i < 19 || i <= busyUntil || !inDev(m15[i].date) || !test(m15[i].hour)) continue;
          const ma = sum / 20, sd = Math.sqrt(Math.max(0, sumSq / 20 - ma * ma));
          if (sd === 0) continue;
          const dev = (m15[i].c - ma) / sd;
          if (Math.abs(dev) < width) continue;
          // No trade over a hole in the data (weekend).
          if (m15[i + 16].ms - m15[i].ms > 16 * 15 * 60e3 + 1) continue;
          const dir = -Math.sign(dev);
          const entry = m15[i + 1].o;
          let exit = m15[i + 16].c, held = 16, s2 = sum, q2 = sumSq;
          for (let j = i + 1; j <= i + 16; j++) {
            s2 += m15[j].c - m15[j - 20].c;
            const ma2 = s2 / 20;
            if ((dir > 0 && m15[j].c >= ma2) || (dir < 0 && m15[j].c <= ma2)) { exit = m15[j].c; held = j - i; break; }
          }
          busyUntil = i + held;
          trades.push({ date: m15[i].date, pips: (dir * (exit - entry)) / s.pip, cost: costOf(s, m15[i + 1]) / s.pip, first: m15[i].date < MID });
        }
        all.push(...trades);
        perPair.push(`${symbol.slice(0, 6)} ${f(mean(trades.map((x) => x.pips)), 1)}/${mean(trades.map((x) => x.cost)).toFixed(1)}`);
      }
      const r = byDate(all, (x) => x.pips);
      const win = all.filter((x) => x.pips > 0).length / all.length;
      console.log(`   ${pad(wname, 18)} trades ${lpad(all.length, 6)} (${(all.length / 82).toFixed(0)} a month)  move ${f(r.m, 2)} (t ${f(r.t, 1)})  cost ${mean(all.map((x) => x.cost)).toFixed(2)}  wins ${(win * 100).toFixed(0)}%  halves ${f(mean(all.filter((x) => x.first).map((x) => x.pips)), 2)} / ${f(mean(all.filter((x) => !x.first).map((x) => x.pips)), 2)} | move/cost by pair: ${perPair.join(", ")}`);
    }
  }
}

// ---------------------------------------------------------------- narrow day
function narrow() {
  console.log("\n== B. The day after a narrow day: stop orders at its high and low, first one filled is the trade, out at 23:00 server; % of ATR ==");
  const rows = [];
  for (const symbol of PAIRS) {
    const s = spec(symbol);
    const daily = load(symbol, "D1");
    const atr = atrBefore(daily);
    const hours = new Map();
    for (const b of load(symbol, "H1")) { if (!hours.has(b.date)) hours.set(b.date, []); hours.get(b.date).push(b); }
    for (let i = 21; i + 1 < daily.length; i++) {
      const d = daily[i], next = daily[i + 1];
      if (!inDev(next.date) || !atr.has(next.date)) continue;
      const a = atr.get(next.date);
      const ranges = daily.slice(i - 6, i + 1).map((b) => b.h - b.l);
      const nr7 = ranges[6] <= Math.min(...ranges.slice(0, 6));
      const nr4 = ranges[6] <= Math.min(...ranges.slice(3, 6));
      const inside = d.h <= daily[i - 1].h && d.l >= daily[i - 1].l;
      const bars = (hours.get(next.date) ?? []).filter((b) => b.hour >= 2 && b.hour <= 22);
      let dir = 0, entry = NaN, cost = NaN;
      for (const b of bars) {
        const up = b.h > d.h, down = b.l < d.l;
        if (up && down) { dir = 0; break; } // both in one hour: unknown order, skipped
        if (up) { dir = 1; entry = Math.max(d.h, b.o); cost = costOf(s, b); break; }
        if (down) { dir = -1; entry = Math.min(d.l, b.o); cost = costOf(s, b); break; }
      }
      const last = (hours.get(next.date) ?? []).find((b) => b.hour === 23);
      if (dir === 0 || last === undefined) continue;
      rows.push({ symbol, date: next.date, first: next.date < MID, pay: ((dir * (last.o - entry)) / a) * 100, cost: (cost / a) * 100, nr7, nr4, inside, rel: ranges[6] / a });
    }
  }
  const line = (label, xs) => { const r = byDate(xs, (x) => x.pay); console.log(`   ${pad(label, 26)} trades ${lpad(xs.length, 5)} (${(xs.length / 82).toFixed(1)} a month)  move ${f(r.m)} (t ${f(r.t, 1)})  cost ${mean(xs.map((x) => x.cost)).toFixed(2)}  halves ${f(mean(xs.filter((x) => x.first).map((x) => x.pay)))} / ${f(mean(xs.filter((x) => !x.first).map((x) => x.pay)))}  pairs+ ${PAIRS.filter((p) => mean(xs.filter((x) => x.symbol === p).map((x) => x.pay)) > 0).length}/7`); };
  line("every day (control)", rows);
  line("narrowest of 7 days", rows.filter((x) => x.nr7));
  line("narrowest of 4 days", rows.filter((x) => x.nr4));
  line("inside day", rows.filter((x) => x.inside));
  line("inside and narrowest of 4", rows.filter((x) => x.inside && x.nr4));
  line("range under 0.6 ATR", rows.filter((x) => x.rel < 0.6));
  line("range over 1.4 ATR", rows.filter((x) => x.rel > 1.4));
}

// ---------------------------------------------------------------- risk: S&P 500 and the currencies after it
function risk() {
  console.log("\n== C. S&P 500 day session (server 16:00-23:00) -> currencies afterwards, in the risk direction; % of ATR ==");
  console.log("   risk direction: AUD, NZD, CAD up and JPY, CHF down against the dollar when shares rise; EUR and GBP counted as risk currencies too");
  const spx = new Map();
  for (const b of load("US500", "H1")) { if (!spx.has(b.date)) spx.set(b.date, new Map()); spx.get(b.date).set(b.hour, b); }
  const sessions = [];
  for (const [date, m] of spx) {
    if (!inDev(date) || date < "2016-03-01" || !m.has(16) || !m.has(22)) continue;
    sessions.push({ date, ret: Math.log(m.get(22).c / m.get(16).o) });
  }
  const abs = sessions.map((x) => Math.abs(x.ret)).sort((a, b) => a - b);
  const third = abs[Math.floor(abs.length * 2 / 3)], tenth = abs[Math.floor(abs.length * 0.9)];
  const sign = { EURUSD: 1, GBPUSD: 1, AUDUSD: 1, NZDUSD: 1, USDJPY: 1, USDCAD: -1, USDCHF: -1 };
  for (const symbol of PAIRS) {
    const s = spec(symbol);
    const atr = atrBefore(load(symbol, "D1"));
    const hours = new Map();
    for (const b of load(symbol, "H1")) { if (!hours.has(b.date)) hours.set(b.date, new Map()); hours.get(b.date).set(b.hour, b); }
    const dates = [...hours.keys()].sort();
    const rows = [];
    for (const sess of sessions) {
      const k = dates.indexOf(sess.date);
      const nextDate = dates[k + 1];
      if (k < 0 || nextDate === undefined) continue;
      const n = hours.get(nextDate);
      if (!n.has(2) || !n.has(9) || !n.has(23) || !atr.has(nextDate)) continue;
      const a = atr.get(nextDate);
      const dir = Math.sign(sess.ret) * sign[symbol];
      rows.push({ date: nextDate, big: Math.abs(sess.ret) >= third, huge: Math.abs(sess.ret) >= tenth, asia: ((dir * (n.get(9).o - n.get(2).o)) / a) * 100, day: ((dir * (n.get(23).o - n.get(2).o)) / a) * 100, cost: (costOf(s, n.get(2)) / a) * 100 });
    }
    const cell = (xs, key) => { const st = stat(xs.map((x) => x[key])); return `${lpad(f(st.m), 6)} (t ${f(st.t, 1)})`; };
    console.log(`   ${pad(symbol, 7)} cost ${mean(rows.map((x) => x.cost)).toFixed(2)} | all ${rows.length}: asia ${cell(rows, "asia")} day ${cell(rows, "day")} | top third ${rows.filter((x) => x.big).length}: asia ${cell(rows.filter((x) => x.big), "asia")} day ${cell(rows.filter((x) => x.big), "day")} | top tenth: asia ${cell(rows.filter((x) => x.huge), "asia")} day ${cell(rows.filter((x) => x.huge), "day")}`);
  }
}

// ---------------------------------------------------------------- strength: strongest against weakest
function strength() {
  console.log("\n== D. Currency strength: at a mark hour buy the strongest currency against the weakest (as measured over the hours before), hold to the next mark; basis points ==");
  console.log("   the pair is made of two dollar legs unless one side is the dollar; cost = the legs it needs; plus = the strong one went on rising");
  const CUR = { EUR: ["EURUSD", false], GBP: ["GBPUSD", false], AUD: ["AUDUSD", false], NZD: ["NZDUSD", false], JPY: ["USDJPY", true], CAD: ["USDCAD", true], CHF: ["USDCHF", true] };
  const hours = new Map();
  for (const symbol of PAIRS) { const m = new Map(); for (const b of load(symbol, "H1")) { if (!m.has(b.date)) m.set(b.date, new Map()); m.get(b.date).set(b.hour, b); } hours.set(symbol, m); }
  const dates = [...hours.get("EURUSD").keys()].filter(inDev).sort();
  const setups = [["00->09 then 09->15", 0, 9, 15], ["00->09 then 09->23", 0, 9, 23], ["00->15 then 15->23", 0, 15, 23], ["09->15 then 15->23", 9, 15, 23], ["00->19 then 19->23", 0, 19, 23], ["prev day then 02->23", -1, 2, 23], ["prev day then 02->09", -1, 2, 9]];
  for (const [name, from, mark, to] of setups) {
    const rows = [];
    for (let di = 1; di < dates.length; di++) {
      const date = dates[di];
      const value = {}, cost = {}, later = {};
      let ok = true;
      for (const [cur, [pair, inverse]] of Object.entries(CUR)) {
        const today = hours.get(pair).get(date), prev = hours.get(pair).get(dates[di - 1]);
        const start = from === -1 ? prev?.get(0) : today?.get(from);
        const mid = today?.get(mark), end = today?.get(to);
        if (start === undefined || mid === undefined || end === undefined) { ok = false; break; }
        const sgn = inverse ? -1 : 1;
        value[cur] = sgn * Math.log(mid.o / start.o);
        later[cur] = sgn * Math.log(end.o / mid.o);
        cost[cur] = (costOf(spec(pair), mid) / mid.o) * 1e4;
      }
      if (!ok) continue;
      value.USD = 0; later.USD = 0; cost.USD = 0;
      // Strength of a currency: its mean move against the other seven.
      const names = Object.keys(value);
      const total = names.reduce((a, c) => a + value[c], 0);
      const str = Object.fromEntries(names.map((c) => [c, (value[c] * 8 - total) / 7]));
      const sorted = names.slice().sort((a, b) => str[b] - str[a]);
      const top = sorted[0], bottom = sorted[7];
      rows.push({ date, first: date < MID, pay: (later[top] - later[bottom]) * 1e4, cost: cost[top] + cost[bottom], spread: (str[top] - str[bottom]) * 1e4, usdLeg: top === "USD" || bottom === "USD" });
    }
    const r = stat(rows.map((x) => x.pay));
    const sp = rows.map((x) => x.spread).sort((a, b) => a - b);
    const wide = rows.filter((x) => x.spread >= sp[Math.floor(sp.length * 0.75)]);
    const w = stat(wide.map((x) => x.pay));
    console.log(`   ${pad(name, 22)} days ${rows.length}  move ${f(r.m, 1)} (t ${f(r.t, 1)})  cost ${mean(rows.map((x) => x.cost)).toFixed(1)}  halves ${f(mean(rows.filter((x) => x.first).map((x) => x.pay)), 1)} / ${f(mean(rows.filter((x) => !x.first).map((x) => x.pay)), 1)} | widest quarter of days: ${f(w.m, 1)} (t ${f(w.t, 1)}) halves ${f(mean(wide.filter((x) => x.first).map((x) => x.pay)), 1)} / ${f(mean(wide.filter((x) => !x.first).map((x) => x.pay)), 1)}`);
  }
}

if (mode === "night" || mode === "all") night();
if (mode === "narrow" || mode === "all") narrow();
if (mode === "risk" || mode === "all") risk();
if (mode === "strength" || mode === "all") strength();
