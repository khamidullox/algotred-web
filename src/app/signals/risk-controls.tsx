"use client";

// The parts of the "Signals" page that live in the browser: the deposit and
// the risk the visitor types in (kept in this browser only), the lot counted
// from them, and the timer that asks the server for fresh data.
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { lotHint, type LotRules } from "../../signals/lot-hint";

export interface RiskDefaults {
  readonly deposit: number;
  readonly riskPct: number;
  readonly currency: string;
}

interface Stored {
  deposit?: number;
  riskPct?: number;
}

const KEY = "algotred.signals.risk";
const listeners = new Set<() => void>();
/** Used when the browser gives no storage: the values then live until the page is closed. */
let memory = "";

function snapshot(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "";
  } catch {
    return memory;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function save(value: Stored | null): void {
  memory = value === null ? "" : JSON.stringify(value);
  try {
    if (value === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, memory);
  } catch {
    // No storage: `memory` holds the value.
  }
  for (const listener of listeners) listener();
}

function parse(text: string): Stored {
  if (text === "") return {};
  try {
    const raw = JSON.parse(text) as Stored;
    const positive = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
    const deposit = positive(raw.deposit);
    const riskPct = positive(raw.riskPct);
    return { ...(deposit === undefined ? {} : { deposit }), ...(riskPct === undefined ? {} : { riskPct: Math.min(riskPct, 100) }) };
  } catch {
    return {};
  }
}

/** The deposit and the risk in use: what was typed in this browser, else the page's defaults. */
function useRisk(defaults: RiskDefaults): { deposit: number; riskPct: number; own: Stored } {
  // The server and the first paint show the defaults; the stored values come right after.
  const own = parse(useSyncExternalStore(subscribe, snapshot, () => ""));
  return { deposit: own.deposit ?? defaults.deposit, riskPct: own.riskPct ?? defaults.riskPct, own };
}

const money = (value: number): string => value.toLocaleString("ru-RU", { maximumFractionDigits: value < 100 ? 2 : 0 });

export function RiskForm({ defaults }: { defaults: RiskDefaults }) {
  const risk = useRisk(defaults);
  // What is in a field while it is being edited; null shows the value in use.
  const [depositText, setDepositText] = useState<string | null>(null);
  const [riskText, setRiskText] = useState<string | null>(null);
  const typed = (text: string): number | null => {
    const value = Number(text.replace(",", "."));
    return text.trim() !== "" && Number.isFinite(value) && value > 0 ? value : null;
  };
  const changed = risk.own.deposit !== undefined || risk.own.riskPct !== undefined;

  return (
    <div className="card signal-risk">
      <div className="toolbar">
        <label>
          Депозит, {defaults.currency}
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={depositText ?? String(risk.deposit)}
            onChange={(event) => {
              setDepositText(event.target.value);
              const value = typed(event.target.value);
              if (value !== null) save({ ...risk.own, deposit: value });
            }}
            onBlur={() => setDepositText(null)}
          />
        </label>
        <label>
          Риск на сделку, %
          <input
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="0.1"
            value={riskText ?? String(risk.riskPct)}
            onChange={(event) => {
              setRiskText(event.target.value);
              const value = typed(event.target.value);
              if (value !== null && value <= 100) save({ ...risk.own, riskPct: value });
            }}
            onBlur={() => setRiskText(null)}
          />
        </label>
        {changed && (
          <button
            className="button small secondary"
            type="button"
            onClick={() => {
              setDepositText(null);
              setRiskText(null);
              save(null);
            }}
          >
            Вернуть как было
          </button>
        )}
      </div>
      <p className="note">
        На одну сделку: {money((risk.deposit * risk.riskPct) / 100)} {defaults.currency}. По этим двум числам ниже считается лот. Они
        хранятся только в этом браузере.
      </p>
    </div>
  );
}

/** The lot for the typed deposit and risk when the stop is `stopDistance` away. */
export function LotAdvice(props: { rules: LotRules; stopDistance: number; defaults: RiskDefaults }) {
  const { rules, stopDistance, defaults } = props;
  const risk = useRisk(defaults);
  const allowed = (risk.deposit * risk.riskPct) / 100;
  const hint = lotHint(rules, allowed, stopDistance);
  const account = `${money(risk.deposit)} ${defaults.currency}`;
  if (hint === null) return <>Лот посчитать нельзя: нет цены пункта или шага лота от брокера.</>;
  if (hint.lots > 0) {
    return (
      <>
        <strong>{hint.lots.toFixed(hint.lotDigits)}</strong> — на стопе это {money(hint.riskMoney)} {defaults.currency} (
        {((hint.riskMoney / risk.deposit) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}% от {account}).
      </>
    );
  }
  return (
    <>
      <strong>сделка не проходит</strong>: минимальный лот {rules.lotMin.toFixed(hint.lotDigits)} рискует {money(hint.minLotRiskMoney)}{" "}
      {defaults.currency}, а допустимо {money(allowed)} ({risk.riskPct.toLocaleString("ru-RU")}% от {account}). По правилу такой сигнал
      пропускают.
    </>
  );
}

/** Asks the server for the page again every `seconds`: the daily files change outside the app. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    // A tab nobody looks at does not ask; it catches up the moment it is looked at again.
    const refresh = (): void => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refresh, seconds * 1000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, seconds]);
  return null;
}
