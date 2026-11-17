import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConfigError, loadConfig, symbolNames } from "../../../../config";
import {
  detectSeriesFromFileName,
  seriesFileName,
  seriesFilePath,
} from "../../../../data/files";
import {
  decodeMt5File,
  Mt5CsvFormatError,
  parseMt5Csv,
} from "../../../../data/mt5-csv";
import { createServerTimeConverter } from "../../../../data/time";

export const dynamic = "force-dynamic";

// The largest file the project uses (M15, 12 years) is about 19 MB.
const MAX_BYTES = 100 * 1024 * 1024;

function fail(status: number, error: string, extra: object = {}): Response {
  return Response.json({ error, ...extra }, { status });
}

/**
 * Stores one MT5 export in the data directory under the name from the TZ.
 * The body is the raw file; `name` is the original file name, used only to
 * tell the pair and timeframe. An existing file is replaced only with replace=1.
 */
export async function PUT(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) return fail(500, error.message);
    throw error;
  }
  const symbols = symbolNames(config);
  const id = detectSeriesFromFileName(params.get("name") ?? "", symbols);
  if (id === null) {
    return fail(
      400,
      `По имени файла не удалось понять инструмент и таймфрейм. Нужны ${symbols.join(", ")} на D1 (Daily), H1 или M15, например ${symbols[0]}_H1.csv. Новый инструмент сначала добавляется в config/default.json.`,
    );
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return fail(413, "Файл больше 100 МБ: это не тот таймфрейм.");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) {
    return fail(400, "Файл пустой.");
  }
  if (bytes.length > MAX_BYTES) {
    return fail(413, "Файл больше 100 МБ: это не тот таймфрейм.");
  }

  // Refuse anything that is not an MT5 export before it replaces good data.
  let parsed;
  try {
    parsed = parseMt5Csv(decodeMt5File(bytes), {
      timeframe: id.timeframe,
      toUtc: createServerTimeConverter(config.brokerTimeZone),
    });
  } catch (error) {
    if (error instanceof Mt5CsvFormatError) return fail(400, `${error.message}.`);
    throw error;
  }
  if (parsed.bars.length === 0) {
    return fail(400, "В файле не нашлось ни одной свечи.");
  }

  const file = seriesFileName(id);
  const target = seriesFilePath(config, id);
  if (existsSync(target) && params.get("replace") !== "1") {
    return fail(409, `Файл ${file} уже есть.`, { exists: true, file });
  }

  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.uploading`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, target);

  return Response.json({
    file,
    symbol: id.symbol,
    timeframe: id.timeframe,
    rows: parsed.bars.length,
    rowErrors: parsed.rowErrorCount,
  });
}
