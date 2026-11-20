// Reads the level and the key moments of a trade out of the text the strategy
// wrote into its `reason`, so the chart can draw them. The text is the only
// record of them: strategies do not save levels separately. Server-side (luxon).
import { DateTime } from "luxon";
import type { ReasonMarks, TradeMoment, TrendPoint } from "./api-types";

const DATE = String.raw`(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?`;
const NUMBER = String.raw`(\d+(?:\.\d+)?)`;

function serverToUtc(date: string, time: string | undefined, zone: string): number | null {
  const parsed = DateTime.fromISO(`${date}T${time ?? "00:00"}`, { zone });
  return parsed.isValid ? parsed.toMillis() / 1000 : null;
}

export function parseReason(reason: string, zone: string): ReasonMarks {
  const level = new RegExp(String.raw`(?:^|; )L ${NUMBER}`).exec(reason);
  // «L 1.55516 от 2015-02-26» (StrongLevelD1), «L 1.50048 (low 2015-02-02 14:00)» (FailedBreakoutV1)
  // or «L 1.20000 (close 2024-05-10 23:45)» (MondayGapM15).
  const origin = new RegExp(String.raw`(?:^|; )L ${NUMBER} (?:от |\((?:high|low|close) )${DATE}`).exec(reason);

  const moments: TradeMoment[] = [];
  const pattern = new RegExp(
    // Whole words only: «дно» must not be found inside another word.
    String.raw`(?<![а-яё])(пробой(?: вверх| вниз)?|ретест|подтверждение|провал|касание|дно|вершина|ордер|открытие недели) ${DATE}`,
    "g",
  );
  for (const match of reason.matchAll(pattern)) {
    const time = serverToUtc(match[2] as string, match[3], zone);
    if (time !== null) moments.push({ label: match[1] as string, time });
  }

  let trendLine: TrendPoint[] | null = null;
  const line = new RegExp(
    String.raw`линия по (?:минимумам|максимумам) ${DATE} ${NUMBER} — ${DATE} ${NUMBER}; касание ${DATE} при линии ${NUMBER}`,
  ).exec(reason);
  if (line !== null) {
    const points = [
      [line[1], line[2], line[3]],
      [line[4], line[5], line[6]],
      [line[7], line[8], line[9]],
    ].map(([date, time, price]) => ({
      time: serverToUtc(date as string, time, zone),
      price: Number(price),
    }));
    if (points.every((point) => point.time !== null)) {
      trendLine = points.map((point) => ({ time: point.time as number, price: point.price }));
    }
  }

  return {
    level: level === null ? null : Number(level[1]),
    levelFrom: origin === null ? null : serverToUtc(origin[2] as string, origin[3], zone),
    moments,
    trendLine,
  };
}
