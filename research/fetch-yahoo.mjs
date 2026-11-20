// Downloads daily prices from the public Yahoo Finance chart endpoint and
// writes them as MT5-style files for the research stand (TZ 17.18, 17.22).
// These are exchange prices, not a broker's CFD: a research proxy.
// The engine wants D1, H1 and M15 files; with daily data all three hold one
// bar a day. In the intraday files that bar is stamped 23:00, the last hour
// of the day: the engine takes an hourly bar as closed an hour after its
// stamp, so a bar stamped 00:00 "closes" 23 hours before its day does, the
// daily signal is seen a day late and the entry comes a day after the rule
// asks for it (TZ 17.22; the runs of 17.18 on these files had that delay).
// Usage: node research/fetch-yahoo.mjs indices|stocks
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * The three baskets of TZ 17.22, fixed before any run; the lists are in share-baskets.json.
 * - BROKER: the US shares FundedNext lists as CFDs (help centre, read 2026-11-20).
 * - ETFS: the four broad US index funds and the nine sector funds that existed in 2015.
 * - DOW2015: the thirty members of the Dow Jones Industrial Average on 2 February 2015, the first
 *   day of `dev` (AT&T is in, Apple is not yet). UTX is now RTX; DD is today's DuPont.
 */
const BASKETS = JSON.parse(readFileSync(new URL("./share-baskets.json", import.meta.url), "utf8"));
/** A share's file name: tickers of one or two letters are too short for a symbol name. */
const shareSymbol = (ticker) => `ST${ticker}`;

/**
 * What a round trip in a share CFD costs, as a share of the price, written into the spread column so
 * that it follows the price (a fixed number of points would be absurd for a share that rose a
 * hundredfold): spread 0.05%, commission 0.004% a side, slippage 0.01% a side.
 */
const SHARE_COST = 0.0005 + 2 * 0.00004 + 2 * 0.0001;

async function fetchDaily(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${FROM}&period2=${TO}&interval=1d&events=history`;
  // The connection drops now and then: a few tries with a pause, and a short pause between tickers.
  let body;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
      break;
    } catch (error) {
      if (attempt === 5) throw new Error(`${ticker}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
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
  return { rows, dropped, currency: result.meta.currency, zone };
}

function write(name, rows, digits, costShare) {
  const point = 10 ** -digits;
  const price = (value) => value.toFixed(digits);
  const spread = (row) => (costShare === 0 ? 0 : Math.max(1, Math.round((costShare * row.close) / point)));
  const daily = ["<DATE>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>", ...rows.map((r) => `${r.date}\t${price(r.open)}\t${price(r.high)}\t${price(r.low)}\t${price(r.close)}\t1\t0\t${spread(r)}`)].join("\r\n");
  const intraday = ["<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>", ...rows.map((r) => `${r.date}\t23:00:00\t${price(r.open)}\t${price(r.high)}\t${price(r.low)}\t${price(r.close)}\t1\t0\t${spread(r)}`)].join("\r\n");
  writeFileSync(path.join(OUT, `${name}_D1.csv`), daily + "\r\n");
  writeFileSync(path.join(OUT, `${name}_H1.csv`), intraday + "\r\n");
  writeFileSync(path.join(OUT, `${name}_M15.csv`), intraday + "\r\n");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const group = process.argv[2] ?? "indices";
  mkdirSync(OUT, { recursive: true });
  const summary = [];
  if (group === "indices") {
    for (const [name, ticker] of INDICES) {
      const { rows, dropped, currency, zone } = await fetchDaily(ticker);
      write(name, rows, 2, 0);
      summary.push({ name, ticker, currency, zone, rows: rows.length, dropped, first: rows[0].date, last: rows.at(-1).date, lastClose: Number(rows.at(-1).close.toFixed(2)) });
      console.log(`${name.padEnd(8)} ${ticker.padEnd(10)} ${currency} ${zone.padEnd(18)} rows ${rows.length}, dropped ${dropped}, ${rows[0].date} .. ${rows.at(-1).date}, last close ${rows.at(-1).close.toFixed(2)}`);
    }
    writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  } else if (group === "stocks") {
    const tickers = [...new Set(Object.values(BASKETS).flat())];
    for (const ticker of tickers) {
      try {
        const { rows, dropped, currency } = await fetchDaily(ticker);
        // Four decimals: after splits the early prices of some shares are under a dollar.
        write(shareSymbol(ticker), rows, 4, SHARE_COST);
        summary.push({ name: shareSymbol(ticker), ticker, currency, rows: rows.length, dropped, first: rows[0].date, last: rows.at(-1).date, firstClose: Number(rows[0].close.toFixed(4)), lastClose: Number(rows.at(-1).close.toFixed(4)) });
        console.log(`${ticker.padEnd(6)} ${currency} rows ${rows.length}, dropped ${dropped}, ${rows[0].date} ${rows[0].close.toFixed(2)} .. ${rows.at(-1).date} ${rows.at(-1).close.toFixed(2)}`);
      } catch (error) {
        console.log(`${ticker.padEnd(6)} FAILED: ${error.message}`);
      }
    }
    writeFileSync(path.join(OUT, "summary-stocks.json"), JSON.stringify(summary, null, 2));
  } else {
    throw new Error("usage: node research/fetch-yahoo.mjs indices|stocks");
  }
}
