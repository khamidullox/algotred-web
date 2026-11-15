import { describe, expect, it } from "vitest";
import { CliUsageError, parseCliArgs } from "../src/cli-args";

describe("parseCliArgs", () => {
  it("shows help when no command is given", () => {
    expect(parseCliArgs([])).toEqual({ command: "help" });
  });

  it("parses validate", () => {
    expect(parseCliArgs(["validate"])).toEqual({ command: "validate" });
  });

  it("defaults the dataset to dev", () => {
    expect(parseCliArgs(["backtest", "--strategy", "TrendD1"])).toEqual({
      command: "backtest",
      strategy: "TrendD1",
      dataset: "dev",
      holdoutAcknowledged: false,
    });
  });

  it("parses dataset and the holdout acknowledgement flag", () => {
    expect(
      parseCliArgs([
        "backtest",
        "--strategy",
        "BreakoutRetestV1-B",
        "--dataset",
        "holdout",
        "--i-understand-holdout",
      ]),
    ).toEqual({
      command: "backtest",
      strategy: "BreakoutRetestV1-B",
      dataset: "holdout",
      holdoutAcknowledged: true,
    });
  });

  it.each([
    [["backtest"]],
    [["backtest", "--strategy", "Martingale"]],
    [["backtest", "--strategy", "TrendD1", "--dataset", "all"]],
    [["backtest", "--strategy", "TrendD1", "--optimize"]],
    [["validate", "extra"]],
    [["trade"]],
  ])("rejects %j", (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(CliUsageError);
  });
});
