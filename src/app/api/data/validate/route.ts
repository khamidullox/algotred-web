import { ConfigError, loadConfig } from "../../../../config";
import { getValidationReport } from "../../../_lib/data-store";

export const dynamic = "force-dynamic";

export function GET(): Response {
  try {
    return Response.json(getValidationReport(loadConfig()));
  } catch (error) {
    if (error instanceof ConfigError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }
}
