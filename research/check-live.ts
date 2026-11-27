// Do the candles the MT5 indicator passes to the charts (TZ 17.52) agree with
// the project's own export files where both have the same bars? Every series
// of the config is compared bar by bar on the days both files hold, and the
// newest bar of each is printed. Only files are read.
// Usage: npx tsx research/check-live.ts
import { loadConfig, symbolNames, TIMEFRAMES } from "../src/config";
import { readSeriesInput } from "../src/data/load";
import { formatInZone } from "../src/data/time";
import type { Bar } from "../src/data/types";
import { defaultLiveDir, getLiveSeries } from "../src/app/_lib/live-series";

const config = loadConfig();
const zone = config.brokerTimeZone;
const dir = defaultLiveDir();
const stamp = (ms: number): string => formatInZone(ms, zone, "yyyy-LL-dd HH:mm");
const same = (a: Bar, b: Bar): boolean =>
  a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

console.log(`folder: ${dir ?? "none"}`);
let found = 0, compared = 0, equal = 0;
for (const symbol of symbolNames(config)) {
  for (const timeframe of TIMEFRAMES) {
    const live = getLiveSeries(dir, symbol, timeframe, zone);
    if (live === null) {
      console.log(`${symbol} ${timeframe}: no file`);
      continue;
    }
    found++;
    const files = readSeriesInput(config, { symbol, timeframe }).parsed?.bars ?? [];
    const byTime = new Map(files.map((bar) => [bar.time, bar]));
    // The files' last row may be a bar that was still trading when they were exported.
    const lastFileTime = files.at(-1)?.time ?? Number.NEGATIVE_INFINITY;
    const both = live.bars.filter((bar) => byTime.has(bar.time) && bar.time < lastFileTime);
    const differ = both.filter((bar) => !same(bar, byTime.get(bar.time) as Bar));
    const missing = files.filter((bar) => bar.time >= (live.bars[0]?.time ?? Infinity) && bar.time < lastFileTime && !live.bars.some((own) => own.time === bar.time));
    compared += both.length;
    equal += both.length - differ.length;
    const first = live.bars[0];
    const last = live.bars.at(-1);
    console.log(
      `${symbol} ${timeframe}: ${live.bars.length} bars ${first === undefined ? "" : `${stamp(first.time)} .. ${stamp((last as Bar).time)}`}; ` +
        `on common bars ${both.length - differ.length} of ${both.length} identical; bars of the files missing from the terminal's file ${missing.length}` +
        (differ.length > 0 ? `; first difference ${stamp((differ[0] as Bar).time)}` : ""),
    );
  }
}
console.log(`series found ${found}; common bars identical ${equal} of ${compared}`);
