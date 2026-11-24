import { ConfigError, loadConfig, type Config } from "../../config";
import { DateTime } from "luxon";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatInZone } from "../../data/time";
import type { DailyPosition, DailyTrade } from "../../signals/daily-state";
import { defaultFeedDir, FEED_FOLDER } from "../../signals/terminal-feed";
import { RSI2_REVERSION } from "../../strategies/rsi2-reversion-d1";
import { loadSignals, STALE_AFTER_DAYS, type SignalCard, type SignalsSource } from "../_lib/signals-store";
import { AutoRefresh, LotAdvice, RiskForm, type RiskDefaults } from "./risk-controls";
import "./signals.css";

// The daily files change outside the app: read them on every request.
export const dynamic = "force-dynamic";

/** How often the page asks for fresh data; the indicator rewrites its files every 30 seconds. */
const REFRESH_SECONDS = 30;

const DIRECTION = { BUY: "покупка", SELL: "продажа" } as const;
const ACTION = { BUY: "купить", SELL: "продать" } as const;
const TO_CLOSE = { BUY: "покупку", SELL: "продажу" } as const;

function stateLabel(card: SignalCard): string {
  const { state } = card;
  const opened = card.today !== null;
  if (state.kind === "enter") return opened ? `Вход сегодня: ${ACTION[state.direction]}` : `Сигнал: ${DIRECTION[state.direction]} на следующем открытии`;
  if (state.kind === "open") return `В сделке: ${DIRECTION[state.position.direction]}`;
  if (state.kind === "exit") return opened ? "Выход сегодня: закрыть" : "Сигнал: закрыть на следующем открытии";
  return "Сигнала нет";
}

function age(seconds: number): string {
  if (seconds < 90) return `${seconds} с назад`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} мин назад`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} ч назад`;
  return `${Math.round(seconds / 86_400)} дн назад`;
}

function SourceBanner({ source }: { source: SignalsSource }) {
  if (source.kind === "terminal") {
    return source.stale ? (
      <div className="banner bad">
        Терминал перестал присылать данные: последний раз {age(source.ageSeconds)}. Откройте MetaTrader 5 и проверьте, что индикатор{" "}
        <code>Rsi2IndexSignal</code> стоит на графике. Ниже — состояние на тот момент.
      </div>
    ) : (
      <div className="banner ok">
        Данные идут из MetaTrader 5{source.server === "" ? "" : `, сервер ${source.server}`}: обновлены {age(source.ageSeconds)}, время сервера{" "}
        {source.serverTime}. Страница обновляется сама каждые {REFRESH_SECONDS} секунд.
      </div>
    );
  }
  return (
    <p className="note">
      Данные берутся из файлов в папке данных. Чтобы сигналы приходили сюда сами, поставьте в MetaTrader 5 индикатор{" "}
      <code>Rsi2IndexSignal</code> и держите терминал открытым: страница начнёт читать его данные без выгрузок.
      {source.feedProblem === null ? "" : ` ${source.feedProblem}`}
    </p>
  );
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
  // A past date is answered from the files of the data folder: the end of the chosen
  // server day stands in for "now", later bars are not looked at.
  const view = past === null ? loadSignals(config, Date.now(), defaultFeedDir()) : loadSignals(config, past.plus({ days: 1 }).toMillis());
  const day = (ms: number): string => formatInZone(ms, zone, "dd.LL.yyyy");
  const count = (kind: string): number => view.cards.filter((card) => card.problem === null && card.state.kind === kind).length;
  const fromFiles = view.source.kind === "files";
  const stale = fromFiles ? view.cards.filter((card) => card.problem === null && card.ageDays > STALE_AFTER_DAYS) : [];
  const defaults: RiskDefaults = { deposit: view.accountSize, riskPct: view.riskPct, currency: view.currency };

  return (
    <>
      <h1>Сигналы</h1>
      <p className="lead">
        Что говорит подтверждённая стратегия «Откат по RSI(2) на индексах США» (<code>{view.strategy}</code>) по последним дневным
        свечам. Это состояние правила, проверенного на истории, а не торговая рекомендация; сайт сделок не совершает.
      </p>

      {past === null && <AutoRefresh seconds={REFRESH_SECONDS} />}
      {past === null && <SourceBanner source={view.source} />}

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
        <p className="note">
          Показано, что стратегия говорила после закрытия дня {past.toFormat("dd.LL.yyyy")}, по файлам из папки <code>{config.dataDir}</code>.
          Более поздние свечи не учитываются.
        </p>
      )}

      <RiskForm defaults={defaults} />

      <div className="banner">
        Сигналов на вход: {count("enter")}. Открытых позиций: {count("open")}. Сигналов на выход: {count("exit")}.
      </div>
      {past === null && stale.length > 0 && (
        <div className="banner bad">
          Данные устарели: последняя дневная свеча — {day(Math.max(...stale.map((card) => card.asOf ?? 0)))}. Чтобы увидеть
          сегодняшнее состояние, поставьте индикатор в MetaTrader 5 или выгрузите из него свежие дневные свечи (D1) в папку{" "}
          <code>{config.dataDir}</code>.
        </div>
      )}
      {!fromFiles && view.cards.length === 0 && (
        <div className="banner bad">
          Терминал пока не передал ни одного индекса. Проверьте на графике таблицу индикатора: там написано, каких инструментов у
          брокера не нашлось.
        </div>
      )}

      {view.cards.map((card) => (
        <SignalSection key={card.symbol} card={card} day={day} defaults={defaults} live={past === null} fromFiles={fromFiles} />
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
            Стоп — {RSI2_REVERSION.atrMultiple} × ATR({RSI2_REVERSION.atrPeriod}) от цены входа. Тейка у правила нет: выход — на
            открытии после дня, закрывшегося за SMA({RSI2_REVERSION.exitSmaPeriod}): выше неё для покупки, ниже для продажи.
          </li>
          <li>
            Лот считается от стопа: при срабатывании стопа сделка теряет заданный процент депозита. Лот округляется вниз до шага
            лота. Если даже минимальный лот рискует больше, сигнал пропускают.
          </li>
          <li>
            Цена пункта и шаг лота берутся у брокера, когда данные идут из терминала. Из файлов — по контракту из настроек
            проекта: 10 USD за пункт индекса на лот, шаг 0,01.
          </li>
          <li>
            Страница считает по дневным свечам: вход по открытию дня без спреда, стоп по дневному диапазону. Движок проверяет
            стоп по часовым свечам, поэтому отдельные сделки могут отличаться: на истории совпали 150 из 157 (ТЗ 17.20).
          </li>
          <li>
            Папка, куда индикатор пишет данные для страницы: <code>{FEED_FOLDER}</code> в общей папке файлов терминала.
          </li>
        </ul>
      </div>
    </>
  );
}

function SignalSection(props: {
  card: SignalCard;
  day: (ms: number) => string;
  defaults: RiskDefaults;
  /** False when a past date is shown: later bars were left out on purpose. */
  live: boolean;
  fromFiles: boolean;
}) {
  const { card, day, defaults, live, fromFiles } = props;
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

  const { indicators: ind, state, sizing, today, plan } = card;
  const up = ind.close > ind.trendSma;
  const exitRule = (direction: "BUY" | "SELL"): string =>
    `тейка нет; закрыть на открытии после дня, который закроется ${direction === "BUY" ? "выше" : "ниже"} SMA(${RSI2_REVERSION.exitSmaPeriod}), сейчас она ${price(ind.exitSma)}`;
  const held = (position: DailyPosition): string =>
    `${DIRECTION[position.direction]} с ${day(position.entryTime)} по ${price(position.entryPrice)} (открытие дня); закрытий в сделке: ${position.days}`;
  const lot: ReactNode = sizing === null ? null : <LotAdvice rules={card.lotRules} stopDistance={sizing.stopDistance} defaults={defaults} />;

  // The hint for a trade: where to enter, where the stop is, which lot, when to leave.
  const steps: { name: string; text: ReactNode }[] = [];
  if (state.kind === "enter" && sizing !== null) {
    const below = state.direction === "BUY" ? "ниже" : "выше";
    if (plan !== null && today !== null) {
      steps.push({ name: "Вход", text: `${ACTION[state.direction]} по рынку сегодня. Открытие дня ${price(plan.entryPrice)}, сейчас ${price(today.last)}.` });
      steps.push({ name: "Стоп", text: `${price(plan.stopPrice)} — на ${price(sizing.stopDistance)} ${below} открытия дня.` });
    } else {
      const around = state.direction === "BUY" ? ind.close - sizing.stopDistance : ind.close + sizing.stopDistance;
      steps.push({ name: "Вход", text: `${ACTION[state.direction]} на открытии следующего дня.` });
      steps.push({ name: "Стоп", text: `на ${price(sizing.stopDistance)} ${below} цены входа; при входе около ${price(ind.close)} это ${price(around)}.` });
    }
    steps.push({ name: "Лот", text: lot });
    steps.push({ name: "Выход", text: `${exitRule(state.direction)}.` });
  } else if (state.kind === "open") {
    steps.push({ name: "Позиция", text: `${held(state.position)}.` });
    steps.push({ name: "Стоп", text: `${price(state.position.stopLoss)}.` });
    steps.push({ name: "Лот", text: lot });
    steps.push({ name: "Выход", text: `${exitRule(state.position.direction)}; закрытие ${price(ind.close)}.` });
  } else if (state.kind === "exit") {
    const when = today !== null ? "по рынку сегодня" : "на открытии следующего дня";
    const side = state.position.direction === "BUY" ? "выше" : "ниже";
    steps.push({ name: "Выход", text: `закрыть ${TO_CLOSE[state.position.direction]} ${when}: последний день закрылся ${side} SMA(${RSI2_REVERSION.exitSmaPeriod}).` });
    steps.push({ name: "Позиция", text: `${held(state.position)}; стоп ${price(state.position.stopLoss)}.` });
  }

  const next = card.nextDay;
  const nextText =
    next === null || today === null ? null
    : next.kind === "enter" && next.direction !== null ? `вход, ${DIRECTION[next.direction]}`
    : next.kind === "exit" ? "выход из позиции"
    : next.kind === "open" ? "позиция остаётся"
    : "сигнала нет";

  return (
    <section className="card signal-card">
      {heading}
      <p className="muted">
        По дневной свече за {day(card.asOf)}
        {live && card.unfinishedDayDropped ? "; сегодняшняя свеча ещё не закрыта и в состояние не входит" : ""}
        {live && fromFiles && card.ageDays > STALE_AFTER_DAYS ? `, данным ${card.ageDays} дн` : ""}.{card.note === null ? "" : ` ${card.note}`}
      </p>

      {steps.length > 0 && (
        <dl className="signal-plan">
          {steps.map((step) => (
            <div key={step.name}>
              <dt>{step.name}</dt>
              <dd>{step.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {plan !== null && plan.stopTouched && <p className="bad">Сегодня цена уже доходила до стопа: по правилу такой вход пропускают.</p>}
      {card.stopTouchedToday && <p className="bad">Сегодня цена дошла до стопа: позиция по правилу закрыта.</p>}
      {state.kind === "flat" && (
        <p>
          {up
            ? `Индекс выше SMA(${RSI2_REVERSION.trendSmaPeriod}): покупка будет, когда RSI(${RSI2_REVERSION.rsiPeriod}) опустится ниже ${RSI2_REVERSION.buyBelowRsi}. Сейчас ${ind.rsi.toFixed(1)}.`
            : `Индекс ниже SMA(${RSI2_REVERSION.trendSmaPeriod}): продажа будет, когда RSI(${RSI2_REVERSION.rsiPeriod}) поднимется выше ${RSI2_REVERSION.sellAboveRsi}. Сейчас ${ind.rsi.toFixed(1)}.`}
        </p>
      )}
      {live && nextText !== null && today !== null && (
        <p className="note">
          Если сегодняшний день закроется по текущей цене {price(today.last)}, завтра: <strong>{nextText}</strong>.
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
