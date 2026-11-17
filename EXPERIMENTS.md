# EXPERIMENTS

Журнал запусков на наборах `test` и `holdout` (раздел 6 ТЗ). Записи дописывает команда `backtest` автоматически. Руками не править и не удалять.

Если правило изменили после просмотра `test`, это новая стратегия с новым именем, и её `test`-результат уже не считается независимым.

## Запуски

### 2026-11-17 13:13:27 UTC · TrendD1 · test

- Набор данных: `test`, с 2021-12-09 по 2024-11-15 включительно (1073 дн., дни сервера `Europe/Athens`)
- Параметры:
  - entryLookback: 55
  - exitLookback: 20
  - atrPeriod: 20
  - atrMultiple: 2
  - atrMethod: Wilder
  - signalTimeframe: D1
  - executionTimeframe: H1
  - initialCapitalUsd: 10000
  - riskPerTradePct: 0.5
  - minSpreadPoints: 5
  - commissionPerLotRoundTrip: 7
  - slippagePips: 0.2
  - swap: {"EURUSD":{"swapLongPips":-1.3472,"swapShortPips":0.0107},"GBPUSD":{"swapLongPips":-1.713,"swapShortPips":-0.2977},"USDJPY":{"swapLongPips":-1.95912,"swapShortPips":-4.0755}}
  - usdExposureLimit: false
- Главные метрики:
  - Вердикт: REJECT
  - Сделок: 45
  - Прибыльных: 31.1%
  - Средний R: −0.296
  - Profit Factor: 0.56
  - Максимальная просадка: 9.4%
  - Итог после издержек, USD: -556.83
  - Итог до издержек, USD: -59.53
  - Стресс-тест, USD: -571.96
  - 95% ДИ среднего R: −0.651 … +0.135
  - Файлы: test/2026-11-17_13-13-27_TrendD1

### 2026-11-17 13:13:31 UTC · BreakoutRetestV1-A · test

- Набор данных: `test`, с 2021-12-09 по 2024-11-15 включительно (1073 дн., дни сервера `Europe/Athens`)
- Параметры:
  - levelLookbackH1: 20
  - atrPeriodH1: 14
  - atrMethod: Wilder
  - breakoutBufferAtr: 0.1
  - retestBarsH1: 6
  - confirmBarsM15: 4
  - stopBufferAtr: 0.1
  - maxStopAtr: 1.5
  - takeProfitR: 2
  - sessions: 08:00-17:00 Europe/London or America/New_York, inclusive
  - cancelOnGapAfterConfirmation: true
  - trendFilter: none
  - executionTimeframe: M15
  - initialCapitalUsd: 10000
  - riskPerTradePct: 0.5
  - minSpreadPoints: 5
  - commissionPerLotRoundTrip: 7
  - slippagePips: 0.2
  - swap: {"EURUSD":{"swapLongPips":-1.3472,"swapShortPips":0.0107},"GBPUSD":{"swapLongPips":-1.713,"swapShortPips":-0.2977},"USDJPY":{"swapLongPips":-1.95912,"swapShortPips":-4.0755}}
  - usdExposureLimit: false
- Главные метрики:
  - Вердикт: REJECT
  - Сделок: 499
  - Прибыльных: 29.9%
  - Средний R: −0.245
  - Profit Factor: 0.70
  - Максимальная просадка: 47.2%
  - Итог после издержек, USD: -4578.30
  - Итог до издержек, USD: -1444.59
  - Стресс-тест, USD: -6310.59
  - 95% ДИ среднего R: −0.368 … −0.117
  - Файлы: test/2026-11-17_13-13-31_BreakoutRetestV1-A

### 2026-11-17 13:13:36 UTC · BreakoutRetestV1-B · test

- Набор данных: `test`, с 2021-12-09 по 2024-11-15 включительно (1073 дн., дни сервера `Europe/Athens`)
- Параметры:
  - levelLookbackH1: 20
  - atrPeriodH1: 14
  - atrMethod: Wilder
  - breakoutBufferAtr: 0.1
  - retestBarsH1: 6
  - confirmBarsM15: 4
  - stopBufferAtr: 0.1
  - maxStopAtr: 1.5
  - takeProfitR: 2
  - sessions: 08:00-17:00 Europe/London or America/New_York, inclusive
  - cancelOnGapAfterConfirmation: true
  - trendFilter: SMA(200) H1
  - executionTimeframe: M15
  - initialCapitalUsd: 10000
  - riskPerTradePct: 0.5
  - minSpreadPoints: 5
  - commissionPerLotRoundTrip: 7
  - slippagePips: 0.2
  - swap: {"EURUSD":{"swapLongPips":-1.3472,"swapShortPips":0.0107},"GBPUSD":{"swapLongPips":-1.713,"swapShortPips":-0.2977},"USDJPY":{"swapLongPips":-1.95912,"swapShortPips":-4.0755}}
  - usdExposureLimit: false
- Главные метрики:
  - Вердикт: REJECT
  - Сделок: 392
  - Прибыльных: 30.1%
  - Средний R: −0.231
  - Profit Factor: 0.70
  - Максимальная просадка: 40.4%
  - Итог после издержек, USD: -3693.09
  - Итог до издержек, USD: -1053.77
  - Стресс-тест, USD: -5229.55
  - 95% ДИ среднего R: −0.369 … −0.092
  - Файлы: test/2026-11-17_13-13-36_BreakoutRetestV1-B
