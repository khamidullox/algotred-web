import { ConfigError, loadConfig, type Config } from "../../config";
import { DateTime } from "luxon";
import Link from "next/link";
import { formatInZone } from "../../data/time";
import type { DailyPosition, DailyTrade } from "../../signals/daily-state";
import { RSI2_REVERSION } from "../../strategies/rsi2-reversion-d1";
import { loadSignals, STALE_AFTER_DAYS, type SignalCard } from "../_lib/signals-store";
import "./signals.css";

// The daily files change outside the app: read them on every request.
export const dynamic = "force-dynamic";

const DIRECTION = { BUY: "покупка", SELL: "продажа" } as const;

function stateLabel(card: SignalCard): string {
  const { state } = card;
  if (state.kind === "enter") return `Сигнал: ${DIRECTION[state.direction]} на следующем открытии`;
  if (state.kind === "open") return `В сделке: ${DIRECTION[state.position.direction]}`;
  if (state.kind === "exit") return "Сигнал: закрыть на следующем открытии";
  return "Сигнала нет";
}

export default async function SignalsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // `/signals?asOf=2026-03-12` shows what the strategy said after that day closed.
  const { asOf } = await props.searchParams;
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return (
      <>
        <h1>Сигналы</h1>
        <div className="card error">{error.message}</div>
      </>
    );
  }

  const zone = config.brokerTimeZone;
  const wanted = typeof asOf === "string" ? DateTime.fromISO(asOf, { zone }) : null;
  const past = wanted !== null && wanted.isValid ? wanted.startOf("day") : null;
  // The end of the chosen server day stands in for "now": later bars are not looked at.
  const view = past === null ? loadSignals(config) : loadSignals(config, past.plus({ days: 1 }).toMillis());
  const day = (ms: number): string => formatInZone(ms, zone, "dd.LL.yyyy");
  const usd = (value: number): string => value.toLocaleString("ru-RU", { maximumFractionDigits: 0 });
  const count = (kind: string): number => view.cards.filter((card) => card.problem === null && card.state.kind === kind).length;
  const stale = view.cards.filter((card) => card.problem === null && card.ageDays > STALE_AFTER_DAYS);

  return (
    <>
      <h1>Сигналы</h1>
      <p className="lead">
        Что говорит подтверждённая стратегия «Откат по RSI(2) на индексах США» (<code>{view.strategy}</code>) по
        последним дневным свечам из папки <code>{config.dataDir}</code>. Это состояние правила, проверенного на
        истории, а не торговая рекомендация; сайт сделок не совершает.
      </p>

      <form className="toolbar" method="get">
        <label>
          Состояние на дату
          <input type="date" name="asOf" defaultValue={past === null ? "" : past.toFormat("yyyy-LL-dd")} />
        </label>
        <button className="button small" type="submit">
          Показать
        </button>
        {past !== null && (
          <Link className="button small secondary" href="/signals">
            К последним данным
          </Link>
        )}
      </form>
      {past !== null && (
        <p className="note">Показано, что стратегия говорила после закрытия дня {past.toFormat("dd.LL.yyyy")}. Более поздние свечи не учитываются.</p>
      )}

      <div className="banner">
        Сигналов на вход: {count("enter")}. Открытых позиций: {count("open")}. Сигналов на выход: {count("exit")}.
      </div>
      {past === null && stale.length > 0 && (
        <div className="banner bad">
          Данные устарели: последняя дневная свеча — {day(Math.max(...stale.map((card) => card.asOf ?? 0)))}. Чтобы
          увидеть сегодняшнее состояние, выгрузите из MT5 свежие дневные свечи (D1) по этим инструментам в папку
          данных.
        </div>
      )}

      {view.cards.map((card) => (
        <SignalSection key={card.symbol} card={card} day={day} usd={usd} config={config} riskUsd={view.riskUsd} live={past === null} />
      ))}

      <h2>Как читать</h2>
      <div className="card">
        <ul className="issues">
          <li>
            Покупка: день закрылся выше SMA({RSI2_REVERSION.trendSmaPeriod}), а RSI({RSI2_REVERSION.rsiPeriod}) ниже{" "}
            {RSI2_REVERSION.buyBelowRsi}. Продажа: ниже SMA({RSI2_REVERSION.trendSmaPeriod}) и RSI выше{" "}
            {RSI2_REVERSION.sellAboveRsi}. Вход — на открытии следующего дня.
          </li>
          <li>
            Стоп — {RSI2_REVERSION.atrMultiple} × ATR({RSI2_REVERSION.atrPeriod}) от цены входа. Выход — на открытии
            после дня, закрывшегося за SMA({RSI2_REVERSION.exitSmaPeriod}): выше неё для покупки, ниже для продажи.
          </li>
          <li>
            Лот считается от стопа: риск {config.riskPerTradePct}% от {usd(config.initialCapitalUsd)} USD, то есть{" "}
            {usd(view.riskUsd)} USD на сделку. Если минимальный лот 0,01 рискует больше, сделка не проходит.
          </li>
          <li>
            Страница считает по дневным свечам: вход по открытию следующего дня без спреда, стоп по дневному
            диапазону. Движок проверяет стоп по часовым свечам, поэтому отдельные сделки могут отличаться: на
            истории совпали 150 из 157 (ТЗ 17.20).
          </li>
        </ul>
      </div>
    </>
  );
}

function SignalSection(props: {
  card: SignalCard;
  day: (ms: number) => string;
  usd: (value: number) => string;
  config: Config;
  riskUsd: number;
  /** False when a past date is shown: later bars were left out on purpose. */
  live: boolean;
}) {
  const { card, day, usd, config, riskUsd, live } = props;
  const price = (value: number): string => value.toFixed(card.digits);
  const heading = (
    <h2>
      {card.title} <span className="muted">{card.symbol}</span>
      {card.problem === null && <span className={`signal-state signal-${card.state.kind}`}>{stateLabel(card)}</span>}
    </h2>
  );
  if (card.problem !== null || card.indicators === null || card.asOf === null) {
    return (
      <section className="card signal-card">
        {heading}
        <p className="bad">{card.problem ?? "Нет данных."}</p>
      </section>
    );
  }

  const { indicators: ind, state, sizing } = card;
  const up = ind.close > ind.trendSma;
  const lots = (): string => {
    if (sizing === null) return "";
    const account = `при счёте ${usd(config.initialCapitalUsd)} USD и риске ${config.riskPerTradePct}%`;
    return sizing.lots > 0
      ? `Лот ${account}: ${sizing.lots.toFixed(2)}.`
      : `Сделка ${account} не проходит: минимальный лот 0,01 рискует ${usd(sizing.minLotRiskUsd)} USD при допустимых ${usd(riskUsd)}.`;
  };
  const held = (position: DailyPosition): string =>
    `Вход ${day(position.entryTime)} по ${price(position.entryPrice)} (открытие дня), стоп ${price(position.stopLoss)}. Закрытий в сделке: ${position.days}.`;

  return (
    <section className="card signal-card">
      {heading}
      <p className="muted">
        По дневной свече за {day(card.asOf)}
        {live && card.unfinishedDayDropped ? "; сегодняшняя свеча ещё не закрыта и не учитывается" : ""}
        {live && card.ageDays > STALE_AFTER_DAYS ? `, данным ${card.ageDays} дн` : ""}.{card.note === null ? "" : ` ${card.note}`}
      </p>

      {state.kind === "enter" && sizing !== null && (
        <p>
          Стоп — {RSI2_REVERSION.atrMultiple} × ATR({RSI2_REVERSION.atrPeriod}) = {price(sizing.stopDistance)} от цены
          входа; при входе около {price(ind.close)} это{" "}
          {price(state.direction === "BUY" ? ind.close - sizing.stopDistance : ind.close + sizing.stopDistance)}.{" "}
          {lots()}
        </p>
      )}
      {state.kind === "open" && (
        <p>
          {held(state.position)} Выход — на открытии после дня, который закроется{" "}
          {state.position.direction === "BUY" ? "выше" : "ниже"} SMA({RSI2_REVERSION.exitSmaPeriod}); сейчас она{" "}
          {price(ind.exitSma)}, закрытие {price(ind.close)}. {lots()}
        </p>
      )}
      {state.kind === "exit" && (
        <p>
          {held(state.position)} Последний день закрылся {state.position.direction === "BUY" ? "выше" : "ниже"} SMA(
          {RSI2_REVERSION.exitSmaPeriod}): по правилу выход на следующем открытии.
        </p>
      )}
      {state.kind === "flat" && (
        <p>
          {up
            ? `Индекс выше SMA(${RSI2_REVERSION.trendSmaPeriod}): покупка будет, когда RSI(${RSI2_REVERSION.rsiPeriod}) опустится ниже ${RSI2_REVERSION.buyBelowRsi}. Сейчас ${ind.rsi.toFixed(1)}.`
            : `Индекс ниже SMA(${RSI2_REVERSION.trendSmaPeriod}): продажа будет, когда RSI(${RSI2_REVERSION.rsiPeriod}) поднимется выше ${RSI2_REVERSION.sellAboveRsi}. Сейчас ${ind.rsi.toFixed(1)}.`}
        </p>
      )}

      <dl className="facts">
        <div>
          <dt>Закрытие</dt>
          <dd>{price(ind.close)}</dd>
        </div>
        <div>
          <dt>SMA({RSI2_REVERSION.trendSmaPeriod}) — тренд</dt>
          <dd>
            {price(ind.trendSma)} <span className="muted">({up ? "цена выше" : "цена ниже"})</span>
          </dd>
        </div>
        <div>
          <dt>RSI({RSI2_REVERSION.rsiPeriod})</dt>
          <dd>{ind.rsi.toFixed(1)}</dd>
        </div>
        <div>
          <dt>SMA({RSI2_REVERSION.exitSmaPeriod}) — выход</dt>
          <dd>{price(ind.exitSma)}</dd>
        </div>
        <div>
          <dt>
            ATR({RSI2_REVERSION.atrPeriod}) / стоп {RSI2_REVERSION.atrMultiple} × ATR
          </dt>
          <dd>
            {price(ind.atr)} / {price(RSI2_REVERSION.atrMultiple * ind.atr)}
          </dd>
        </div>
      </dl>

      {card.recent.length > 0 && (
        <details>
          <summary>Последние сделки по правилу</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Направление</th>
                  <th>Вход</th>
                  <th>Цена</th>
                  <th>Выход</th>
                  <th>Цена</th>
                  <th>Как</th>
                  <th>R до издержек</th>
                </tr>
              </thead>
              <tbody>
                {card.recent.map((trade: DailyTrade) => (
                  <tr key={trade.entryTime}>
                    <td>{DIRECTION[trade.direction]}</td>
                    <td>{day(trade.entryTime)}</td>
                    <td>{price(trade.entryPrice)}</td>
                    <td>{day(trade.exitTime)}</td>
                    <td>{price(trade.exitPrice)}</td>
                    <td>{trade.exitReason === "stop" ? "стоп" : "правило"}</td>
                    <td className={trade.r >= 0 ? "ok" : "bad"}>
                      {trade.r >= 0 ? "+" : ""}
                      {trade.r.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
