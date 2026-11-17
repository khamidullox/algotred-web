"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { SymbolName, Timeframe } from "../../config";
import type { SeriesFile } from "../_lib/data-store";
import { ChartSection } from "./chart-section";
import { FilesSection } from "./files-section";
import { ValidationSection } from "./validation-section";

export function DataWorkspace({
  files,
  symbols,
  timeframes,
  brokerTimeZone,
  initialRunId,
}: {
  files: SeriesFile[];
  symbols: readonly SymbolName[];
  timeframes: readonly Timeframe[];
  brokerTimeZone: string;
  initialRunId: string;
}) {
  const router = useRouter();
  // Bumped after an upload so that the report and the chart start from the new files.
  const [version, setVersion] = useState(0);

  return (
    <>
      <FilesSection
        files={files}
        symbols={symbols}
        timeframes={timeframes}
        onUploaded={() => {
          setVersion((current) => current + 1);
          router.refresh();
        }}
      />
      <ValidationSection key={`validation-${version}`} />
      <ChartSection
        key={`chart-${version}`}
        files={files}
        brokerTimeZone={brokerTimeZone}
        initialRunId={initialRunId}
      />
    </>
  );
}
