// The last corner of the scan (TZ 17.23): the 21 crosses, built from M15
// closes of the dollar pairs, and the same fade of a stretch away from the
// 20-bar mean as in fx-scan2.mjs. Closes only (a cross made of two files has
// no true high and low). Dev only. The move is before costs, in pips of the
// cross; the cost of trading it as two dollar legs is shown beside it, a
// broker's own cross would cost about half of that.
//
// Usage: node research/fx-cross-night.mjs
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const FROM = "2015-02-02", TO = "2021-12-08", MID = "2018-07-01";
const CUR = { EUR: ["EURUSD", false], GBP: ["GBPUSD", false], AUD: ["AUDUSD", false], NZD: ["NZDUSD", false], JPY: ["USDJPY", true], CAD: ["USDCAD", true], CHF: ["USDCHF", true] };

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function stat(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / Math.max(1, xs.length - 1)));
  return { n: xs.length, m, t: m / (sd / Math.sqrt(Math.max(1, xs.length))) };
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const pad = (s, n) => String(s).padEnd(n);

function legCost(pair, price) {
  const own = config.symbols[pair];
  const point = 10 ** -own.digits;
  const spread = (own.minSpreadPoints ?? config.costs.minSpreadPoints) * point + 2 * config.costs.slippagePips * point * 10;
  const commission = own.usdSide === "base" ? (config.costs.commissionPerLotRoundTrip / own.contractSize) * price : config.costs.commissionPerLotRoundTrip / own.contractSize;
  return (spread + commission) / price; // as a share of the price
}
const value = {};
for (const [cur, [pair, inverse]] of Object.entries(CUR)) {
  const m = new Map();
  const lines = readFileSync(`${config.dataDir}/${pair}_M15.csv`, "utf8").split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 8) continue;
    const date = p[0].replaceAll(".", "-");
    if (date > TO) break;
    if (date < "2015-01-20") continue;
    const c = +p[5];
    m.set(`${date} ${p[1].slice(0, 5)}`, { v: inverse ? 1 / c : c, cost: legCost(pair, c) });
  }
  value[cur] = m;
}
const names = Object.keys(value);
const stamps = [...value.EUR.keys()].filter((k) => names.every((n) => value[n].has(k)));
console.log(`common M15 bars ${stamps.length}`);

const windows = { "23-02 rollover": (h) => h >= 23 || h < 2, "02-08 Tokyo": (h) => h >= 2 && h < 8, "08-15 London am": (h) => h >= 8 && h < 15, "15-23 New York": (h) => h >= 15 && h < 23 };
for (const width of [2.5, 3]) for (const [wname, test] of Object.entries(windows)) {
  const all = [], lines = [];
  for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
    const A = value[names[a]], B = value[names[b]];
    const pip = names[b] === "JPY" || names[a] === "JPY" ? null : 0.0001;
    const c = stamps.map((k) => A.get(k).v / B.get(k).v);
    const trades = [];
    let sum = 0, sumSq = 0, busyUntil = -1;
    for (let i = 0; i + 17 < c.length; i++) {
      sum += c[i]; sumSq += c[i] ** 2;
      if (i >= 20) { sum -= c[i - 20]; sumSq -= c[i - 20] ** 2; }
      const date = stamps[i].slice(0, 10), hour = +stamps[i].slice(11, 13);
      if (i < 19 || i <= busyUntil || date < FROM || !test(hour)) continue;
      const ma = sum / 20, sd = Math.sqrt(Math.max(0, sumSq / 20 - ma * ma));
      if (sd === 0 || Math.abs((c[i] - ma) / sd) < width) continue;
      // Sixteen bars ahead have to be four hours ahead: no trade over a hole.
      if (Date.parse(`${stamps[i + 16].replace(" ", "T")}:00Z`) - Date.parse(`${stamps[i].replace(" ", "T")}:00Z`) > 4 * 3600e3 + 1) continue;
      const dir = -Math.sign(c[i] - ma);
      // In at this close (the next open of a cross is the same price to within noise), out at the first close back at the mean.
      let exit = c[i + 16], held = 16, s2 = sum;
      for (let j = i + 1; j <= i + 16; j++) {
        s2 += c[j] - c[j - 20];
        if ((dir > 0 && c[j] >= s2 / 20) || (dir < 0 && c[j] <= s2 / 20)) { exit = c[j]; held = j - i; break; }
      }
      busyUntil = i + held;
      const k = stamps[i];
      trades.push({ bp: (dir * (exit - c[i])) / c[i] * 1e4, cost: (A.get(k).cost + B.get(k).cost) * 1e4, first: date < MID });
    }
    all.push(...trades);
    const st = stat(trades.map((x) => x.bp));
    lines.push({ name: `${names[a]}${names[b]}`, ...st, cost: mean(trades.map((x) => x.cost)), a: mean(trades.filter((x) => x.first).map((x) => x.bp)), z: mean(trades.filter((x) => !x.first).map((x) => x.bp)) });
  }
  const st = stat(all.map((x) => x.bp));
  lines.sort((x, y) => y.m - x.m);
  console.log(`band ${width}  ${pad(wname, 16)} trades ${all.length} (${(all.length / 82).toFixed(0)} a month)  move ${f(st.m)} bp (t ${f(st.t, 1)})  two-leg cost ${mean(all.map((x) => x.cost)).toFixed(2)} bp  wins ${((all.filter((x) => x.bp > 0).length / all.length) * 100).toFixed(0)}%  halves ${f(mean(all.filter((x) => x.first).map((x) => x.bp)))} / ${f(mean(all.filter((x) => !x.first).map((x) => x.bp)))}`);
  console.log(`      best: ${lines.slice(0, 5).map((x) => `${x.name} ${f(x.m)} (t ${f(x.t, 1)}; ${f(x.a, 1)}/${f(x.z, 1)}; cost ${x.cost.toFixed(1)}; n ${x.n})`).join(", ")}`);
}
