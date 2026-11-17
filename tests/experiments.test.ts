import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  formatExperiment,
  JOURNAL_HEADER,
  recordExperiment,
  type ExperimentRun,
} from "../src/report/experiments";

const ZONE = "Europe/Athens";
const day = (iso: string): number => DateTime.fromISO(iso, { zone: ZONE }).toMillis();

const run = (overrides: Partial<ExperimentRun> = {}): ExperimentRun => ({
  finishedAt: Date.UTC(2026, 10, 17, 10, 32, 5),
  strategy: "BreakoutRetestV1-A",
  dataset: "test",
  span: { start: day("2021-12-09"), end: day("2024-11-16") },
  brokerTimeZone: ZONE,
  parameters: { riskPerTradePct: 0.5, usdExposureLimit: false },
  metrics: { "Число сделок": 231, "Profit Factor": 1.08, Вердикт: "INCONCLUSIVE" },
  ...overrides,
});

let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "experiments-"));
  file = path.join(directory, "EXPERIMENTS.md");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("formatExperiment", () => {
  it("writes the date, strategy, dataset, parameters and metrics", () => {
    expect(formatExperiment(run())).toBe(
      [
        "### 2026-11-17 10:32:05 UTC · BreakoutRetestV1-A · test",
        "",
        "- Набор данных: `test`, с 2021-12-09 по 2024-11-15 включительно (1073 дн., дни сервера `Europe/Athens`)",
        "- Параметры:",
        "  - riskPerTradePct: 0.5",
        "  - usdExposureLimit: false",
        "- Главные метрики:",
        "  - Число сделок: 231",
        "  - Profit Factor: 1.08",
        "  - Вердикт: INCONCLUSIVE",
        "",
      ].join("\n"),
    );
  });

  it("keeps a value with a line break on one line", () => {
    const text = formatExperiment(run({ metrics: { note: "first\r\n  second" } }));
    expect(text).toContain("  - note: first second\n");
  });

  it("says so when there is nothing to list", () => {
    expect(formatExperiment(run({ parameters: {} }))).toContain(
      "- Параметры:\n  - нет\n",
    );
  });
});

describe("recordExperiment", () => {
  it("does not journal a dev run", () => {
    expect(recordExperiment(run({ dataset: "dev" }), file)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("journals test and holdout runs", () => {
    expect(recordExperiment(run({ dataset: "test" }), file)).toBe(true);
    expect(recordExperiment(run({ dataset: "holdout" }), file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("· BreakoutRetestV1-A · test\n");
    expect(text).toContain("· BreakoutRetestV1-A · holdout\n");
  });

  it("creates a missing journal with the header", () => {
    recordExperiment(run(), file);
    expect(readFileSync(file, "utf8")).toBe(
      `${JOURNAL_HEADER}\n${formatExperiment(run())}`,
    );
  });

  it("appends without changing what is already there", () => {
    recordExperiment(run(), file);
    const before = readFileSync(file, "utf8");
    const second = run({
      strategy: "BreakoutRetestV1-B",
      finishedAt: Date.UTC(2026, 10, 17, 10, 40, 0),
    });
    recordExperiment(second, file);
    expect(readFileSync(file, "utf8")).toBe(
      `${before}\n${formatExperiment(second)}`,
    );
  });

  it("starts the entry on its own line whatever the file ends with", () => {
    for (const ending of ["", "\n", "\n\n", "\r\n", "\r\n\r\n"]) {
      writeFileSync(file, `${JOURNAL_HEADER.trimEnd()}${ending}`);
      recordExperiment(run(), file);
      const text = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
      expect(text).toBe(`${JOURNAL_HEADER}\n${formatExperiment(run())}`);
    }
  });
});
