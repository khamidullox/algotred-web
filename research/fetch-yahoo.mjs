// Downloads daily index prices from the public Yahoo Finance chart endpoint
// and writes them as MT5-style files for the research stand (TZ 17.18).
// These are exchange (cash) indices, not a broker's CFD: a research proxy.
// The engine wants D1, H1 and M15 files; with daily data all three hold one
// bar a day at 00:00, as the first years of the US index exports do.
// Usage: node research/fetch-yahoo.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = "data/raw/research-yahoo";
const FROM = Date.UTC(2012, 0, 1) / 1000;
const TO = Math.floor(Date.now() / 1000);

/** Our name for the instrument and the Yahoo ticker. */
const INDICES = [
  ["GER40", "^GDAXI"],
  ["UK100", "^FTSE"],
  ["JP225", "^N225"],
  ["FRA40", "^FCHI"],
  ["EU50", "^STOXX50E"],
  ["AUS200", "^AXJO"],
  ["HK50", "^HSI"],
  // The US indices again, from the exchange: to see how far this proxy is from the broker's CFD files.
  ["SPXCASH", "^GSPC"],
  ["NDXCASH", "^NDX"],
  ["DJICASH", "^DJI"],
  ["RUTCASH", "^RUT"],
];

mkdirSync(OUT, { recursive: true });
const summary = [];
for (const [name, ticker] of INDICES) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${FROM}&period2=${TO}&interval=1d&events=history`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`${ticker}: HTTP ${response.status}`);
  const body = await response.json();
  const result = body.chart?.result?.[0];
  if (result === undefined) throw new Error(`${ticker}: no data in the answer`);
  const zone = result.meta.exchangeTimezoneName;
  const localDate = new Intl.DateTimeFormat("sv-SE", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  const quote = result.indicators.quote[0];
  const rows = [];
  let dropped = 0;
  result.timestamp.forEach((seconds, i) => {
    const [open, high, low, close] = [quote.open[i], quote.high[i], quote.low[i], quote.close[i]];
    const ok = [open, high, low, close].every((value) => typeof value === "number" && Number.isFinite(value) && value > 0) && high >= Math.max(open, close) - 1e-6 && low <= Math.min(open, close) + 1e-6;
    if (!ok) { dropped++; return; }
    const date = localDate.format(new Date(seconds * 1000)).replaceAll("-", ".");
    // One bar per exchange day: a repeated date (the unfinished current day) keeps the last one.
    if (rows.length > 0 && rows.at(-1).date === date) rows.pop();
    rows.push({ date, open, high, low, close });
  });
  // The last row may be a day that is still trading.
  rows.pop();
  const price = (value) => value.toFixed(2);
  const daily = ["<DATE>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>", ...rows.map((r) => `${r.date}\t${price(r.open)}\t${price(r.high)}\t${price(r.low)}\t${price(r.close)}\t1\t0\t0`)].join("\r\n");
  const intraday = ["<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>", ...rows.map((r) => `${r.date}\t00:00:00\t${price(r.open)}\t${price(r.high)}\t${price(r.low)}\t${price(r.close)}\t1\t0\t0`)].join("\r\n");
  writeFileSync(path.join(OUT, `${name}_D1.csv`), daily + "\r\n");
  writeFileSync(path.join(OUT, `${name}_H1.csv`), intraday + "\r\n");
  writeFileSync(path.join(OUT, `${name}_M15.csv`), intraday + "\r\n");
  summary.push({ name, ticker, currency: result.meta.currency, zone, rows: rows.length, dropped, first: rows[0].date, last: rows.at(-1).date, lastClose: Number(price(rows.at(-1).close)) });
  console.log(`${name.padEnd(8)} ${ticker.padEnd(10)} ${result.meta.currency} ${zone.padEnd(18)} rows ${rows.length}, dropped ${dropped}, ${rows[0].date} .. ${rows.at(-1).date}, last close ${price(rows.at(-1).close)}`);
}
writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
