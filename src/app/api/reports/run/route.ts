import { ConfigError, loadConfig } from "../../../../config";
import { isRunId, readRun } from "../../../_lib/reports-store";

export const dynamic = "force-dynamic";

/** The trades of one run: `?id=dev/2026-11-17_12-30-00_TrendD1`. */
export function GET(request: Request): Response {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!isRunId(id)) {
    return Response.json({ error: "Неизвестный прогон." }, { status: 400 });
  }
  try {
    const run = readRun(loadConfig(), id);
    return run === null
      ? Response.json({ error: `Прогон ${id} не найден.` }, { status: 404 })
      : Response.json(run);
  } catch (error) {
    if (error instanceof ConfigError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }
}
