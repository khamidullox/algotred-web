// Do the weekly reports on the positions of large traders say where a currency
// goes next? (TZ 17.28.) The CFTC publishes, for every currency future, how
// many contracts each kind of trader holds long and short as of Tuesday. The
// report comes out on Friday evening, after a holiday on Monday.
//
// Three kinds of trader: leveraged funds and asset managers (the report
// "Traders in Financial Futures") and non-commercial traders (the older
// "legacy" report). Three readings of each: follow the side they hold, follow
// the change of the week, go against a three-year extreme. Nine rules, two
// reference rows (the price trend of four weeks, always long the currency).
// Then the one row that stands out is taken apart (its mirror, the price alone,
// the size of the change), and a by-product is counted: going against the
// price move of the week just ended, by the days held.
//
// Nothing from the future: the report as of the Tuesday of week w-1 is traded
// from the Tuesday of week w, 03:00 server time, for one week. That is after
// the release even in a week with a holiday. The reports that came out late
// because of the government shutdown (as of 2018-12-24 .. 2019-02-26) are not
// traded. A position kept for another week pays no new costs, only the swap.
//
// The result of a week is in daily ATRs of the pair and in pips. t is counted
// over weeks, the seven pairs of a week summed (they share the dollar).
// The control with no idea: the same positions moved in time by every shift
// from half a year, the same for all pairs - the same share of longs and
// shorts and the same runs, only the timing is lost.
//
// Seven dollar pairs, the costs of the project, dev only: neither prices nor
// reports after the end of dev are read.
//
// Data: https://www.cftc.gov/files/dea/history/fut_fin_txt_YYYY.zip and
// deacotYYYY.zip, unpacked into data/raw/cot/<name>/ (not in git).
//
// Usage: node research/fx-cot.mjs
//        node research/fx-cot.mjs crowd    the small traders of the old report, traded against (TZ 17.42)
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const FROM = "2015-02-02", TO = "2021-12-08", SPLIT = "2019-01-01";
const COT_DIR = `${config.dataDir}/cot`;
const YEARS = [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019, 2020, 2021];
// The future is the foreign currency against the dollar: sign -1 where the dollar is the base of the pair.
const MARKETS = {
  EURUSD: { code: "099741", sign: 1 }, GBPUSD: { code: "096742", sign: 1 }, USDJPY: { code: "097741", sign: -1 },
  AUDUSD: { code: "232741", sign: 1 }, NZDUSD: { code: "112741", sign: 1 }, USDCAD: { code: "090741", sign: -1 }, USDCHF: { code: "092741", sign: -1 },
};
const PAIRS = Object.keys(MARKETS);
const LATE = ["2018-12-24", "2019-02-26"]; // reports released weeks late (government shutdown)
const LOOKBACK = 156;  // weeks of history for an extreme
const EXTREME = 0.9;   // the top and the bottom tenth of that history
const ENTRY_HOUR = 3;  // server time, after the rollover hours
const MIN_SHIFT = 26;  // weeks: the smallest shift of the control

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f = (x, d = 3) => (!Number.isFinite(x) ? "  n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const weekOf = (date) => Math.floor((Date.parse(`${date}T00:00:00Z`) / 86400e3 + 3) / 7); // weeks start on Monday
const months = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.44);
const W0 = weekOf(FROM), W = weekOf(TO) - W0 + 1;

// ------------------------------------------------------------------ prices
function load(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const date = [], o = [], cost = [], hour = [], days = [];
  const minSpread = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const d = p[0].replaceAll(".", "-");
    if (d > TO) break; // nothing after dev is read
    const hi = +p[3], lo = +p[4], cl = +p[5];
    date.push(d); hour.push(+p[1].slice(0, 2)); o.push(+p[2]);
    // One round trip as a price distance: spread (not below the floor), slippage on two fills, commission.
    cost.push(Math.max(+p[8], minSpread) * point + 2 * config.costs.slippagePips * pip + (own.usdSide === "base" ? commission * cl : commission));
    const last = days[days.length - 1];
    if (last === undefined || last.date !== d) days.push({ date: d, h: hi, l: lo, c: cl }); else { last.h = Math.max(last.h, hi); last.l = Math.min(last.l, lo); last.c = cl; }
  }
  const n = date.length;
  // Swap nights charged before each bar: one a night, three after a Wednesday.
  const nights = new Array(n).fill(0);
  for (let i = 1; i < n; i++) nights[i] = nights[i - 1] + (date[i] === date[i - 1] ? 0 : weekday(date[i - 1]) === 3 ? 3 : 1);
  // The daily ATR(20) known at the open of a day.
  const atrOfDay = new Map();
  let sum = 0;
  const tr = days.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - days[i - 1].c), Math.abs(b.l - days[i - 1].c))));
  for (let i = 0; i < days.length; i++) {
    if (i >= 20) atrOfDay.set(days[i].date, sum / 20); // the twenty days before this one
    sum += tr[i];
    if (i >= 20) sum -= tr[i - 20];
  }
  // The bar that opens the trading week: the first one from Tuesday 03:00 server time.
  // `asof` is the first bar of Wednesday, server time: Tuesday 17:00 in New York, the moment the report describes.
  const entry = new Array(W + 1).fill(undefined), asof = new Array(W + 1).fill(undefined);
  for (let i = 0; i < n; i++) {
    const w = weekOf(date[i]) - W0, dow = weekday(date[i]);
    if (w < 0 || w > W) continue;
    if (entry[w] === undefined && (dow > 2 || (dow === 2 && hour[i] >= ENTRY_HOUR))) entry[w] = i;
    if (asof[w] === undefined && dow > 2) asof[w] = i;
  }
  return { symbol, pip, date, hour, o, cost, nights, atrOfDay, entry, asof, exits: new Map(), swapLong: own.swapLongPips * pip, swapShort: own.swapShortPips * pip };
}
const markets = new Map(PAIRS.map((p) => [p, load(p)]));
/** The bar that closes the trade of week w: the next entry bar for a week held, else the first bar `days` days later at the entry hour. */
function exitBar(m, w, days) {
  if (days === 7) return m.entry[w + 1];
  if (!m.exits.has(days)) {
    m.exits.set(days, m.entry.map((e) => {
      if (e === undefined) return undefined;
      const target = new Date(Date.parse(m.date[e] + "T00:00:00Z") + days * 86400e3).toISOString().slice(0, 10);
      for (let i = e + 1; i < m.date.length; i++) if (m.date[i] > target || (m.date[i] === target && m.hour[i] >= ENTRY_HOUR)) return i;
      return undefined;
    }));
  }
  return m.exits.get(days)[w];
}

// ------------------------------------------------------------------ the reports
function splitCsv(line) {
  const out = [];
  let cur = "", quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted; else if (ch === "," && !quoted) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const codes = new Set(Object.values(MARKETS).map((m) => m.code));
const anyCode = new RegExp(`,\\s*(${[...codes].join("|")})\\s*,`);
/** Reads one family of yearly files. `cols` maps a field to [column, the header expected there]. Returns code -> week -> row. */
function readReports(prefix, file, cols) {
  const out = new Map([...codes].map((c) => [c, new Map()]));
  for (const y of YEARS) {
    const lines = readFileSync(`${COT_DIR}/${prefix}${y}/${file}`, "utf8").split(/\r?\n/);
    const head = splitCsv(lines[0]);
    for (const [name, [col, expected]] of Object.entries(cols)) if (norm(head[col] ?? "") !== expected) throw new Error(`${prefix}${y}: column ${col} is "${head[col]}", expected ${expected} (${name})`);
    for (let i = 1; i < lines.length; i++) {
      if (!anyCode.test(lines[i])) continue;
      const p = splitCsv(lines[i]);
      const code = p[cols.code[0]];
      if (!codes.has(code)) continue;
      const ymd = p[cols.date[0]].padStart(6, "0");
      if (!/^\d{6}$/.test(ymd)) throw new Error(`${prefix}${y}: date "${p[cols.date[0]]}"`);
      const date = `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`;
      if (date > TO) continue; // nothing after dev is read
      const row = { date };
      for (const [name, [col]] of Object.entries(cols)) if (name !== "code" && name !== "date") row[name] = +p[col];
      out.get(code).set(weekOf(date), row);
    }
  }
  return out;
}
const tff = readReports("fut_fin_txt_", "FinFutYY.txt", {
  date: [1, "asofdateinformyymmdd"], code: [3, "cftccontractmarketcode"], oi: [7, "openinterestall"],
  amLong: [11, "assetmgrpositionslongall"], amShort: [12, "assetmgrpositionsshortall"], levLong: [14, "levmoneypositionslongall"], levShort: [15, "levmoneypositionsshortall"],
});
const legacy = readReports("deacot", "annual.txt", {
  date: [1, "asofdateinformyymmdd"], code: [3, "cftccontractmarketcode"], oi: [7, "openinterestall"],
  ncLong: [8, "noncommercialpositionslongall"], ncShort: [9, "noncommercialpositionsshortall"],
  // Traders too small to be reported one by one: the "crowd" of the futures market (TZ 17.42).
  nrLong: [15, "nonreportablepositionslongall"], nrShort: [16, "nonreportablepositionsshortall"],
});

// ------------------------------------------------------------------ the rules
const GROUPS = { lev: "leveraged funds", am: "asset managers", nc: "non-commercial (old report)" };
const KINDS = { level: "follow the side they hold", change: "follow the change of the week", extreme: "against a 3-year extreme" };
/** The net position of a group as a share of the open interest, week by week: code -> [{ week, date, net }]. */
function netSeries(group) {
  const src = group === "nc" || group === "nr" ? legacy : tff;
  const out = new Map();
  for (const code of codes) {
    const rows = [...src.get(code).entries()].sort((a, b) => a[0] - b[0]);
    out.set(code, rows.map(([week, r]) => ({ week, date: r.date, net: (r[`${group}Long`] - r[`${group}Short`]) / r.oi })));
  }
  return out;
}
/** The position of every trading week, in the direction of the pair: symbol -> Int8Array(W). */
function positions(group, kind) {
  const series = netSeries(group);
  const out = new Map();
  for (const symbol of PAIRS) {
    const { code, sign } = MARKETS[symbol];
    const s = series.get(code), pos = new Int8Array(W);
    for (let k = 0; k < s.length; k++) {
      const w = s[k].week + 1 - W0; // traded in the week after the report
      if (w < 0 || w >= W) continue;
      if (s[k].date >= LATE[0] && s[k].date <= LATE[1]) continue;
      let dir = 0;
      if (kind === "level") dir = Math.sign(s[k].net);
      else if (kind === "change") { if (k > 0 && s[k - 1].week === s[k].week - 1) dir = Math.sign(s[k].net - s[k - 1].net); }
      else {
        const from = Math.max(0, k - LOOKBACK + 1);
        if (k - from + 1 < LOOKBACK * 0.9) continue;
        let below = 0, above = 0;
        for (let j = from; j < k; j++) { if (s[j].net < s[k].net) below++; else if (s[j].net > s[k].net) above++; }
        // Higher than nine tenths of the weeks before: the group is extremely long, the rule sells (and the mirror).
        dir = below / (k - from) >= EXTREME ? -1 : above / (k - from) >= EXTREME ? 1 : 0;
      }
      pos[w] = dir * sign;
    }
    out.set(symbol, pos);
  }
  return out;
}
function reference(kind) {
  const out = new Map();
  for (const symbol of PAIRS) {
    const m = markets.get(symbol), pos = new Int8Array(W);
    for (let w = 0; w < W; w++) {
      if (kind === "long") pos[w] = MARKETS[symbol].sign;
      else if (kind === "trend") { if (w >= 4 && m.entry[w] !== undefined && m.entry[w - 4] !== undefined) pos[w] = Math.sign(m.o[m.entry[w]] - m.o[m.entry[w - 4]]); }
      // The price move of the week the report describes, traded when the report is: one week later.
      else if (kind === "reportWeek") { if (w >= 2 && m.asof[w - 1] !== undefined && m.asof[w - 2] !== undefined) pos[w] = Math.sign(m.o[m.asof[w - 1]] - m.o[m.asof[w - 2]]); }
      // The price move of the week just ended, Tuesday to Tuesday.
      else if (w >= 1 && m.entry[w] !== undefined && m.entry[w - 1] !== undefined) pos[w] = Math.sign(m.o[m.entry[w]] - m.o[m.entry[w - 1]]);
    }
    out.set(symbol, pos);
  }
  return out;
}
/**
 * Leveraged funds, the change of the week, taken apart. `keep` sees { size, price }: `size` is the
 * share of the changes of the 156 weeks before that were smaller, `price` is +1 when the price of the
 * report week moved the way the funds changed their position, -1 when against. `flip` -1 trades against.
 */
function levChange(keep, flip = 1) {
  const series = netSeries("lev");
  const out = new Map();
  for (const symbol of PAIRS) {
    const { code, sign } = MARKETS[symbol];
    const m = markets.get(symbol), s = series.get(code), pos = new Int8Array(W);
    const step = (j) => (j > 0 && s[j - 1].week === s[j].week - 1 ? s[j].net - s[j - 1].net : NaN);
    for (let k = 1; k < s.length; k++) {
      const w = s[k].week + 1 - W0;
      if (w < 2 || w >= W || (s[k].date >= LATE[0] && s[k].date <= LATE[1])) continue;
      const change = step(k), dir = Math.sign(change);
      if (!Number.isFinite(change) || dir === 0) continue;
      let smaller = 0, cnt = 0;
      for (let j = Math.max(1, k - LOOKBACK); j < k; j++) { const c = step(j); if (!Number.isFinite(c)) continue; cnt++; if (Math.abs(c) < Math.abs(change)) smaller++; }
      const a = m.asof[w - 1], b = m.asof[w - 2];
      const price = a === undefined || b === undefined ? 0 : Math.sign(m.o[a] - m.o[b]) * sign * dir;
      if (!keep({ size: cnt < 100 ? NaN : smaller / cnt, price })) continue;
      pos[w] = flip * dir * sign;
    }
    out.set(symbol, pos);
  }
  return out;
}

// ------------------------------------------------------------------ counting
function tOf(xs) {
  const mu = mean(xs), sd = Math.sqrt(mean(xs.map((x) => (x - mu) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return mu / (sd / Math.sqrt(xs.length));
}
/** Week by week, summed over the pairs: the result before costs, after trading costs, after swaps too; `cnt` positions in the week. */
function evaluate(pos, shift = 0, days = 7) {
  const gross = new Float64Array(W), net = new Float64Array(W), all = new Float64Array(W), cnt = new Uint8Array(W);
  let entries = 0, pips = 0, longForeign = 0, n = 0;
  const perPair = [];
  for (const symbol of PAIRS) {
    const m = markets.get(symbol), ps = pos.get(symbol);
    let prev = 0, own = 0, ownN = 0;
    for (let w = 0; w < W; w++) {
      const d = ps[(w + shift) % W], e = m.entry[w], x = exitBar(m, w, days);
      const atr = e === undefined ? NaN : m.atrOfDay.get(m.date[e]);
      if (d === 0 || x === undefined || !Number.isFinite(atr)) { prev = 0; continue; }
      const move = d * (m.o[x] - m.o[e]);
      const fresh = days !== 7 || d !== prev; // a position kept for another week is not traded again
      const c = fresh ? m.cost[e] : 0;
      const s = (d > 0 ? m.swapLong : m.swapShort) * (m.nights[x] - m.nights[e]);
      gross[w] += move / atr; net[w] += (move - c) / atr; all[w] += (move - c + s) / atr; cnt[w]++;
      n++; own += move / atr; ownN++; pips += move / m.pip;
      if (fresh) entries++;
      if (d * MARKETS[symbol].sign > 0) longForeign++;
      prev = d;
    }
    perPair.push(ownN === 0 ? NaN : own / ownN);
  }
  return { gross, net, all, cnt, entries, pips: pips / Math.max(1, n), longForeign: longForeign / Math.max(1, n), perPair };
}
/** The weeks that have an entry bar and a next one (by the first pair: the pairs trade the same hours). */
const weekDate = (w) => { const m = markets.get(PAIRS[0]); return m.entry[w] === undefined ? null : m.date[m.entry[w]]; };
const liveWeeks = [];
for (let w = 0; w < W; w++) if (weekDate(w) !== null && markets.get(PAIRS[0]).entry[w + 1] !== undefined) liveWeeks.push(w);
const total = (arr, keep = () => true) => liveWeeks.reduce((s, w) => (keep(weekDate(w)) ? s + arr[w] : s), 0);

function row(label, pos, days = 7) {
  const r = evaluate(pos, 0, days), n = Math.max(1, total(r.cnt));
  const weekly = (arr) => liveWeeks.map((w) => arr[w]);
  const actual = total(r.gross) / n;
  // The control: every shift of the same positions in time, the same for all pairs.
  const ctrl = [];
  for (let k = MIN_SHIFT; k <= W - MIN_SHIFT; k++) { const c = evaluate(pos, k, days); ctrl.push(total(c.gross) / Math.max(1, total(c.cnt))); }
  const cm = mean(ctrl), csd = Math.sqrt(mean(ctrl.map((x) => (x - cm) ** 2)));
  const above = ctrl.filter((x) => x >= actual).length / ctrl.length;
  const half = (keep) => total(r.all, keep) / Math.max(1, total(r.cnt, keep));
  console.log(`${pad(label, 58)} ${lpad(n, 5)} ${lpad((r.entries / months).toFixed(1), 5)} ${lpad((r.longForeign * 100).toFixed(0) + "%", 5)} ${lpad(f(actual), 7)} ${lpad(f(r.pips, 1), 6)} ${lpad(f(tOf(weekly(r.gross)), 1), 5)} ${lpad(f(total(r.net) / n), 7)} ${lpad(f(total(r.all) / n), 7)} ${lpad(f(tOf(weekly(r.all)), 1), 5)} | ${lpad(f(half((d) => d < SPLIT)), 7)} ${lpad(f(half((d) => d >= SPLIT)), 7)} | ${r.perPair.filter((x) => x > 0).length}/${PAIRS.length} | ${lpad(f(cm), 7)} ${lpad(csd.toFixed(3), 6)} ${lpad(f((actual - cm) / csd, 1), 5)} ${lpad((above * 100).toFixed(0) + "%", 5)}`);
}

// ------------------------------------------------------------------ the crowd (TZ 17.42)
// The small traders of the old report, traded against: the side they hold, their change of the week, their
// three-year extreme. The same weeks, costs and control as above; one more column: t after costs without swaps.
if (process.argv[2] === "crowd") {
  const flip = (pos) => new Map([...pos].map(([symbol, ps]) => [symbol, ps.map((x) => -x)]));
  const eur = netSeries("nr").get(MARKETS.EURUSD.code);
  console.log(`small traders (non-reportable) in the old report: ${eur.length} weeks for the euro, ${eur[0].date} .. ${eur[eur.length - 1].date}; last three, net as a share of open interest: ${eur.slice(-3).map((r) => `${r.date} ${f(r.net)}`).join(", ")}`);
  console.log(`\n=== against the crowd, a week held from Tuesday; dev ${FROM} .. ${TO}; result of a pair-week in daily ATRs; t by weeks ===`);
  console.log(`${pad("rule", 44)} ${lpad("n", 5)} ${lpad("in/mo", 5)} ${lpad("long", 5)} | ${lpad("before", 7)} ${lpad("pips", 6)} ${lpad("t", 5)} | ${lpad("no swaps", 8)} ${lpad("t", 5)} | ${lpad("+swaps", 7)} ${lpad("t", 5)} | ${lpad("halves, no swaps", 16)} | pairs+ | ${lpad("control z", 9)} ${lpad("above", 5)}`);
  for (const [label, pos] of [["against the side the crowd holds", flip(positions("nr", "level"))], ["against the crowd's change of the week", flip(positions("nr", "change"))], ["against a 3-year extreme of the crowd", positions("nr", "extreme")]]) {
    const r = evaluate(pos), n = Math.max(1, total(r.cnt)), weekly = (arr) => liveWeeks.map((w) => arr[w]), actual = total(r.gross) / n;
    const ctrl = [];
    for (let k = MIN_SHIFT; k <= W - MIN_SHIFT; k++) { const c = evaluate(pos, k); ctrl.push(total(c.gross) / Math.max(1, total(c.cnt))); }
    const cm = mean(ctrl), csd = Math.sqrt(mean(ctrl.map((x) => (x - cm) ** 2)));
    const half = (keep) => total(r.net, keep) / Math.max(1, total(r.cnt, keep));
    console.log(`${pad(label, 44)} ${lpad(n, 5)} ${lpad((r.entries / months).toFixed(1), 5)} ${lpad((r.longForeign * 100).toFixed(0) + "%", 5)} | ${lpad(f(actual), 7)} ${lpad(f(r.pips, 1), 6)} ${lpad(f(tOf(weekly(r.gross)), 1), 5)} | ${lpad(f(total(r.net) / n), 8)} ${lpad(f(tOf(weekly(r.net)), 1), 5)} | ${lpad(f(total(r.all) / n), 7)} ${lpad(f(tOf(weekly(r.all)), 1), 5)} | ${lpad(f(half((d) => d < SPLIT)), 7)} ${lpad(f(half((d) => d >= SPLIT)), 8)} | ${r.perPair.filter((x) => x > 0).length}/${PAIRS.length}    | ${lpad(f((actual - cm) / csd, 1), 9)} ${lpad((ctrl.filter((x) => x >= actual).length / ctrl.length * 100).toFixed(0) + "%", 5)}`);
  }
  console.log(`\n"n" pair-weeks in a position; "in/mo" new positions a month; "long" share of pair-weeks long the currency against the dollar; "before" and "pips" before any costs;`);
  console.log(`"no swaps" after spread, slippage and commission; "+swaps" after swaps too; "control z": the rule against the same positions shifted in time, in their standard deviations; "above": the share of shifts not below the rule.`);
  process.exit(0);
}

// ------------------------------------------------------------------ the run
{
  const eur = netSeries("lev").get(MARKETS.EURUSD.code), late = eur.filter((r) => r.date >= LATE[0] && r.date <= LATE[1]).length;
  console.log(`reports: ${eur.length} weeks for the euro, ${eur[0].date} .. ${eur[eur.length - 1].date}; ${late} of them late (not traded); trading weeks ${liveWeeks.length}, ${weekDate(liveWeeks[0])} .. ${weekDate(liveWeeks[liveWeeks.length - 1])}`);
  console.log(`last euro reports, net of leveraged funds as a share of open interest: ${eur.slice(-3).map((r) => `${r.date} ${f(r.net)}`).join(", ")}`);
}
console.log(`\n=== positions of large traders, a week held from Tuesday; dev ${FROM} .. ${TO}; result of a pair-week in daily ATRs ===`);
console.log(`${pad("rule", 58)} ${lpad("n", 5)} ${lpad("in/mo", 5)} ${lpad("long", 5)} ${lpad("before", 7)} ${lpad("pips", 6)} ${lpad("t", 5)} ${lpad("costs", 7)} ${lpad("+swaps", 7)} ${lpad("t", 5)} | ${lpad("1st", 7)} ${lpad("2nd", 7)} | pairs+ | ${lpad("control", 7)} ${lpad("sd", 6)} ${lpad("z", 5)} ${lpad("above", 5)}`);
for (const group of Object.keys(GROUPS)) for (const kind of Object.keys(KINDS)) row(`${GROUPS[group]}: ${KINDS[kind]}`, positions(group, kind));
row("reference: the price trend of four weeks", reference("trend"));
row("reference: always long the currency against the dollar", reference("long"));
console.log(`\n=== the one row that stands out, taken apart: leveraged funds, the change of the week ===`);
row("against the change of the week (the mirror, own costs)", levChange(() => true, -1));
row("price only: the move of the report week, followed", reference("reportWeek"));
row("price only: the move of the week just ended, followed", reference("lastWeek"));
row("follow the change, the price moved the same way", levChange((x) => x.price > 0));
row("follow the change, the price moved against it", levChange((x) => x.price < 0));
row("follow the change, small (lowest third)", levChange((x) => x.size < 1 / 3));
row("follow the change, middle third", levChange((x) => x.size >= 1 / 3 && x.size < 2 / 3));
row("follow the change, large (top third)", levChange((x) => x.size >= 2 / 3));
console.log(`\n=== a by-product: against the price move of the week just ended (Tuesday to Tuesday), by the days held ===`);
const against = (pos) => new Map([...pos].map(([symbol, ps]) => [symbol, ps.map((x) => -x)]));
for (const days of [1, 2, 3, 7]) row("against last week's move, held " + days + (days === 1 ? " day" : " days"), against(reference("lastWeek")), days);
console.log(`\n"n" pair-weeks in a position; "in/mo" new positions a month; "long" share of pair-weeks long the currency against the dollar;`);
console.log(`"before" and "pips" before any costs; "costs" after spread, slippage and commission; "+swaps" after swaps too; t by weeks;`);
console.log(`"1st", "2nd" after all costs before and from ${SPLIT}; "control" the same positions shifted in time (mean, sd, z of the rule, share of shifts not below it).`);
