import { ConfigError, loadConfig } from "../../../config";
import { eventsBetween, symbolCurrencies, type NewsImportance } from "../../../data/calendar";
import type { NewsResponse } from "../../_lib/api-types";
import { getCalendar } from "../../_lib/data-store";

export const dynamic = "force-dynamic";

const MAX_ITEMS = 3000;

/**
 * Calendar releases with an exact time that move an instrument:
 * `?symbol=EURUSD&from=<UTC s>&to=<UTC s>&importance=HIGH|MODERATE`.
 */
export function GET(request: Request): Response {
  const params = new URL(request.url).searchParams;
  const symbol = params.get("symbol") ?? "";
  const from = Number(params.get("from"));
  const to = Number(params.get("to"));
  const importance = (params.get("importance") ?? "HIGH") as NewsImportance;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !["HIGH", "MODERATE"].includes(importance)) {
    return Response.json({ error: "Нужны from, to (секунды UTC) и importance HIGH или MODERATE." }, { status: 400 });
  }
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) return Response.json({ error: error.message }, { status: 500 });
    throw error;
  }
  const calendar = getCalendar(config);
  const body: NewsResponse = {
    problem: calendar.file === null ? "календарь не задан в конфиге" : (calendar.problem ?? null),
    items: eventsBetween(calendar.events, from * 1000, to * 1000 + 1, {
      currencies: symbolCurrencies(symbol),
      minImportance: importance,
    })
      .slice(0, MAX_ITEMS)
      .map((event) => ({
        time: event.time / 1000,
        currency: event.currency,
        code: event.code,
        name: event.name,
        importance: event.importance,
        unit: event.unit,
        multiplier: event.multiplier,
        actual: event.actual,
        forecast: event.forecast,
        previous: event.previous,
      })),
  };
  return Response.json(body);
}
