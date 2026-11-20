// Event study for the news idea of TZ 17.19, dev only: after an important
// release that came out better or worse than forecast, does the price keep
// moving in that direction? Reads the MT5 calendar export and the M15 files
// directly; no engine, no strategy. Prices are measured from the open of the
// first M15 bar that opens after the release, so the first reaction (up to 15
// minutes) is not counted as profit: nobody can trade the number before the
// market does.
// Usage: node research/news-study.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
const DEV_START = Date.parse("2015-02-01T22:00:00Z");
const DEV_END = Date.parse(`${config.datasets.testStart}T00:00:00Z`) - 2 * 3600e3;
const HOUR = 3600e3, M15 = 15 * 60e3;
const SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "NZDUSD", "USDCAD", "USDCHF", "XAUUSD"];

// --- server time (Europe/Athens) to UTC
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
function readTable(file) {
  const buffer = readFileSync(file);
  const text = buffer[0] === 0xff && buffer[1] === 0xfe ? buffer.toString("utf16le") : buffer.toString("utf8");
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  const head = lines[0].split("\t").map((name) => name.replace(/[<>]/g, "").trim());
  return lines.slice(1).map((line) => { const cells = line.split("\t"); return Object.fromEntries(head.map((name, i) => [name, cells[i]])); });
}
function loadBars(symbol, timeframe) {
  return readTable(path.join(config.dataDir, `${symbol}_${timeframe}.csv`)).map((r) => ({
    time: serverToUtc(r.DATE.replaceAll(".", "-"), (r.TIME ?? "00:00").slice(0, 5)),
    open: +r.OPEN, high: +r.HIGH, low: +r.LOW, close: +r.CLOSE,
  }));
}
function atrSeries(bars, period) {
  const out = new Array(bars.length).fill(NaN);
  let sum = 0, count = 0, last = NaN;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], pc = bars[i - 1].close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    if (count < period) { sum += tr; count++; last = count === period ? sum / period : NaN; } else last = (last * (period - 1) + tr) / period;
    out[i] = last;
  }
  return out;
}

// --- the calendar: important releases with an exact time, a forecast and a verdict of the terminal
const shift = (config.calendar.exportOffsetHours ?? 0) * HOUR;
const rows = readTable(config.calendar.file);
const hasUtc = rows[0].UTC !== undefined;
const events = [];
for (const r of rows) {
  if (r.IMPORTANCE !== "HIGH" || r.TIMEMODE !== "DATETIME") continue;
  const [date, clock] = hasUtc ? r.UTC.split(" ") : [r.DATE, r.TIME];
  const time = Date.parse(`${date.replaceAll(".", "-")}T${clock.slice(0, 5)}:00Z`) - (hasUtc ? 0 : shift);
  if (!(time >= DEV_START && time < DEV_END)) continue;
  events.push({ time, currency: r.CURRENCY, code: r.EVENT_CODE, actual: r.ACTUAL === "" ? null : +r.ACTUAL, forecast: r.FORECAST === "" ? null : +r.FORECAST, impact: +r.IMPACT, z: 0 });
}
const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"];
const mine = events.filter((e) => CURRENCIES.includes(e.currency));
console.log(`dev: HIGH releases with an exact time: ${events.length}; of the eight currencies: ${mine.length}`);
const withBoth = mine.filter((e) => e.actual !== null && e.forecast !== null);
console.log(`  with a fact and a forecast: ${withBoth.length}; fact differs from forecast: ${withBoth.filter((e) => e.actual !== e.forecast).length}`);
console.log(`  terminal verdict (IMPACT) 0/1/2: ${[0, 1, 2].map((k) => mine.filter((e) => e.impact === k).length).join(" / ")}`);
// Does the verdict follow fact minus forecast? 1 should mean good for the currency.
const agree = { higherGood: 0, higherBad: 0 };
const byCode = new Map();
for (const e of withBoth) {
  if (e.impact === 0 || e.actual === e.forecast) continue;
  const up = e.actual > e.forecast;
  const good = e.impact === 1;
  const key = e.code;
  const c = byCode.get(key) ?? { same: 0, inverse: 0, currency: e.currency };
  if (up === good) c.same++; else c.inverse++;
  byCode.set(key, c);
  if (up === good) agree.higherGood++; else agree.higherBad++;
}
console.log(`  verdict "good" when the fact is above forecast: ${agree.higherGood}; when it is below: ${agree.higherBad} (inverse indicators such as unemployment)`);
console.log(`  codes where the verdict is not one-sided: ${[...byCode.entries()].filter(([, c]) => c.same > 0 && c.inverse > 0).map(([k, c]) => `${k} ${c.same}/${c.inverse}`).slice(0, 12).join(", ") || "none"}`);

// The size of a surprise against the usual surprise of the same release (its standard deviation on dev).
const spread = new Map();
for (const e of withBoth) spread.set(e.code, [...(spread.get(e.code) ?? []), e.actual - e.forecast]);
for (const e of withBoth) {
  const list = spread.get(e.code);
  const m0 = list.reduce((a, b) => a + b, 0) / list.length;
  const sd = Math.sqrt(list.reduce((a, b) => a + (b - m0) ** 2, 0) / Math.max(1, list.length - 1));
  e.z = list.length >= 10 && sd > 0 ? Math.abs(e.actual - e.forecast) / sd : 0;
}

// --- one signal per currency and moment: the releases must not contradict each other
const groups = new Map();
for (const e of mine) {
  if (e.impact === 0) continue;
  const key = `${e.currency} ${e.time}`;
  const g = groups.get(key) ?? { currency: e.currency, time: e.time, plus: 0, minus: 0, codes: [], z: 0 };
  g.z = Math.max(g.z, e.z);
  if (e.impact === 1) g.plus++; else g.minus++;
  g.codes.push(e.code);
  groups.set(key, g);
}
const signals = [...groups.values()].filter((g) => g.plus === 0 || g.minus === 0).map((g) => ({ ...g, sign: g.plus > 0 ? 1 : -1 }));
console.log(`moments with a verdict: ${groups.size}; unanimous: ${signals.length}; contradictory (skipped): ${groups.size - signals.length}`);

// --- prices
const data = Object.fromEntries(SYMBOLS.map((symbol) => {
  const m15 = loadBars(symbol, "M15");
  const d1 = loadBars(symbol, "D1");
  return [symbol, { m15, index: new Map(m15.map((b, i) => [b.time, i])), d1, atr: atrSeries(d1, 14) }];
}));
/** The sign of the instrument's move when the currency strengthens. */
function effect(symbol, currency) {
  if (symbol === "XAUUSD") return currency === "USD" ? -1 : 0;
  if (symbol.slice(0, 3) === currency) return 1;
  if (symbol.slice(3, 6) === currency) return -1;
  return 0;
}
const HORIZONS = [1, 4, 8, 24];
function observe(list) {
const obs = [];
for (const s of list) {
  for (const symbol of SYMBOLS) {
    const side = effect(symbol, s.currency) * s.sign;
    if (side === 0) continue;
    const { m15, d1, atr } = data[symbol];
    // The bar the release falls into, and the first bar that opens after the release.
    let lo = 0, hi = m15.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (m15[mid].time <= s.time) lo = mid + 1; else hi = mid; }
    const entryIndex = lo;
    const entry = m15[entryIndex];
    const releaseBar = m15[entryIndex - 1];
    if (entry === undefined || releaseBar === undefined) continue;
    // No market at that moment (weekend, holiday, a hole): skip.
    if (entry.time - s.time > M15 || s.time - releaseBar.time >= M15) continue;
    let di = -1;
    for (let k = d1.length - 1; k >= 0; k--) if (d1[k].time + 24 * HOUR <= s.time) { di = k; break; }
    const a = di < 0 ? NaN : atr[di];
    if (!(a > 0)) continue;
    const row = { symbol, currency: s.currency, time: s.time, codes: s.codes, z: s.z, side, first: (side * (entry.open - releaseBar.open)) / a, drift: {} };
    for (const h of HORIZONS) {
      // The last bar that closes by entry + h hours.
      const target = entry.time + h * HOUR;
      let j = entryIndex;
      while (j + 1 < m15.length && m15[j + 1].time + M15 <= target) j++;
      const bar = m15[j];
      // A weekend in between makes the horizon something else: keep only uninterrupted ones.
      row.drift[h] = bar.time + M15 === target ? (side * (bar.close - entry.open)) / a : null;
    }
    obs.push(row);
  }
}
return obs;
}
const obs = observe(signals);

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f = (x, d = 3) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
/** Mean and its standard error with all instruments of one release moment averaged into one observation. */
function clustered(list, valueOf) {
  const byMoment = new Map();
  for (const o of list) { const v = valueOf(o); if (v === null || Number.isNaN(v)) continue; const k = `${o.currency} ${o.time}`; byMoment.set(k, [...(byMoment.get(k) ?? []), v]); }
  const means = [...byMoment.values()].map(mean);
  const m = mean(means);
  const sd = Math.sqrt(mean(means.map((x) => (x - m) ** 2)) * (means.length / Math.max(1, means.length - 1)));
  return { n: means.length, m, se: sd / Math.sqrt(Math.max(1, means.length)) };
}
function show(label, list) {
  const first = clustered(list, (o) => o.first);
  const parts = HORIZONS.map((h) => { const c = clustered(list, (o) => o.drift[h]); return `+${h}h ${f(c.m)} (t ${f(c.m / c.se, 1)})`; });
  console.log(`${label.padEnd(34)} moments ${String(first.n).padStart(4)} | first 15 min ${f(first.m)} (t ${f(first.m / first.se, 1)}) | then ${parts.join(", ")}`);
}
console.log(`\nobservations (moment x instrument): ${obs.length}. Moves are in daily ATR(14), signed by the surprise; "then" is from the open of the bar after the release.`);
console.log(`costs of a round trip are about 0.02-0.04 ATR for the currencies and gold.`);
show("all", obs);
for (const currency of CURRENCIES) show(`news of ${currency}`, obs.filter((o) => o.currency === currency));
for (const symbol of SYMBOLS) show(`on ${symbol}`, obs.filter((o) => o.symbol === symbol));
console.log("\nby release (the most frequent codes; a moment with several releases counts under each):");
const codeCount = new Map();
for (const o of obs) for (const code of new Set(o.codes)) codeCount.set(code, (codeCount.get(code) ?? 0) + 1);
for (const [code] of [...codeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22)) show(`  ${code}`.slice(0, 34), obs.filter((o) => o.codes.includes(code)));
console.log("\nby the size of the first reaction (did the market itself take the news as big?):");
const firstAbs = obs.map((o) => o.first).sort((a, b) => a - b);
const q = (p) => firstAbs[Math.floor(p * firstAbs.length)];
show("  first move against the surprise", obs.filter((o) => o.first < 0));
show("  first move 0 to 0.1 ATR", obs.filter((o) => o.first >= 0 && o.first < 0.1));
show("  first move 0.1 to 0.25 ATR", obs.filter((o) => o.first >= 0.1 && o.first < 0.25));
show("  first move over 0.25 ATR", obs.filter((o) => o.first >= 0.25));
console.log(`  (quartiles of the first move: ${f(q(0.25))}, ${f(q(0.5))}, ${f(q(0.75))})`);
console.log("\nby year:");
for (let y = 2015; y <= 2021; y++) show(`  ${y}`, obs.filter((o) => new Date(o.time).getUTCFullYear() === y));

// --- stricter cuts
console.log("\nstricter cuts:");
const isOil = (code) => /crude-oil|oil-stocks|gasoline|distillate/.test(code);
show("  without oil inventories", obs.filter((o) => !o.codes.some(isOil)));
show("  surprise under 1 sd", obs.filter((o) => o.z > 0 && o.z < 1));
show("  surprise 1 to 2 sd", obs.filter((o) => o.z >= 1 && o.z < 2));
show("  surprise over 2 sd", obs.filter((o) => o.z >= 2));
console.log("\nthe headline releases, each by its own verdict whatever else came out at that moment:");
for (const pattern of ["nonfarm-payrolls", "core-consumer-price-index-mm|consumer-price-index-mm|core-cpi-mm|cpi-mm", "interest-rate-decision", "gdp-qq|gross-domestic-product-qq", "retail-sales-mm", "ism-manufacturing-pmi", "unemployment-rate"]) {
  const re = new RegExp(`(^|-)(${pattern})$`);
  const own = mine.filter((e) => e.impact !== 0 && re.test(e.code)).map((e) => ({ currency: e.currency, time: e.time, codes: [e.code], z: e.z, sign: e.impact === 1 ? 1 : -1 }));
  show(`  ${pattern}`.slice(0, 34), observe(own));
}

// --- one minute after the release, on the three pairs with M1 files
console.log("\nentry one minute after the release (M1 files of EURUSD, GBPUSD, USDJPY; moves in daily ATR):");
import { createReadStream, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
const MIN = 60e3;
const marks = [5, 15, 60];
for (const symbol of ["EURUSD", "GBPUSD", "USDJPY"]) {
  const file = readdirSync(config.dataDir).find((name) => name.startsWith(`${symbol}_M1_`));
  if (file === undefined) continue;
  const wanted = signals.filter((s) => effect(symbol, s.currency) !== 0);
  const need = new Set();
  for (const s of wanted) for (const k of [0, 1, ...marks.map((m) => m)]) need.add(s.time + k * MIN);
  const bars = new Map();
  const lines = createInterface({ input: createReadStream(path.join(config.dataDir, file), { encoding: "utf8" }) });
  let first = true;
  for await (const line of lines) {
    if (first) { first = false; continue; }
    const date = line.slice(0, 10);
    if (date < "2015.02.02" || date >= config.datasets.testStart.replaceAll("-", ".")) continue;
    const cells = line.split("\t");
    const time = serverToUtc(date.replaceAll(".", "-"), cells[1].slice(0, 5));
    if (need.has(time)) bars.set(time, { open: +cells[2], close: +cells[5] });
  }
  const { d1, atr } = data[symbol];
  const rowsM1 = [];
  for (const s of wanted) {
    const side = effect(symbol, s.currency) * s.sign;
    const release = bars.get(s.time), entry = bars.get(s.time + MIN);
    if (release === undefined || entry === undefined) continue;
    let di = -1;
    for (let k = d1.length - 1; k >= 0; k--) if (d1[k].time + 24 * HOUR <= s.time) { di = k; break; }
    const a = di < 0 ? NaN : atr[di];
    if (!(a > 0)) continue;
    const row = { currency: s.currency, time: s.time, z: s.z, first: (side * (entry.open - release.open)) / a, drift: {} };
    // The move from the entry to the open of the bar k minutes after the release.
    for (const m of marks) { const b = bars.get(s.time + m * MIN); row.drift[m] = b === undefined ? null : (side * (b.open - entry.open)) / a; }
    rowsM1.push(row);
  }
  const line1 = (label, list) => {
    const c0 = clustered(list, (o) => o.first);
    console.log(`  ${symbol} ${label.padEnd(22)} moments ${String(c0.n).padStart(4)} | first minute ${f(c0.m)} (t ${f(c0.m / c0.se, 1)}) | then ${marks.map((m) => { const c = clustered(list, (o) => o.drift[m]); return `to +${m} min ${f(c.m)} (t ${f(c.m / c.se, 1)})`; }).join(", ")}`);
  };
  line1("all", rowsM1);
  line1("surprise over 1 sd", rowsM1.filter((o) => o.z >= 1));
  line1("first minute > 0.05 ATR", rowsM1.filter((o) => o.first > 0.05));
}
