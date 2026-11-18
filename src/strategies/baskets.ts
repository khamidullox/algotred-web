/**
 * The eight instruments of TZ 17.2: the basket the stage-3 forex strategies
 * were approved and run on. They name it so that instruments added to the
 * config later (the index CFDs of TZ 17.6) do not change their runs.
 */
export const FX_AND_GOLD = [
  "EURUSD",
  "GBPUSD",
  "USDJPY",
  "AUDUSD",
  "NZDUSD",
  "USDCAD",
  "USDCHF",
  "XAUUSD",
] as const;

/** The US index CFDs of TZ 17.6. */
export const US_INDICES = ["US500", "US30", "US2000"] as const;

/** The eleven instruments of TZ 17.7 and 17.8. */
export const FX_GOLD_AND_INDICES = [...FX_AND_GOLD, ...US_INDICES] as const;
