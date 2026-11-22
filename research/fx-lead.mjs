// Who leads whom inside the day (TZ 17.31): after gold, the S&P 500 or the
// rest of the dollar pairs have moved, does a currency pair follow in the next
// 15 minutes to 4 hours? Seven dollar pairs as followers, M15 bars, dev only:
// nothing after 2021-12-08 is read. The S&P 500 file has real quarter-hour
// bars only from 2017-03-21; the days before it are dropped for that leader.
//
// For a follower and a leader, at the start of every quarter-hour τ:
//   lead   = the leader's move over the last L minutes (ending just before τ);
//   beta   = how the follower has moved with the leader, per quarter-hour, over
//            the 20 trading days before (slope and correlation; no look-ahead);
//   signal = the leader's move is at least Z times its usual size for L minutes;
//   trade  = the follower in the direction the leader implies (the sign of beta
//            times the sign of the move), from the open at τ for H minutes.
// Two versions of every cell: all signals, and only those where the follower
// has done less than half of what the leader's move implies ("has not
// followed yet"). "The rest of the dollar" as a leader is the mean move of the
// other six pairs, turned into the follower's own direction.
// One trade per follower and cell at a time. No window touches 22:00-02:00 by
// the server (wide spreads, the Bid files of two symbols drift apart). Moves
// are in basis points of the price before costs; the cost of one trade of the
// project is shown beside them. t by days, the number of a day being the sum of its trades.
//
// Usage: node research/fx-lead.mjs                                         the grid
//        node research/fx-lead.mjs cell <leader 0-2> <L> <H> <Z> <all|lag>  one cell by follower, year and hour
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const FROM = "2015-02-02", TO = "2021-12-08", MID = "2018-07-01";
const FOLLOWERS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF"];
const LEADERS = [{ name: "gold", symbol: "XAUUSD" }, { name: "S&P 500", symbol: "US500" }, { name: "rest of the dollar" }];
const LS = [15, 60, 240], HS = [15, 60, 240], ZS = [1, 2, 3];
const DAYS_BACK = 20, MIN_BARS_A_DAY = 60, MIN_CORR = 0.1;
const START = 2 * 60, END = 22 * 60; // minutes of the server day between which every window has to lie

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function tOf(xs) {
  if (xs.length < 3) return NaN;
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / (xs.length - 1)));
  return sd === 0 ? NaN : m / (sd / Math.sqrt(xs.length));
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const monthsBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / (86400e3 * 30.4375);

// ------------------------------------------------------------------ data
/** M15 bars of a symbol to the end of dev, days with too few bars dropped (the early index history is daily bars under an M15 name). */
function load(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const rows = [], perDay = new Map();
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break; // nothing after the end of dev is read
    const hh = +p[1].slice(0, 2), mm = +p[1].slice(3, 5), o = +p[2], c = +p[5];
    rows.push({ date, minute: hh * 60 + mm, slot: Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hh, mm) / 900000, o, r: Math.log(c / o), cost: ((Math.max(+p[8], floor) * point + 2 * config.costs.slippagePips * pip + (own.usdSide === "base" ? commission * o : commission)) / o) * 1e4 });
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
  }
  const kept = rows.filter((b) => perDay.get(b.date) >= MIN_BARS_A_DAY);
  return { symbol, rows: kept, bySlot: new Map(kept.map((b, i) => [b.slot, i])), dollar: own.usdSide === "base" ? 1 : -1 };
}
const data = new Map([...FOLLOWERS, "XAUUSD", "US500"].map((s) => [s, load(s)]));

/** The leader's quarter-hour move at each bar of the follower, in the follower's time (NaN where the leader has no bar). */
function leaderMoves(leader, follower) {
  const F = data.get(follower);
  if (leader.symbol !== undefined) { const K = data.get(leader.symbol); return F.rows.map((b) => { const i = K.bySlot.get(b.slot); return i === undefined ? NaN : K.rows[i].r; }); }
  const others = FOLLOWERS.filter((s) => s !== follower).map((s) => data.get(s));
  return F.rows.map((b) => {
    let sum = 0, n = 0;
    for (const K of others) { const i = K.bySlot.get(b.slot); if (i !== undefined) { sum += K.dollar * K.rows[i].r; n++; } }
    return n >= 5 ? (F.dollar * sum) / n : NaN; // what the other pairs say about the dollar, in this pair's own direction
  });
}

// ------------------------------------------------------------------ one leader and one follower: every signal of every cell
/** Returns Map "L|H|Z|all" and "L|H|Z|lag" -> records { follower, date, minute, bp, cost }. */
function pairSignals(leader, follower) {
  const F = data.get(follower), rows = F.rows, n = rows.length;
  const x = leaderMoves(leader, follower);
  // Day by day: the sums for the slope, the correlation and the usual sizes, over the bars inside the allowed hours.
  const dayOf = new Int32Array(n), days = [];
  for (let i = 0; i < n; i++) { if (i === 0 || rows[i].date !== rows[i - 1].date) days.push({ sxy: 0, sxx: 0, syy: 0, n: 0 }); dayOf[i] = days.length - 1; }
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || rows[i].minute < START || rows[i].minute >= END) continue;
    const d = days[dayOf[i]], y = rows[i].r;
    d.sxy += x[i] * y; d.sxx += x[i] * x[i]; d.syy += y * y; d.n++;
  }
  const stats = days.map((_, d) => {
    let sxy = 0, sxx = 0, syy = 0, cnt = 0, used = 0;
    for (let k = d - DAYS_BACK; k < d; k++) { if (k < 0 || days[k].n === 0) continue; sxy += days[k].sxy; sxx += days[k].sxx; syy += days[k].syy; cnt += days[k].n; used++; }
    if (used < DAYS_BACK / 2 || sxx === 0 || syy === 0) return null;
    return { beta: sxy / sxx, corr: sxy / Math.sqrt(sxx * syy), sigX: Math.sqrt(sxx / cnt), sigY: Math.sqrt(syy / cnt) };
  });
  // Running sums to take the move of any window; a window counts only if its bars are consecutive quarter-hours with a leader bar in each.
  const px = new Float64Array(n + 1), py = new Float64Array(n + 1), bad = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) { const ok = Number.isFinite(x[i]); px[i + 1] = px[i] + (ok ? x[i] : 0); py[i + 1] = py[i] + rows[i].r; bad[i + 1] = bad[i] + (ok ? 0 : 1); }
  const out = new Map(), busy = new Map();
  for (const L of LS) for (const H of HS) for (const Z of ZS) for (const v of ["all", "lag"]) { out.set(`${L}|${H}|${Z}|${v}`, []); busy.set(`${L}|${H}|${Z}|${v}`, -Infinity); }
  for (let i = 0; i < n; i++) {
    const b = rows[i];
    if (b.date < FROM) continue;
    const st = stats[dayOf[i]];
    if (st === null || Math.abs(st.corr) < MIN_CORR) continue;
    for (const L of LS) {
      const k = L / 15;
      if (b.minute - L < START || i - k < 0 || rows[i - k].slot !== b.slot - k || bad[i] - bad[i - k] !== 0) continue;
      const lead = px[i] - px[i - k], own = py[i] - py[i - k];
      if (lead === 0) continue;
      const z = Math.abs(lead) / (st.sigX * Math.sqrt(k));
      if (z < ZS[0]) continue;
      const dir = Math.sign(st.beta) * Math.sign(lead);
      const lagging = dir * own < 0.5 * Math.abs(st.beta * lead);
      for (const H of HS) {
        if (b.minute + H > END) continue;
        const j = F.bySlot.get(b.slot + H / 15);
        if (j === undefined) continue;
        const bp = dir * Math.log(rows[j].o / b.o) * 1e4;
        for (const Z of ZS) {
          if (z < Z) continue;
          for (const v of lagging ? ["all", "lag"] : ["all"]) {
            const key = `${L}|${H}|${Z}|${v}`;
            if (b.slot < busy.get(key)) continue; // one trade per follower and cell at a time
            busy.set(key, b.slot + H / 15);
            out.get(key).push({ follower, date: b.date, minute: b.minute, bp, cost: b.cost });
          }
        }
      }
    }
  }
  return out;
}

/**
 * t by days: the day's number is the SUM of its trades. A mean per day would weigh a trade by how many more signals the
 * same day brought, and that is known only afterwards: a lone signal is one after which the leader's move fell back.
 */
function summary(recs, months) {
  const days = new Map();
  for (const r of recs) days.set(r.date, (days.get(r.date) ?? 0) + r.bp);
  const half = (keep) => mean(recs.filter((r) => keep(r.date)).map((r) => r.bp));
  const names = FOLLOWERS.filter((p) => recs.some((r) => r.follower === p));
  return {
    n: recs.length, perMonth: recs.length / months, mean: mean(recs.map((r) => r.bp)), t: tOf([...days.values()]),
    first: half((d) => d < MID), second: half((d) => d >= MID), cost: mean(recs.map((r) => r.cost)),
    plus: names.filter((p) => mean(recs.filter((r) => r.follower === p).map((r) => r.bp)) > 0).length, of: names.length,
  };
}
const HEAD = `${pad("", 40)} ${lpad("n", 6)} ${lpad("a mo", 6)} | ${lpad("move", 6)} ${lpad("t", 5)} | ${lpad("halves", 13)} | ${lpad("pairs+", 6)} | ${lpad("cost", 5)} ${lpad("left", 6)}`;
const row = (label, s) => `${pad(label, 40)} ${lpad(s.n, 6)} ${lpad(s.perMonth.toFixed(1), 6)} | ${lpad(f(s.mean), 6)} ${lpad(f(s.t, 1), 5)} | ${lpad(f(s.first), 6)} ${lpad(f(s.second), 6)} | ${lpad(`${s.plus}/${s.of}`, 6)} | ${lpad(s.cost.toFixed(2), 5)} ${lpad(f(s.mean - s.cost), 6)}`;

const [mode = "grid", kArg, lArg, hArg, zArg, vArg] = process.argv.slice(2);
console.log(`dev ${FROM}..${TO}; moves in basis points of the price in the direction the leader implies, before costs; t by days; left = move minus the cost of one trade`);
console.log("all = every signal; lag = only when the follower has done less than half of what the leader's move implies\n");

for (const [ki, leader] of LEADERS.entries()) {
  if (mode === "cell" && ki !== +kArg) continue;
  const cells = new Map();
  let first = TO;
  for (const follower of FOLLOWERS) for (const [key, recs] of pairSignals(leader, follower)) {
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(...recs);
    for (const r of recs) if (r.date < first) first = r.date;
  }
  const months = monthsBetween(first, TO);
  if (mode === "grid") {
    const list = [...cells.entries()].map(([key, recs]) => { const [L, H, Z, v] = key.split("|"); return { label: `last ${L}  then ${H}  size ${Z}+  ${v}`, s: summary(recs, months) }; }).filter((c) => c.s.n >= 30);
    list.sort((a, b) => Math.abs(b.s.t) - Math.abs(a.s.t));
    console.log(`=== leader: ${leader.name} (signals from ${first}, ${months.toFixed(0)} months): ${list.length} cells, the 16 with the largest |t| ===`);
    console.log(HEAD);
    for (const c of list.slice(0, 16)) console.log(row(c.label, c.s));
    const above = list.filter((c) => c.s.mean > c.s.cost);
    console.log(`cells where the follower's move is larger than the cost of a trade: ${above.length} of ${list.length}; with |t| of 2 and more: ${list.filter((c) => Math.abs(c.s.t) >= 2).length}; of 3 and more: ${list.filter((c) => Math.abs(c.s.t) >= 3).length}`);
    for (const c of above.sort((a, b) => b.s.t - a.s.t).slice(0, 10)) console.log(row(`  > cost: ${c.label}`, c.s));
    console.log("");
  } else {
    const recs = cells.get(`${lArg}|${hArg}|${zArg}|${vArg}`) ?? [];
    console.log(`=== leader: ${leader.name}, last ${lArg} minutes, then ${hArg}, size ${zArg}+, ${vArg} ===`);
    console.log(HEAD);
    console.log(row("all", summary(recs, months)));
    for (const p of FOLLOWERS) console.log(row(`  ${p}`, summary(recs.filter((r) => r.follower === p), months)));
    for (let y = 2015; y <= 2021; y++) console.log(row(String(y), summary(recs.filter((r) => r.date.startsWith(String(y))), months)));
    for (const [lo, hi] of [[2, 8], [8, 12], [12, 15], [15, 18], [18, 22]]) console.log(row(`server hours ${lo}-${hi}`, summary(recs.filter((r) => r.minute >= lo * 60 && r.minute < hi * 60), months)));
  }
}
