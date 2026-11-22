// Two frozen rules "the day after a large change of the yield difference"
// (TZ 17.33) and their control, with the costs of the project: the Ask is the
// Bid plus the spread of the bar (not below the floor of the config), slippage
// on every fill, the commission of the config. No swap: every trade is opened
// and closed inside one server day. A simulator of its own, as bank-sim.mjs.
//
// Pairs: six dollar pairs (New Zealand has no yield file) and the 15 crosses of
// the same six currencies. The prices of a cross are built from its two dollar
// pairs at the same moments; its costs are those of the broker's own cross as
// in TZ 17.29: commission and slippage of the config and the spread ASSUMED to
// be 0.7 of the two dollar spreads.
//
// Pointer of a pair: for each of its two currencies the mean of the 2-year and
// the 5-year government-bond yield; the pointer is base minus quote. A yield
// missing on a day takes the last value not older than three business days.
//
//   RateShockNextDay    after the close of a server day on which the pointer
//                       changed by at least 2 of its usual daily changes: at
//                       02:00 of the next trading day the pair in the direction
//                       of the change (the currency whose yields rose is
//                       bought); out at 22:00 of the same day.
//   RateShockConfirmed  the same, only when the pair itself moved that day by at
//                       least 1 of its usual daily moves in the same direction.
//   control             no yields: the day after the pair's own move of at least
//                       2 usual daily moves, in its direction.
// "Usual" is the root mean square over the 250 trading days before (120 at
// least). No stop is simulated: a trade lasts 20 hours; results are in basis
// points of the price.
//
// Usage: node research/rate-shock-sim.mjs dev|test [file.json]
//        node research/rate-shock-sim.mjs holdout --i-understand-holdout [file.json]
import { readFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(readFileSync("config/default.json", "utf8"));
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

/** The frozen numbers of TZ 17.33. */
const FROZEN = { shock: 2, confirmedBy: 1, controlDay: 2, usualDays: 250, minUsual: 120, fillBusinessDays: 3, entryMinute: 2 * 60, exitMinute: 22 * 60, crossSpreadShare: 0.7 };
const DOLLAR = { EURUSD: ["EUR", "USD"], GBPUSD: ["GBP", "USD"], USDJPY: ["USD", "JPY"], AUDUSD: ["AUD", "USD"], USDCAD: ["USD", "CAD"], USDCHF: ["USD", "CHF"] };
const USD_PAIR = { EUR: ["EURUSD", false], GBP: ["GBPUSD", false], AUD: ["AUDUSD", false], JPY: ["USDJPY", true], CAD: ["USDCAD", true], CHF: ["USDCHF", true] };
const CROSSES = ["EURGBP", "EURAUD", "EURJPY", "EURCAD", "EURCHF", "GBPAUD", "GBPJPY", "GBPCAD", "GBPCHF", "AUDJPY", "AUDCAD", "AUDCHF", "CADJPY", "CADCHF", "CHFJPY"];

const mean = (xs) => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
function tOf(xs) {
  if (xs.length < 3) return NaN;
  const m = mean(xs);
  const sd = Math.sqrt(mean(xs.map((x) => (x - m) ** 2)) * (xs.length / (xs.length - 1)));
  return sd === 0 ? NaN : m / (sd / Math.sqrt(xs.length));
}
const f = (x, d = 2) => (!Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(d));
const dayNumber = (date) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)) / 86400e3;
const dateOf = (day) => new Date(day * 86400e3).toISOString().slice(0, 10);
const weekdayOf = (day) => (day + 4) % 7;
const READ_FROM = dateOf(dayNumber(FROM) - 420); // the usual sizes need the 250 trading days before the first trade
const MONTHS = (Date.parse(TO) - Date.parse(FROM)) / (86400e3 * 30.4375);

// ------------------------------------------------------------------ prices: the opens at 02:00 and 22:00 of every server day
function loadPair(symbol) {
  const own = config.symbols[symbol];
  const point = 10 ** -own.digits, pip = point * 10;
  const floor = own.minSpreadPoints ?? config.costs.minSpreadPoints;
  const commission = (own.commissionPerLotRoundTrip ?? config.costs.commissionPerLotRoundTrip) / own.contractSize;
  const usdBase = own.usdSide === "base";
  const lines = readFileSync(`${config.dataDir}/${symbol}_M15.csv`, "utf8").split(/\r?\n/);
  const days = new Map();
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split("\t");
    if (p.length < 9) continue;
    const date = p[0].replaceAll(".", "-");
    if (date < READ_FROM) continue;
    if (date > TO) break; // nothing after the end of the set is read
    const minute = +p[1].slice(0, 2) * 60 + +p[1].slice(3, 5);
    if (minute !== FROZEN.entryMinute && minute !== FROZEN.exitMinute) continue;
    if (!days.has(date)) days.set(date, { date, day: dayNumber(date) });
    const o = +p[2], d = days.get(date), spread = (Math.max(+p[8], floor) * point) / o; // the spread as a share of the price
    if (minute === FROZEN.entryMinute) { d.open = o; d.openSpread = spread; } else { d.close = o; d.closeSpread = spread; }
  }
  const list = [...days.values()].filter((d) => d.open !== undefined && d.close !== undefined);
  for (const d of list) d.fixed = (2 * config.costs.slippagePips * pip) / d.open + (usdBase ? commission : commission / d.open); // slippage of two fills and the commission, as a share of the price
  return { symbol, list, index: new Map(list.map((d, i) => [d.date, i])) };
}
const dollar = new Map(Object.keys(DOLLAR).map((s) => [s, loadPair(s)]));
function buildCross(name) {
  const base = name.slice(0, 3), quote = name.slice(3), [bp, bInv] = USD_PAIR[base], [qp, qInv] = USD_PAIR[quote];
  const B = dollar.get(bp), Q = dollar.get(qp), pip = quote === "JPY" ? 0.01 : 0.0001;
  const usd = (x, inv) => (inv ? 1 / x : x); // dollars for one unit of the currency
  const list = [];
  for (const b of B.list) {
    const k = Q.index.get(b.date);
    if (k === undefined) continue;
    const q = Q.list[k], open = usd(b.open, bInv) / usd(q.open, qInv);
    list.push({
      date: b.date, day: b.day, open, close: usd(b.close, bInv) / usd(q.close, qInv),
      openSpread: FROZEN.crossSpreadShare * (b.openSpread + q.openSpread), closeSpread: FROZEN.crossSpreadShare * (b.closeSpread + q.closeSpread),
      fixed: (2 * config.costs.slippagePips * pip) / open + config.costs.commissionPerLotRoundTrip / 100000 / usd(b.open, bInv),
    });
  }
  return { symbol: name, list, index: new Map(list.map((d, i) => [d.date, i])) };
}
const PAIRS = [...Object.entries(DOLLAR).map(([s, [base, quote]]) => ({ P: dollar.get(s), base, quote, cross: false })), ...CROSSES.map((s) => ({ P: buildCross(s), base: s.slice(0, 3), quote: s.slice(3), cross: true }))];

// ------------------------------------------------------------------ yields
const yields = new Map();
{
  const lines = readFileSync("data/raw/research-rates/yields.csv", "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = lines[0].split(",");
  for (const h of head.slice(1)) yields.set(h, new Map());
  for (const l of lines.slice(1)) {
    const c = l.split(",");
    if (c[0] > TO) break; // nothing after the end of the set is read
    head.slice(1).forEach((h, k) => { if (c[k + 1] !== undefined && c[k + 1] !== "") yields.get(h).set(c[0], +c[k + 1]); });
  }
}
/** The value of a series on a date: that day's, or the last one not older than three business days. */
function at(seriesMap, date) {
  let day = dayNumber(date);
  for (let back = 0, business = 0; business <= FROZEN.fillBusinessDays && back < 10; back++, day--) {
    const v = seriesMap.get(dateOf(day));
    if (v !== undefined) return v;
    const wd = weekdayOf(day);
    if (wd >= 1 && wd <= 5) business++;
  }
  return NaN;
}
const sector = (currency, date) => (at(yields.get(`${currency}2`), date) + at(yields.get(`${currency}5`), date)) / 2;

// ------------------------------------------------------------------ the trades
/** One trade of one day: in at 02:00, out at 22:00. gross is Bid to Bid; net has the spread on the side that pays it, slippage and commission. */
function trade(symbol, cross, d, dir) {
  const gross = dir * (d.close / d.open - 1) * 1e4;
  return { pair: symbol, cross, date: d.date, day: d.day, dir, gross, net: gross - ((dir > 0 ? d.openSpread : d.closeSpread) + d.fixed) * 1e4 };
}
const rules = { RateShockNextDay: [], RateShockConfirmed: [], control: [] };
for (const { P, base, quote, cross } of PAIRS) {
  const n = P.list.length;
  const level = P.list.map((d) => sector(base, d.date) - sector(quote, d.date));
  const close = P.list.map((d) => Math.log(d.close));
  for (let i = FROZEN.minUsual + 1; i < n - 1; i++) {
    const next = P.list[i + 1];
    if (next.date < FROM) continue;
    // The usual daily change of the pointer and the usual daily move of the pair, over the 250 trading days before this one.
    let sx = 0, nx = 0, sy = 0, ny = 0;
    for (let k = Math.max(1, i - FROZEN.usualDays); k < i; k++) {
      const x = level[k] - level[k - 1], y = close[k] - close[k - 1];
      if (Number.isFinite(x)) { sx += x * x; nx++; }
      sy += y * y; ny++;
    }
    const own = close[i] - close[i - 1], ownSize = ny >= FROZEN.minUsual ? own / Math.sqrt(sy / ny) : NaN;
    if (Math.abs(ownSize) >= FROZEN.controlDay) rules.control.push(trade(P.symbol, cross, next, Math.sign(own)));
    const change = level[i] - level[i - 1];
    if (!Number.isFinite(change) || change === 0 || nx < FROZEN.minUsual || sx === 0) continue;
    if (Math.abs(change) / Math.sqrt(sx / nx) < FROZEN.shock) continue;
    const dir = Math.sign(change);
    rules.RateShockNextDay.push(trade(P.symbol, cross, next, dir));
    if (dir * ownSize >= FROZEN.confirmedBy) rules.RateShockConfirmed.push(trade(P.symbol, cross, next, dir));
  }
}

/** t by weeks: the number of a week is the sum of its trades. */
function tByWeeks(recs, value) {
  const weeks = new Map();
  for (const r of recs) { const w = Math.floor((r.day + 3) / 7); weeks.set(w, (weeks.get(w) ?? 0) + value(r)); }
  return tOf([...weeks.values()]);
}
console.log(`${datasetArg} ${FROM} .. ${TO}; basis points of the price a trade; t by weeks, the number of a week being the sum of its trades`);
const controlGross = mean(rules.control.map((r) => r.gross));
console.log(`\ncontrol (the day after the pair's own large day, no yields): trades ${rules.control.length}, before costs ${f(controlGross)} bp (t ${f(tByWeeks(rules.control, (r) => r.gross), 1)}), after costs ${f(mean(rules.control.map((r) => r.net)))} bp`);
const saved = { control: { trades: rules.control.length, grossMean: controlGross } };
for (const name of ["RateShockNextDay", "RateShockConfirmed"]) {
  const recs = rules[name], gross = mean(recs.map((r) => r.gross)), net = mean(recs.map((r) => r.net));
  const names = [...new Set(recs.map((r) => r.pair))], years = [...new Set(recs.map((r) => r.date.slice(0, 4)))].sort();
  console.log(`\n=== ${name} ===`);
  console.log(`trades ${recs.length} (${(recs.length / MONTHS).toFixed(1)} a month), in profit ${recs.filter((r) => r.net > 0).length}`);
  console.log(`before costs ${f(gross)} bp (t ${f(tByWeeks(recs, (r) => r.gross), 1)});  after costs ${f(net)} bp (t ${f(tByWeeks(recs, (r) => r.net), 1)});  pairs above zero after costs ${names.filter((p) => mean(recs.filter((r) => r.pair === p).map((r) => r.net)) > 0).length} of ${names.length}`);
  for (const [label, keep] of [["six dollar pairs (costs known)", (r) => !r.cross], ["15 crosses (spread assumed)", (r) => r.cross]]) { const part = recs.filter(keep); console.log(`  ${label}: trades ${part.length}, before costs ${f(mean(part.map((r) => r.gross)))} bp, after costs ${f(mean(part.map((r) => r.net)))} bp (t ${f(tByWeeks(part, (r) => r.net), 1)})`); }
  console.log(`by year, after costs: ${years.map((y) => `${y} ${f(mean(recs.filter((r) => r.date.startsWith(y)).map((r) => r.net)), 1)} (${recs.filter((r) => r.date.startsWith(y)).length})`).join("; ")}`);
  const a = net > 0, b = gross > controlGross;
  console.log(`condition (a) after costs above zero: ${a ? "yes" : "NO"};  (b) before costs above the control: ${b ? "yes" : "NO"};  ${a && b ? "PASSED" : "NOT PASSED"}`);
  saved[name] = { trades: recs, grossMean: gross, netMean: net, tNetByWeeks: tByWeeks(recs, (r) => r.net), passed: a && b };
}
const file = process.argv.find((x) => x.endsWith(".json"));
if (file !== undefined) writeFileSync(file, JSON.stringify({ dataset: datasetArg, from: FROM, to: TO, frozen: FROZEN, rules: saved }, null, 1));
