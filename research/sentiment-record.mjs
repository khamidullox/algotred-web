// Records the crowd's side once a run (TZ 17.44): the share of IG client accounts
// that are long, as shown on IG's public market pages for the seven dollar pairs
// and gold. No history of this is openly available, so it is collected here for a
// test in a year or two. One plain request a market, a pause between them, no
// sign-in, nothing beyond what the public page shows.
//
// Output (not in git, as everything under data/raw):
//   data/raw/sentiment/ig-client-sentiment.csv   utc,symbol,long_pct,short_pct
//   data/raw/sentiment/record.log                one line a run
// A run within MIN_HOURS of the last recorded one writes nothing, so a missed
// schedule caught up later does not double the rows.
//
// Usage: node research/sentiment-record.mjs          record now
//        node research/sentiment-record.mjs status   how many snapshots there are and when the last one was
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "data", "raw", "sentiment"), FILE = path.join(DIR, "ig-client-sentiment.csv"), LOG = path.join(DIR, "record.log");
const MARKETS = {
  EURUSD: "forex/markets-forex/eur-usd", GBPUSD: "forex/markets-forex/gbp-usd", USDJPY: "forex/markets-forex/usd-jpy", AUDUSD: "forex/markets-forex/aud-usd",
  NZDUSD: "forex/markets-forex/nzd-usd", USDCAD: "forex/markets-forex/usd-cad", USDCHF: "forex/markets-forex/usd-chf", XAUUSD: "commodities/markets-commodities/gold",
};
const BASE = "https://www.ig.com/en/";
const MIN_HOURS = 3, PAUSE_MS = 2500, TIMEOUT_MS = 40000;
const AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => { mkdirSync(DIR, { recursive: true }); appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); console.log(line); };
function rows() {
  if (!existsSync(FILE)) return [];
  return readFileSync(FILE, "utf8").split(/\r?\n/).slice(1).filter((l) => l.length > 0).map((l) => { const [utc, symbol, long, short] = l.split(","); return { utc, symbol, long: +long, short: +short }; });
}
/** The share of client accounts that are long, from the page's own sentiment bar; the two figures shown there must add up to 100. */
function parse(html) {
  const bar = html.match(/--long-percent:\s*([0-9]+(?:\.[0-9]+)?)%/);
  if (bar === null) return null;
  const long = +bar[1];
  const shown = html.slice(bar.index, bar.index + 400).match(/<p>\s*([0-9]+(?:\.[0-9]+)?)%\s*<\/p>\s*<p>\s*([0-9]+(?:\.[0-9]+)?)%\s*<\/p>/);
  if (!(long >= 0 && long <= 100)) return null;
  if (shown !== null && (Math.abs(+shown[1] - long) > 0.51 || Math.abs(+shown[1] + +shown[2] - 100) > 1.01)) return null; // the bar and the text disagree
  return { long, short: shown !== null ? +shown[2] : Math.round((100 - long) * 10) / 10 };
}

if (process.argv[2] === "status") {
  const all = rows(), times = [...new Set(all.map((r) => r.utc))];
  console.log(times.length === 0 ? "no snapshots yet" : `${times.length} snapshots from ${times[0]} to ${times.at(-1)}; ${new Set(times.map((t) => t.slice(0, 10))).size} different days`);
  for (const r of all.filter((x) => x.utc === times.at(-1))) console.log(`  ${r.symbol}: ${r.long}% long, ${r.short}% short`);
  process.exit(0);
}

const last = rows().at(-1);
if (last !== undefined && Date.now() - Date.parse(last.utc) < MIN_HOURS * 3600e3) { log(`skipped: the last snapshot is from ${last.utc}, less than ${MIN_HOURS} hours ago`); process.exit(0); }
const stamp = new Date().toISOString().slice(0, 19) + "Z", got = [], failed = [];
for (const [symbol, page] of Object.entries(MARKETS)) {
  try {
    const res = await fetch(BASE + page, { headers: { "User-Agent": AGENT, "Accept-Language": "en" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const value = res.ok ? parse(await res.text()) : null;
    if (value === null) failed.push(`${symbol} (${res.ok ? "no figure on the page" : `HTTP ${res.status}`})`); else got.push(`${stamp},${symbol},${value.long},${value.short}`);
  } catch (e) { failed.push(`${symbol} (${e.name})`); }
  await sleep(PAUSE_MS);
}
if (got.length > 0) {
  mkdirSync(DIR, { recursive: true });
  if (!existsSync(FILE)) writeFileSync(FILE, "utc,symbol,long_pct,short_pct\n");
  appendFileSync(FILE, got.join("\n") + "\n");
}
log(`${got.length} of ${Object.keys(MARKETS).length} recorded at ${stamp}${failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""}`);
process.exit(got.length === 0 ? 1 : 0);
