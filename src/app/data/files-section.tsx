"use client";

import { useRef, useState } from "react";
import type { SymbolName, Timeframe } from "../../config";
import type { ApiError, UploadResponse } from "../_lib/api-types";
import type { SeriesFile } from "../_lib/data-store";

interface UploadLine {
  name: string;
  ok: boolean;
  text: string;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

async function uploadFile(file: File, replace: boolean): Promise<UploadLine> {
  const query = new URLSearchParams({ name: file.name });
  if (replace) query.set("replace", "1");
  const response = await fetch(`/api/data/upload?${query}`, {
    method: "PUT",
    body: file,
  });
  const body = (await response.json()) as UploadResponse | ApiError;

  if ("error" in body) {
    if (response.status === 409 && body.exists && !replace) {
      // Replacing data is never silent: the user confirms each file.
      if (window.confirm(`${body.file} уже есть в папке. Заменить его файлом ${file.name}?`)) {
        return uploadFile(file, true);
      }
      return { name: file.name, ok: false, text: "оставлен прежний файл" };
    }
    return { name: file.name, ok: false, text: body.error };
  }
  const skipped = body.rowErrors > 0 ? `, не прочитано строк: ${body.rowErrors}` : "";
  return {
    name: file.name,
    ok: true,
    text: `сохранён как ${body.file}, свечей: ${body.rows.toLocaleString("ru-RU")}${skipped}`,
  };
}

export function FilesSection({
  files,
  symbols,
  timeframes,
  onUploaded,
}: {
  files: SeriesFile[];
  symbols: readonly SymbolName[];
  timeframes: readonly Timeframe[];
  onUploaded: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<UploadLine[]>([]);
  const missing = files.filter((file) => !file.present);

  async function handleFiles(list: FileList | null): Promise<void> {
    if (list === null || list.length === 0) return;
    setBusy(true);
    setLines([]);
    const results: UploadLine[] = [];
    for (const file of Array.from(list)) {
      try {
        results.push(await uploadFile(file, false));
      } catch {
        results.push({ name: file.name, ok: false, text: "не удалось отправить файл" });
      }
      setLines([...results]);
    }
    setBusy(false);
    if (input.current) input.current.value = "";
    if (results.some((line) => line.ok)) onUploaded();
  }

  return (
    <section>
      <h2>Файлы</h2>
      <div className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Пара</th>
              {timeframes.map((timeframe) => (
                <th scope="col" key={timeframe}>
                  {timeframe}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {symbols.map((symbol) => (
              <tr key={symbol}>
                <th scope="row">{symbol}</th>
                {timeframes.map((timeframe) => {
                  const file = files.find(
                    (item) => item.symbol === symbol && item.timeframe === timeframe,
                  );
                  return (
                    <td key={timeframe}>
                      {file?.present ? (
                        <span className="status ok">есть · {megabytes(file.sizeBytes)}</span>
                      ) : (
                        <span className="status bad">нет файла</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {missing.length > 0 && (
        <p className="note bad">
          Не хватает: {missing.map((file) => file.file).join(", ")}.
        </p>
      )}

      <div className="toolbar">
        <label className="button">
          {busy ? "Загружаю…" : "Загрузить CSV из MT5"}
          <input
            ref={input}
            type="file"
            accept=".csv"
            multiple
            hidden
            disabled={busy}
            onChange={(event) => void handleFiles(event.target.files)}
          />
        </label>
        <span className="muted">
          Имена можно не менять: <code>EURUSD_M15_2015…csv</code> и{" "}
          <code>EURUSD_Daily_…csv</code> распознаются сами.
        </span>
      </div>

      {lines.length > 0 && (
        <ul className="upload-log">
          {lines.map((line) => (
            <li key={line.name} className={line.ok ? "ok" : "bad"}>
              <code>{line.name}</code> — {line.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
