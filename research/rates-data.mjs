// Turns the downloaded government-bond yields and commodity prices into two
// tidy files for the study of TZ 17.33. It only reshapes data; nothing is
// measured here.
//
// Sources, all under data/raw/research-rates (git-ignored), downloaded 2026-11-22:
//   us/YYYY.csv       US Treasury, daily par yield curve
//                     https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/YYYY/all?type=daily_treasury_yield_curve&field_tdr_date_value=YYYY&page&_format=csv
//   de/2y.csv, 5y.csv Bundesbank, term structure of listed Federal securities (Svensson)
//                     https://api.statistiken.bundesbank.de/rest/download/BBSIS/D.I.ZST.ZI.EUR.S1311.B.A604.R02XX.R.A.A._Z._Z.A?format=csv&lang=en  (R05XX for 5 years)
//   jp/jgbcme_all.csv Ministry of Finance Japan, JGB yields
//                     https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv
//   ca/yields.csv     Bank of Canada, benchmark bond yields
//                     https://www.bankofcanada.ca/valet/observations/BD.CDN.2YR.DQ.YLD,BD.CDN.5YR.DQ.YLD/csv?start_date=2014-06-01
//   ch/rendoblid.csv  Swiss National Bank, spot rates on Confederation bonds (ends 2025-07-31 in this download)
//                     https://data.snb.ch/api/cube/rendoblid/data/csv/en
//   uk-archive/x/*.xlsx  Bank of England, nominal spot curve, sheet "4. spot curve"
//                     https://www.bankofengland.co.uk/-/media/boe/files/statistics/yield-curves/glcnominalddata.zip
//   au/f2-2y-5y.csv   Reserve Bank of Australia, table F2 (2-year and 5-year columns). The site refuses scripted
//                     downloads, so the table was opened in the browser and the two columns were copied out.
//   oil/*.json        Yahoo Finance chart endpoint, daily futures: CL=F (WTI), BZ=F (Brent), HG=F (copper)
// New Zealand is missing: the Reserve Bank's file is an .xlsx behind the same kind of refusal.
//
// Output: data/raw/research-rates/yields.csv  date,USD2,USD5,EUR2,...  (per cent a year; empty = no value)
//         data/raw/research-rates/commodities.csv  date,WTI,BRENT,COPPER  (closes; the date is the exchange's own day)
// Usage: node research/rates-data.mjs
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const ROOT = "data/raw/research-rates";
const series = new Map(); // "USD2" -> Map date -> value
const put = (name, date, value) => { if (!Number.isFinite(value)) return; if (!series.has(name)) series.set(name, new Map()); series.get(name).set(date, value); };
const two = (n) => String(n).padStart(2, "0");

// ------------------------------------------------------------------ United States
for (const f of readdirSync(`${ROOT}/us`).filter((x) => x.endsWith(".csv"))) {
  const lines = readFileSync(`${ROOT}/us/${f}`, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = lines[0].split(",").map((h) => h.replaceAll('"', "").trim());
  const i2 = head.indexOf("2 Yr"), i5 = head.indexOf("5 Yr");
  if (i2 < 0 || i5 < 0) throw new Error(`no 2 Yr / 5 Yr column in ${f}`);
  for (const l of lines.slice(1)) {
    const c = l.split(","), [m, d, y] = c[0].split("/");
    const date = `${y}-${two(m)}-${two(d)}`;
    put("USD2", date, parseFloat(c[i2])); put("USD5", date, parseFloat(c[i5]));
  }
}
// ------------------------------------------------------------------ Germany
for (const [file, name] of [["2y.csv", "EUR2"], ["5y.csv", "EUR5"]]) for (const l of readFileSync(`${ROOT}/de/${file}`, "utf8").split(/\r?\n/)) {
  const c = l.split(",");
  if (/^\d{4}-\d{2}-\d{2}$/.test(c[0])) put(name, c[0], parseFloat(c[1]));
}
// ------------------------------------------------------------------ Japan
for (const l of readFileSync(`${ROOT}/jp/jgbcme_all.csv`, "latin1").split(/\r?\n/)) {
  const c = l.split(","), m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(c[0]);
  if (m === null) continue;
  const date = `${m[1]}-${two(m[2])}-${two(m[3])}`;
  put("JPY2", date, parseFloat(c[2])); put("JPY5", date, parseFloat(c[5]));
}
// ------------------------------------------------------------------ Canada
for (const l of readFileSync(`${ROOT}/ca/yields.csv`, "utf8").split(/\r?\n/)) {
  const c = l.split(",").map((x) => x.replaceAll('"', ""));
  if (/^\d{4}-\d{2}-\d{2}$/.test(c[0])) { put("CAD2", c[0], parseFloat(c[1])); put("CAD5", c[0], parseFloat(c[2])); }
}
// ------------------------------------------------------------------ Switzerland
for (const l of readFileSync(`${ROOT}/ch/rendoblid.csv`, "utf8").split(/\r?\n/)) {
  const c = l.split(";").map((x) => x.replaceAll('"', ""));
  if (c[1] === "2J") put("CHF2", c[0], parseFloat(c[2]));
  if (c[1] === "5J") put("CHF5", c[0], parseFloat(c[2]));
}
// ------------------------------------------------------------------ Australia
for (const l of readFileSync(`${ROOT}/au/f2-2y-5y.csv`, "utf8").split(/\r?\n/)) {
  const c = l.split(",");
  if (/^\d{4}-\d{2}-\d{2}$/.test(c[0])) { put("AUD2", c[0], parseFloat(c[1])); put("AUD5", c[0], parseFloat(c[2])); }
}
// ------------------------------------------------------------------ Britain: the sheet "4. spot curve" of the .xlsx files
/** The entries of a zip file wanted by name: name -> text. Only the stored and deflated methods. */
function unzip(buffer, wanted) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error("bad zip directory");
    const method = buffer.readUInt16LE(at + 10), size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28), extra = buffer.readUInt16LE(at + 30), comment = buffer.readUInt16LE(at + 32), local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    if (wanted(name)) {
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const raw = buffer.subarray(start, start + size);
      out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    }
    at += 46 + nameLength + extra + comment;
  }
  return out;
}
/** The rows of one sheet of an .xlsx file: yields [rowNumber, Map column letters -> number or string]. */
function* sheetRows(file, sheetName) {
  const buffer = readFileSync(file);
  const book = unzip(buffer, (n) => n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml");
  const sheet = new RegExp(`<sheet [^>]*name="${sheetName.replace(/[.]/g, "[.]")}"[^>]*r:id="([^"]+)"`).exec(book.get("xl/workbook.xml"));
  if (sheet === null) throw new Error(`no sheet ${sheetName} in ${file}`);
  const rel = [...book.get("xl/_rels/workbook.xml.rels").matchAll(/<Relationship [^>]*>/g)].map((m) => m[0]).find((r) => r.includes(`Id="${sheet[1]}"`));
  const target = /Target="([^"]+)"/.exec(rel)[1].replace(/^\//, "").replace(/^(?!xl\/)/, "xl/");
  const shared = [...(book.get("xl/sharedStrings.xml") ?? "").matchAll(/<si>(.*?)<\/si>/gs)].map((m) => [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(""));
  const xml = unzip(buffer, (n) => n === target).get(target);
  for (const row of xml.matchAll(/<row [^>]*r="(\d+)"[^>]*>(.*?)<\/row>/gs)) {
    const cells = new Map();
    for (const c of row[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const v = /<v>([^<]*)<\/v>/.exec(c[3] ?? "");
      if (v === null) continue;
      cells.set(c[1], /t="s"/.test(c[2]) ? shared[+v[1]] : /t="str"/.test(c[2]) ? v[1] : +v[1]);
    }
    yield [+row[1], cells];
  }
}
for (const f of readdirSync(`${ROOT}/uk-archive/x`).filter((x) => x.endsWith(".xlsx"))) {
  let col2, col5, n = 0;
  for (const [, cells] of sheetRows(`${ROOT}/uk-archive/x/${f}`, "4. spot curve")) {
    if (col2 === undefined) { // the row of maturities in years: 0.5, 1, 1.5, 2 ...
      const two_ = [...cells].find(([, v]) => v === 2), five = [...cells].find(([, v]) => v === 5), half = [...cells].find(([, v]) => v === 0.5);
      if (two_ !== undefined && five !== undefined && half !== undefined) { col2 = two_[0]; col5 = five[0]; }
      continue;
    }
    const serial = cells.get("A");
    if (typeof serial !== "number" || serial < 30000) continue;
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400e3).toISOString().slice(0, 10);
    put("GBP2", date, cells.get(col2)); put("GBP5", date, cells.get(col5)); n++;
  }
  console.log(`Bank of England ${f}: columns ${col2} and ${col5}, ${n} days`);
}

// ------------------------------------------------------------------ write the yields
const NAMES = ["USD2", "USD5", "EUR2", "EUR5", "GBP2", "GBP5", "JPY2", "JPY5", "AUD2", "AUD5", "CAD2", "CAD5", "CHF2", "CHF5"];
const dates = [...new Set(NAMES.flatMap((n) => [...(series.get(n) ?? new Map()).keys()]))].filter((d) => d >= "2014-06-01").sort();
writeFileSync(`${ROOT}/yields.csv`, [`date,${NAMES.join(",")}`, ...dates.map((d) => `${d},${NAMES.map((n) => series.get(n)?.get(d) ?? "").join(",")}`)].join("\n") + "\n");
console.log(`yields.csv: ${dates.length} days, ${dates[0]} .. ${dates.at(-1)}`);
for (const n of NAMES) { const m = series.get(n) ?? new Map(), own = [...m.keys()].filter((d) => d >= "2014-06-01").sort(); console.log(`  ${n}: ${own.length} values, ${own[0]} .. ${own.at(-1)}; on 2015-02-02 ${m.get("2015-02-02")}`); }

// ------------------------------------------------------------------ commodities
const goods = new Map();
for (const [file, name] of [["CLF.json", "WTI"], ["BZF.json", "BRENT"], ["HGF.json", "COPPER"]]) {
  const r = JSON.parse(readFileSync(`${ROOT}/oil/${file}`, "utf8")).chart.result[0];
  // The day of a bar is the exchange's own calendar day. The offset in the file's header is today's offset only: used for
  // every bar it puts all summer bars a day early, which lets a study see the next day's close (it did, once: TZ 17.33).
  const close = r.indicators.quote[0].close;
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: r.meta.exchangeTimezoneName, year: "numeric", month: "2-digit", day: "2-digit" });
  r.timestamp.forEach((t, i) => { if (close[i] === null || close[i] === undefined) return; const d = local.format(new Date(t * 1000)); if (!goods.has(d)) goods.set(d, {}); goods.get(d)[name] = close[i]; });
}
const goodDates = [...goods.keys()].sort();
writeFileSync(`${ROOT}/commodities.csv`, ["date,WTI,BRENT,COPPER", ...goodDates.map((d) => `${d},${["WTI", "BRENT", "COPPER"].map((n) => goods.get(d)[n] ?? "").join(",")}`)].join("\n") + "\n");
console.log(`commodities.csv: ${goodDates.length} days, ${goodDates[0]} .. ${goodDates.at(-1)}`);
