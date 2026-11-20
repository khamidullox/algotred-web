// A scan of the seven dollar pairs (and the 21 crosses built from them) for
// any repeating move that is larger than the costs: TZ 17.23. Dev only.
// It measures conditions, it does not trade: every table shows the mean move
// before costs, the costs of one round trip in the same unit and a t-value.
//
// Usage: node research/fx-scan.mjs hours|h1|blocks|daily|all
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const PAIRS = (process.env.PAIRS ?? "EURUSD,GBPUSD,USDJPY,AUDUSD,NZDUSD,USDCAD,USDCHF").split(",");
const FROM = "2015-02-02", TO = "2021-12-08", MID = "2018-07-01";
const HOUR = 3600e3;
const mode = process.argv[2] ?? "all";

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function stat(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return { n: xs.length, m, sd, t: m / (sd / Math.sqrt(Math.max(1, xs.length))) };
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
    swapLong: own.swapLongPips * point * 10, swapShort: own.swapShortPips * point * 10,
  };
}
/** What a round trip costs as a price distance when it starts on `bar`: spread, slippage on both fills, commission. */
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
    if (tf === "D1") rows.push({ date, o: +p[1], h: +p[2], l: +p[3], c: +p[4], spread: +p[7] });
    else rows.push({ date, hour: +p[1].slice(0, 2), ms: Date.parse(`${date}T${p[1]}Z`), o: +p[2], h: +p[3], l: +p[4], c: +p[5], spread: +p[8] });
  }
  return rows;
}
/** date -> the mean true range of the twenty days before it. */
function atrBefore(daily) {
  const out = new Map();
  const tr = daily.map((b, i) => (i === 0 ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - daily[i - 1].c), Math.abs(b.l - daily[i - 1].c))));
  for (let i = 20; i < daily.length; i++) out.set(daily[i].date, mean(tr.slice(i - 20, i)));
  return out;
}
const inDev = (date) => date >= FROM && date <= TO;

const data = new Map();
for (const symbol of PAIRS) {
  const s = spec(symbol);
  const daily = load(symbol, "D1");
  const atr = atrBefore(daily);
  const h1 = load(symbol, "H1").filter((b) => inDev(b.date) && atr.has(b.date));
  for (const b of h1) { b.atr = atr.get(b.date); b.cost = costOf(s, b); }
  data.set(symbol, { s, daily, atr, h1 });
}

// ---------------------------------------------------------------- hours of the day
function hours() {
  console.log("\n== 1. Mean move of each server hour (00 = 17:00 New York), pips; cost of a round trip in pips ==");
  for (const symbol of PAIRS) {
    const { s, h1 } = data.get(symbol);
    const cost = mean(h1.map((b) => b.cost)) / s.pip;
    const rows = [];
    for (let hour = 0; hour < 24; hour++) {
      const all = h1.filter((b) => b.hour === hour);
      const st = stat(all.map((b) => (b.c - b.o) / s.pip));
      const a = stat(all.filter((b) => b.date < MID).map((b) => (b.c - b.o) / s.pip));
      const z = stat(all.filter((b) => b.date >= MID).map((b) => (b.c - b.o) / s.pip));
      rows.push({ hour, ...st, a: a.m, z: z.m });
    }
    const strong = rows.filter((r) => Math.abs(r.t) >= 2.5).map((r) => `${String(r.hour).padStart(2, "0")}h ${f(r.m, 2)} (t ${f(r.t, 1)}; halves ${f(r.a, 2)} / ${f(r.z, 2)})`);
    // The best run of hours in a row by the sum of means, either sign, up to 8 hours long.
    let best = { sum: 0 };
    for (let start = 0; start < 24; start++) for (let len = 1; len <= 8; len++) {
      let sum = 0; for (let j = 0; j < len; j++) sum += rows[(start + j) % 24].m;
      if (Math.abs(sum) > Math.abs(best.sum)) best = { sum, start, len };
    }
    console.log(`${pad(symbol, 7)} cost ${cost.toFixed(2)} | best run: from ${String(best.start).padStart(2, "0")}h, ${best.len} h, ${f(best.sum, 2)} pips | hours with |t| >= 2.5: ${strong.join("; ") || "none"}`);
  }
}

// ---------------------------------------------------------------- after a large move on H1
function h1scan() {
  console.log("\n== 2. After a large move over k hours: the move of the next h hours AGAINST it (plus = reversal), % of the daily ATR ==");
  console.log("   entry at the open of the next hour; cost = one round trip in the same unit; nights (swaps) are not counted");
  const K = [1, 4, 24], H = [1, 4, 8, 24], Q = [0.95, 0.99];
  const SESS = { all: () => true, asia: (e) => e <= 8, london: (e) => e >= 9 && e <= 15, newyork: (e) => e >= 16 };
  const cells = new Map();
  const key = (k, h, q, sess) => `${k}|${h}|${q}|${sess}`;
  for (const symbol of PAIRS) {
    const { h1 } = data.get(symbol);
    for (const k of K) {
      const r = new Array(h1.length).fill(NaN);
      for (let i = k; i < h1.length; i++) if (h1[i].ms - h1[i - k].ms === k * HOUR) r[i] = (h1[i].c - h1[i - k].c) / h1[i].atr;
      const sorted = r.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
      for (const q of Q) {
        const limit = sorted[Math.floor(q * sorted.length)];
        for (const h of H) for (let i = k; i + h < h1.length; i++) {
          if (!(Math.abs(r[i]) >= limit)) continue;
          if (h1[i + h].ms - h1[i].ms !== h * HOUR) continue;
          const pay = (-Math.sign(r[i]) * (h1[i + h].c - h1[i + 1].o)) / h1[i].atr * 100;
          const cost = h1[i + 1].cost / h1[i].atr * 100;
          const entryHour = (h1[i].hour + 1) % 24;
          for (const [sess, test] of Object.entries(SESS)) {
            if (!test(entryHour)) continue;
            const id = key(k, h, q, sess);
            if (!cells.has(id)) cells.set(id, []);
            cells.get(id).push({ pay, cost, symbol, first: h1[i].date < MID });
          }
        }
      }
    }
  }
  const out = [];
  for (const [id, xs] of cells) {
    const [k, h, q, sess] = id.split("|");
    const st = stat(xs.map((x) => x.pay));
    const cost = mean(xs.map((x) => x.cost));
    const a = mean(xs.filter((x) => x.first).map((x) => x.pay)), z = mean(xs.filter((x) => !x.first).map((x) => x.pay));
    const pairsPlus = PAIRS.filter((p) => mean(xs.filter((x) => x.symbol === p).map((x) => x.pay)) > 0).length;
    out.push({ k: +k, h: +h, q: +q, sess, ...st, cost, a, z, pairsPlus });
  }
  out.sort((x, y) => Math.abs(y.m) / y.cost - Math.abs(x.m) / x.cost);
  console.log("   k   h  top   session   n      move    t     cost   halves          pairs+");
  for (const c of out.slice(0, 28)) console.log(`  ${lpad(c.k, 2)}  ${lpad(c.h, 2)}  ${((1 - c.q) * 100).toFixed(0)}%   ${pad(c.sess, 8)} ${lpad(c.n, 6)}  ${lpad(f(c.m, 2), 6)} ${lpad(f(c.t, 1), 5)}  ${c.cost.toFixed(2)}   ${f(c.a, 2)} / ${f(c.z, 2)}   ${c.pairsPlus}/7`);
}

// ---------------------------------------------------------------- blocks of the day
function blocks() {
  console.log("\n== 3. Does one part of the day foretell the next? Move of the target in the direction of the signal, % of the daily ATR ==");
  console.log("   server hours: asia 00-09 (17:00-02:00 NY), london 09-15, ny1 15-19, ny2 19-23, last 23-24, prev = the day before");
  const defs = [
    ["prev -> asia", (d) => d.prev, (d) => d.asia],
    ["prev -> day", (d) => d.prev, (d) => d.asia + d.london + d.ny1 + d.ny2 + d.last],
    ["asia -> london", (d) => d.asia, (d) => d.london],
    ["asia -> rest of day", (d) => d.asia, (d) => d.london + d.ny1 + d.ny2 + d.last],
    ["london -> ny1", (d) => d.london, (d) => d.ny1],
    ["asia+london -> ny1", (d) => d.asia + d.london, (d) => d.ny1],
    ["asia+london -> ny1+ny2", (d) => d.asia + d.london, (d) => d.ny1 + d.ny2],
    ["ny1 -> ny2", (d) => d.ny1, (d) => d.ny2],
    ["asia+london+ny1 -> ny2", (d) => d.asia + d.london + d.ny1, (d) => d.ny2],
    ["asia+london+ny1 -> ny2+last", (d) => d.asia + d.london + d.ny1, (d) => d.ny2 + d.last],
    ["day to 23h -> last", (d) => d.asia + d.london + d.ny1 + d.ny2, (d) => d.last],
    ["day -> next asia", (d) => d.asia + d.london + d.ny1 + d.ny2 + d.last, (d) => d.nextAsia],
  ];
  const days = [];
  for (const symbol of PAIRS) {
    const { h1 } = data.get(symbol);
    const byDate = new Map();
    for (const b of h1) { if (!byDate.has(b.date)) byDate.set(b.date, new Map()); byDate.get(b.date).set(b.hour, b); }
    const list = [...byDate.entries()];
    for (let i = 1; i + 1 < list.length; i++) {
      const [date, m] = list[i];
      const need = [0, 9, 15, 19, 23];
      if (!need.every((hh) => m.has(hh))) continue;
      const prevDay = list[i - 1][1], nextDay = list[i + 1][1];
      if (!prevDay.has(0) || !nextDay.has(0) || !nextDay.has(9)) continue;
      const atr = m.get(0).atr;
      const p = (hh) => m.get(hh).o;
      const close = m.get(23).c;
      days.push({
        symbol, date, first: date < MID, cost: (m.get(9).cost / atr) * 100,
        prev: ((p(0) - prevDay.get(0).o) / atr) * 100, asia: ((p(9) - p(0)) / atr) * 100, london: ((p(15) - p(9)) / atr) * 100,
        ny1: ((p(19) - p(15)) / atr) * 100, ny2: ((p(23) - p(19)) / atr) * 100, last: ((close - p(23)) / atr) * 100,
        nextAsia: ((nextDay.get(9).o - nextDay.get(0).o) / atr) * 100,
      });
    }
  }
  const cost = mean(days.map((d) => d.cost));
  console.log(`   days ${days.length}, mean cost of a round trip ${cost.toFixed(2)}% of ATR`);
  console.log("   signal -> target                all days: move  t      | signal in its top third: move  t   halves        pairs+ | top tenth: move  t");
  for (const [name, sig, tgt] of defs) {
    const rows = days.map((d) => ({ d, s: sig(d), y: tgt(d) })).filter((x) => x.s !== 0);
    const abs = rows.map((x) => Math.abs(x.s)).sort((a, b) => a - b);
    const third = abs[Math.floor(abs.length * 2 / 3)], tenth = abs[Math.floor(abs.length * 0.9)];
    const pay = (x) => Math.sign(x.s) * x.y;
    const all = stat(rows.map(pay));
    const big = rows.filter((x) => Math.abs(x.s) >= third);
    const top = stat(big.map(pay));
    const a = mean(big.filter((x) => x.d.first).map(pay)), z = mean(big.filter((x) => !x.d.first).map(pay));
    const pairsPlus = PAIRS.filter((p) => mean(big.filter((x) => x.d.symbol === p).map(pay)) > 0).length;
    const dec = stat(rows.filter((x) => Math.abs(x.s) >= tenth).map(pay));
    console.log(`   ${pad(name, 30)} ${lpad(f(all.m, 2), 6)} ${lpad(f(all.t, 1), 5)}  | ${lpad(f(top.m, 2), 6)} ${lpad(f(top.t, 1), 5)}  ${f(a, 2)} / ${f(z, 2)}  ${pairsPlus}/7 | ${lpad(f(dec.m, 2), 6)} ${lpad(f(dec.t, 1), 5)}`);
  }
}

// ---------------------------------------------------------------- daily closes, 28 pairs
function dailyScan() {
  console.log("\n== 4. Daily closes of 28 pairs: after a move of k days larger than z sigma, the next h days AGAINST it, basis points of price ==");
  console.log("   entry at the next daily open; crosses are built from two dollar pairs and pay the costs of both; swaps are not counted");
  const CUR = { EUR: ["EURUSD", false], GBP: ["GBPUSD", false], AUD: ["AUDUSD", false], NZD: ["NZDUSD", false], JPY: ["USDJPY", true], CAD: ["USDCAD", true], CHF: ["USDCHF", true] };
  // Value of each currency in dollars by day.
  const dates = [...new Set(PAIRS.flatMap((p) => data.get(p).daily.map((b) => b.date)))].sort();
  const maps = new Map(PAIRS.map((p) => [p, new Map(data.get(p).daily.map((b) => [b.date, b]))]));
  const common = dates.filter((d) => PAIRS.every((p) => maps.get(p).has(d)) && d >= "2014-06-01" && d <= TO);
  const value = { USD: common.map(() => ({ o: 1, c: 1, cost: 0 })) };
  for (const [cur, [pair, inverse]] of Object.entries(CUR)) {
    const s = spec(pair);
    value[cur] = common.map((d) => { const b = maps.get(pair).get(d); const cost = costOf(s, b) / b.o; return inverse ? { o: 1 / b.o, c: 1 / b.c, cost } : { o: b.o, c: b.c, cost }; });
  }
  const names = Object.keys(value);
  const series = [];
  for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
    const A = value[names[a]], B = value[names[b]];
    series.push({ name: `${names[a]}${names[b]}`, usd: names[a] === "USD" || names[b] === "USD", rows: common.map((d, i) => ({ date: d, o: A[i].o / B[i].o, c: A[i].c / B[i].c, cost: (A[i].cost + B[i].cost) * 1e4 })) });
  }
  const K = [1, 2, 3, 5, 10], H = [1, 2, 3, 5], Z = [1.5, 2, 2.5];
  const cells = new Map();
  for (const sr of series) {
    const { rows } = sr;
    const ret = rows.map((r, i) => (i === 0 ? 0 : Math.log(r.c / rows[i - 1].c)));
    for (let i = 30; i + 6 < rows.length; i++) {
      if (!inDev(rows[i].date)) continue;
      const window = ret.slice(i - 19, i + 1);
      const sigma = Math.sqrt(mean(window.map((x) => x * x)));
      for (const k of K) {
        const z = Math.log(rows[i].c / rows[i - k].c) / (sigma * Math.sqrt(k));
        for (const zz of Z) {
          if (Math.abs(z) < zz) continue;
          for (const h of H) {
            const pay = -Math.sign(z) * Math.log(rows[i + h].c / rows[i + 1].o) * 1e4;
            const id = `${k}|${h}|${zz}`;
            if (!cells.has(id)) cells.set(id, []);
            cells.get(id).push({ pay, cost: rows[i + 1].cost, name: sr.name, usd: sr.usd, first: rows[i].date < MID });
          }
        }
      }
    }
  }
  const out = [];
  for (const [id, xs] of cells) {
    const [k, h, z] = id.split("|").map(Number);
    for (const [group, test] of [["dollar pairs", (x) => x.usd], ["crosses", (x) => !x.usd]]) {
      const g = xs.filter(test);
      const st = stat(g.map((x) => x.pay));
      const names2 = [...new Set(g.map((x) => x.name))];
      const plus = names2.filter((nm) => mean(g.filter((x) => x.name === nm).map((x) => x.pay)) > 0).length;
      out.push({ k, h, z, group, ...st, cost: mean(g.map((x) => x.cost)), a: mean(g.filter((x) => x.first).map((x) => x.pay)), b: mean(g.filter((x) => !x.first).map((x) => x.pay)), plus, of: names2.length, perMonth: g.length / 82 });
    }
  }
  out.sort((x, y) => y.t - x.t);
  console.log("   k   h   z    group          n   a month   move     t    cost   halves          pairs+");
  for (const c of out.slice(0, 24)) console.log(`  ${lpad(c.k, 2)}  ${lpad(c.h, 2)}  ${c.z.toFixed(1)}  ${pad(c.group, 12)} ${lpad(c.n, 6)} ${lpad(c.perMonth.toFixed(1), 6)}  ${lpad(f(c.m, 2), 6)} ${lpad(f(c.t, 1), 5)}  ${c.cost.toFixed(2)}   ${f(c.a, 2)} / ${f(c.b, 2)}   ${c.plus}/${c.of}`);
  console.log("   ... and the weakest:");
  for (const c of out.slice(-6)) console.log(`  ${lpad(c.k, 2)}  ${lpad(c.h, 2)}  ${c.z.toFixed(1)}  ${pad(c.group, 12)} ${lpad(c.n, 6)} ${lpad(c.perMonth.toFixed(1), 6)}  ${lpad(f(c.m, 2), 6)} ${lpad(f(c.t, 1), 5)}  ${c.cost.toFixed(2)}   ${f(c.a, 2)} / ${f(c.b, 2)}   ${c.plus}/${c.of}`);
  // By pair for one plain cell, to see where a reversal lives if anywhere.
  const cell = cells.get("1|1|2") ?? [];
  const byName = [...new Set(cell.map((x) => x.name))].map((nm) => ({ nm, ...stat(cell.filter((x) => x.name === nm).map((x) => x.pay)), cost: mean(cell.filter((x) => x.name === nm).map((x) => x.cost)) })).sort((x, y) => y.m - x.m);
  console.log("   by pair, k=1 h=1 z=2 (move, t, cost, n): " + byName.map((x) => `${x.nm} ${f(x.m, 1)} (${f(x.t, 1)}; ${x.cost.toFixed(1)}; ${x.n})`).join(", "));
}

if (mode === "hours" || mode === "all") hours();
if (mode === "h1" || mode === "all") h1scan();
if (mode === "blocks" || mode === "all") blocks();
if (mode === "daily" || mode === "all") dailyScan();
