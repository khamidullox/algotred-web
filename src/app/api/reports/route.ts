import { ConfigError, loadConfig } from "../../../config";
import { listRuns } from "../../_lib/reports-store";

export const dynamic = "force-dynamic";

/** Saved backtest runs, newest first. */
export function GET(): Response {
  try {
    return Response.json(listRuns(loadConfig()));
  } catch (error) {
    if (error instanceof ConfigError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }
}
