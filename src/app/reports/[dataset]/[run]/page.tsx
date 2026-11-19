import Link from "next/link";
import { notFound } from "next/navigation";
import { ConfigError, loadConfig, type Config } from "../../../../config";
import { newsForRun, readReport, readRun } from "../../../_lib/reports-store";
import { ReportView } from "./report-view";

export const dynamic = "force-dynamic";

export default async function ReportPage(props: {
  params: Promise<{ dataset: string; run: string }>;
}) {
  const { dataset, run } = await props.params;
  const id = `${dataset}/${run}`;

  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return (
      <>
        <h1>Отчёт</h1>
        <div className="card error">{error.message}</div>
      </>
    );
  }

  const report = readReport(config, id);
  if (report === null) {
    if (readRun(config, id) === null) notFound();
    return (
      <>
        <h1>Отчёт</h1>
        <p className="lead">
          У прогона <code>{id}</code> нет отчёта: он сделан до шага 6. Сделки можно посмотреть на{" "}
          <Link href={`/data?run=${encodeURIComponent(id)}`}>графике</Link>.
        </p>
      </>
    );
  }

  // Reports made before the news section existed get it worked out here.
  const news = report.news ?? newsForRun(config, id);
  return <ReportView id={id} report={report} news={news} newsComputedLater={report.news === undefined || report.news === null} />;
}
