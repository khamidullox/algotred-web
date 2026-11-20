// The search over "buy the dip" rules on daily bars (TZ 17.17), dev only.
// Usage: npx tsx research/sweep-dip.ts <stage> [symbols, comma separated]
import { describe, dipStrategy, type DipExit, type DipParams } from "./dip";
import { ibsDipIndexD1, ibsIndexControl } from "../src/strategies/ibs-dip-index-d1";
import { evaluate, header, line, loadStand } from "./lib";

const [stage = "base", symbolArg = "US500,US30,US2000"] = process.argv.slice(2);
const symbols = symbolArg.split(",");
const stand = loadStand();

const base: DipParams = {
  symbols,
  rsiPeriod: 2,
  rsiBelow: 5,
  ibsBelow: null,
  downDays: null,
  trendSma: 200,
  shorts: true,
  exit: { kind: "sma", period: 5 },
  maxDays: null,
  atrPeriod: 20,
  atrMultiple: 2,
};

function show(params: DipParams, costMultiplier = 1): void {
  console.log(line(`${describe(params)}${costMultiplier === 1 ? "" : ` | costs x${costMultiplier}`}`, evaluate(stand, dipStrategy(params), costMultiplier)));
}

type Entry = Pick<DipParams, "rsiBelow" | "ibsBelow" | "downDays">;
const none: Entry = { rsiBelow: null, ibsBelow: null, downDays: null };
const ENTRIES: readonly Entry[] = [
  { ...none, rsiBelow: 5 },
  { ...none, rsiBelow: 10 },
  { ...none, rsiBelow: 15 },
  { ...none, rsiBelow: 20 },
  { ...none, rsiBelow: 30 },
  { ...none, ibsBelow: 0.1 },
  { ...none, ibsBelow: 0.2 },
  { ...none, ibsBelow: 0.3 },
  { ...none, downDays: 2 },
  { ...none, downDays: 3 },
  { ...none, downDays: 4 },
  { ...none, rsiBelow: 10, ibsBelow: 0.3 },
  { ...none, rsiBelow: 20, ibsBelow: 0.2 },
  { ...none, rsiBelow: 30, ibsBelow: 0.2 },
  { ...none, downDays: 2, ibsBelow: 0.3 },
];
const EXITS: readonly DipExit[] = [
  { kind: "sma", period: 5 },
  { kind: "prevHigh" },
  { kind: "rsiAbove", value: 50 },
  { kind: "rsiAbove", value: 70 },
  { kind: "ibsAbove", value: 0.7 },
  { kind: "days", n: 1 },
  { kind: "days", n: 2 },
  { kind: "days", n: 3 },
];

console.log(header());
if (stage === "base") {
  // The frozen rules of Rsi2ReversionIndexD1: the stand must repeat its dev run.
  show(base);
} else if (stage === "grid1") {
  // Long only: entry x trend filter x exit x stop.
  for (const entry of ENTRIES) {
    for (const trendSma of [200, null]) {
      for (const exit of EXITS) {
        for (const atrMultiple of [2, 3]) {
          show({ ...base, ...entry, trendSma, shorts: false, exit, atrMultiple, maxDays: 10 });
        }
      }
    }
  }
} else if (stage === "grid2") {
  // Around the close near the low of the day: threshold x trend x exit x time stop x stop.
  const exits: readonly DipExit[] = [
    { kind: "rsiAbove", value: 60 },
    { kind: "rsiAbove", value: 70 },
    { kind: "rsiAbove", value: 80 },
    { kind: "prevHigh" },
    { kind: "sma", period: 5 },
  ];
  for (const ibsBelow of [0.05, 0.1, 0.15, 0.2]) {
    for (const trendSma of [null, 200]) {
      for (const exit of exits) {
        for (const maxDays of [5, 10]) {
          for (const atrMultiple of [1.5, 2, 2.5]) {
            show({ ...base, ...none, ibsBelow, trendSma, shorts: false, exit, maxDays, atrMultiple });
          }
        }
      }
    }
  }
} else if (stage === "probe") {
  // A handful of rules on other instruments: does the effect exist there at all?
  for (const entry of [{ ...none, ibsBelow: 0.1 }, { ...none, ibsBelow: 0.2 }, { ...none, rsiBelow: 10 }, { ...none, rsiBelow: 20, ibsBelow: 0.2 }]) {
    for (const trendSma of [null, 200]) {
      for (const shorts of trendSma === null ? [false] : [false, true]) {
        show({ ...base, ...entry, trendSma, shorts, exit: { kind: "rsiAbove", value: 70 }, maxDays: 10, atrMultiple: 2 });
      }
    }
  }
} else if (stage === "checks") {
  // The centre of the plateau and what it is compared with.
  const pick: DipParams = { ...base, ...none, ibsBelow: 0.1, trendSma: null, shorts: false, exit: { kind: "rsiAbove", value: 70 }, maxDays: 10, atrMultiple: 2 };
  show(pick);
  show(pick, 2);
  // No time stop at all, and other ATR periods for the stop.
  show({ ...pick, maxDays: null });
  show({ ...pick, atrPeriod: 10 });
  show({ ...pick, atrPeriod: 40 });
  // Control: the same trade from a neutral close, in the middle of the day range.
  show({ ...pick, ibsFrom: 0.45, ibsBelow: 0.55 });
  show({ ...pick, ibsFrom: 0.3, ibsBelow: 0.7 });
  // Any day at all: plain long exposure with the same exit and stop.
  show({ ...pick, ibsBelow: null });
  // The mirror: sell a close near the high of the day.
  show({ ...pick, shorts: true, longs: false });
  // With an extra RSI condition, and with the trend filter.
  show({ ...pick, rsiBelow: 30 });
  show({ ...pick, trendSma: 200 });
  show({ ...pick, trendSma: 200, shorts: true });
} else if (stage === "frozen") {
  // The frozen modules must repeat the rows of the search they were taken from.
  console.log(line(ibsDipIndexD1.name, evaluate(stand, ibsDipIndexD1)));
  console.log(line(ibsIndexControl.name, evaluate(stand, ibsIndexControl)));
} else {
  throw new Error(`unknown stage ${stage}`);
}
