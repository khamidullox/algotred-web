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

### 2026-11-19 14:15:32 UTC · Rsi2ReversionIndexD1 · test

- Набор данных: `test`, с 2021-12-09 по 2024-11-15 включительно (1073 дн., дни сервера `Europe/Athens`)
- Параметры:
  - rsiPeriod: 2
  - buyBelowRsi: 5
  - sellAboveRsi: 95
  - trendSmaPeriod: 200
  - exitSmaPeriod: 5
  - atrPeriod: 20
  - atrMultiple: 2
  - rsiMethod: Wilder (as MT5 Relative Strength Index)
  - atrMethod: Wilder
  - signalTimeframe: D1
  - executionTimeframe: H1
  - initialCapitalUsd: 10000
  - riskPerTradePct: 0.5
  - minSpreadPoints: 5
  - commissionPerLotRoundTrip: 7
  - slippagePips: 0.2
  - symbols: US500, US30, US2000
  - swapPipsLongShort: {"EURUSD":[-1.3472,0.0107],"GBPUSD":[-1.713,-0.2977],"USDJPY":[-1.95912,-4.0755],"AUDUSD":[-0.687,-0.216],"NZDUSD":[0.134385,-0.24284],"USDCAD":[-0.26,-0.804],"USDCHF":[-0.99697,-1.6822],"XAUUSD":[-10.7151,-4.6917],"US500":[-13.4693,-3.663],"US30":[-23.2077,-99.606],"US2000":[-4.9956,-1.3586]}
  - usdExposureLimit: false
- Главные метрики:
  - Вердикт: REJECT
  - Сделок: 40
  - Прибыльных: 67.5%
  - Средний R: +0.168
  - Profit Factor: 2.34
  - Максимальная просадка: 0.5%
  - Итог после издержек, USD: 293.86
  - Итог до издержек, USD: 349.35
  - Стресс-тест, USD: 235.05
  - 95% ДИ среднего R: +0.004 … +0.319
  - Файлы: test/2026-11-19_14-15-32_Rsi2ReversionIndexD1

### 2026-11-19 14:16:02 UTC · Rsi2IndexControl · test

- Набор данных: `test`, с 2021-12-09 по 2024-11-15 включительно (1073 дн., дни сервера `Europe/Athens`)
- Параметры:
  - rsiPeriod: 2
  - trendSmaPeriod: 200
  - atrPeriod: 20
  - atrMultiple: 2
  - neutralRsiLow: 45
  - neutralRsiHigh: 55
  - holdDays: 4
  - signalTimeframe: D1
  - executionTimeframe: H1
  - initialCapitalUsd: 10000
  - riskPerTradePct: 0.5
  - minSpreadPoints: 5
  - commissionPerLotRoundTrip: 7
  - slippagePips: 0.2
  - symbols: US500, US30, US2000
  - swapPipsLongShort: {"EURUSD":[-1.3472,0.0107],"GBPUSD":[-1.713,-0.2977],"USDJPY":[-1.95912,-4.0755],"AUDUSD":[-0.687,-0.216],"NZDUSD":[0.134385,-0.24284],"USDCAD":[-0.26,-0.804],"USDCHF":[-0.99697,-1.6822],"XAUUSD":[-10.7151,-4.6917],"US500":[-13.4693,-3.663],"US30":[-23.2077,-99.606],"US2000":[-4.9956,-1.3586]}
  - usdExposureLimit: false
- Главные метрики:
  - Вердикт: REJECT
  - Сделок: 95
  - Прибыльных: 46.3%
  - Средний R: −0.050
  - Profit Factor: 0.84
  - Максимальная просадка: 3.5%
  - Итог после издержек, USD: -175.48
  - Итог до издержек, USD: -41.43
  - Стресс-тест, USD: -230.85
  - 95% ДИ среднего R: −0.169 … +0.069
  - Файлы: test/2026-11-19_14-16-02_Rsi2IndexControl

### 2026-11-19 14:19:16 UTC · Rsi2ReversionIndexD1 · holdout

- Набор данных: `holdout`, с 2024-11-16 по 2026-10-29 включительно (713 дн., дни сервера `Europe/Athens`)
- Параметры:
  - rsiPeriod: 2
  - buyBelowRsi: 5
  - sellAboveRsi: 95
  - trendSmaPeriod: 200
  - exitSmaPeriod: 5
  - atrPeriod: 20
  - atrMultiple: 2
  - rsiMethod: Wilder (as MT5 Relative Strength Index)
  - atrMethod: Wilder
  - signalTimeframe: D1
  - executionTimeframe: H1
  - initialCapitalUsd: 10000
  - riskPerTradePct: 0.5
  - minSpreadPoints: 5
  - commissionPerLotRoundTrip: 7
  - slippagePips: 0.2
  - symbols: US500, US30, US2000
  - swapPipsLongShort: {"EURUSD":[-1.3472,0.0107],"GBPUSD":[-1.713,-0.2977],"USDJPY":[-1.95912,-4.0755],"AUDUSD":[-0.687,-0.216],"NZDUSD":[0.134385,-0.24284],"USDCAD":[-0.26,-0.804],"USDCHF":[-0.99697,-1.6822],"XAUUSD":[-10.7151,-4.6917],"US500":[-13.4693,-3.663],"US30":[-23.2077,-99.606],"US2000":[-4.9956,-1.3586]}
  - usdExposureLimit: false
- Главные метрики:
  - Вердикт: REJECT
  - Сделок: 26
  - Прибыльных: 80.8%
  - Средний R: +0.265
  - Profit Factor: 2.98
  - Максимальная просадка: 1.0%
  - Итог после издержек, USD: 302.52
  - Итог до издержек, USD: 341.58
  - Стресс-тест, USD: 292.18
  - 95% ДИ среднего R: +0.041 … +0.474
  - Файлы: holdout/2026-11-19_14-19-16_Rsi2ReversionIndexD1

### 2026-11-19 14:19:46 UTC · Rsi2IndexControl · holdout

- Набор данных: `holdout`, с 2024-11-16 по 2026-10-29 включительно (713 дн., дни сервера `Europe/Athens`)
- Параметры:
  - rsiPeriod: 2
  - trendSmaPeriod: 200
  - atrPeriod: 20
  - atrMultiple: 2
  - neutralRsiLow: 45
  - neutralRsiHigh: 55
  - holdDays: 4
  - signalTimeframe: D1
  - executionTimeframe: H1
  - initialCapitalUsd: 10000
  - riskPerTradePct: 0.5
  - minSpreadPoints: 5
  - commissionPerLotRoundTrip: 7
  - slippagePips: 0.2
  - symbols: US500, US30, US2000
  - swapPipsLongShort: {"EURUSD":[-1.3472,0.0107],"GBPUSD":[-1.713,-0.2977],"USDJPY":[-1.95912,-4.0755],"AUDUSD":[-0.687,-0.216],"NZDUSD":[0.134385,-0.24284],"USDCAD":[-0.26,-0.804],"USDCHF":[-0.99697,-1.6822],"XAUUSD":[-10.7151,-4.6917],"US500":[-13.4693,-3.663],"US30":[-23.2077,-99.606],"US2000":[-4.9956,-1.3586]}
  - usdExposureLimit: false
- Главные метрики:
  - Вердикт: REJECT
  - Сделок: 58
  - Прибыльных: 50.0%
  - Средний R: −0.025
  - Profit Factor: 0.86
  - Максимальная просадка: 1.8%
  - Итог после издержек, USD: -101.01
  - Итог до издержек, USD: 4.17
  - Стресс-тест, USD: -116.16
  - 95% ДИ среднего R: −0.200 … +0.149
  - Файлы: holdout/2026-11-19_14-19-46_Rsi2IndexControl

### 2026-11-20 10:39:11 UTC · IbsDipIndexD1 · test

- Набор данных: `test`, с 2021-12-09 по 2024-11-15 включительно (1073 дн., дни сервера `Europe/Athens`)
- Параметры:
  - ibsBelow: 0.1
  - rsiPeriod: 2
  - exitAboveRsi: 70
  - maxDays: 10
  - atrPeriod: 20
  - atrMultiple: 2
  - direction: long only
  - atrMethod: Wilder
  - rsiMethod: Wilder (as MT5 Relative Strength Index)
  - signalTimeframe: D1
  - executionTimeframe: H1
  - initialCapitalUsd: 10000
  - riskPerTradePct: 0.5
  - minSpreadPoints: 5
  - commissionPerLotRoundTrip: 7
  - slippagePips: 0.2
  - symbols: US500, US30, US2000
  - swapPipsLongShort: {"EURUSD":[-1.3472,0.0107],"GBPUSD":[-1.713,-0.2977],"USDJPY":[-1.95912,-4.0755],"AUDUSD":[-0.687,-0.216],"NZDUSD":[0.134385,-0.24284],"USDCAD":[-0.26,-0.804],"USDCHF":[-0.99697,-1.6822],"XAUUSD":[-10.7151,-4.6917],"US500":[-13.4693,-3.663],"US30":[-23.2077,-99.606],"US2000":[-4.9956,-1.3586]}
  - usdExposureLimit: false
- Главные метрики:
  - Вердикт: INCONCLUSIVE
  - Сделок: 111
  - Прибыльных: 66.7%
  - Средний R: +0.004
  - Profit Factor: 1.02
  - Максимальная просадка: 3.6%
  - Итог после издержек, USD: 29.81
  - Итог до издержек, USD: 191.31
  - Стресс-тест, USD: -67.09
  - 95% ДИ среднего R: −0.124 … +0.134
  - Файлы: test/2026-11-20_10-39-11_IbsDipIndexD1

### 2026-11-20 10:40:00 UTC · IbsIndexControl · test

- Набор данных: `test`, с 2021-12-09 по 2024-11-15 включительно (1073 дн., дни сервера `Europe/Athens`)
- Параметры:
  - ibsBelow: 0.55
  - rsiPeriod: 2
  - exitAboveRsi: 70
  - maxDays: 10
  - atrPeriod: 20
  - atrMultiple: 2
  - ibsFrom: 0.45
  - direction: long only
  - atrMethod: Wilder
  - rsiMethod: Wilder (as MT5 Relative Strength Index)
  - signalTimeframe: D1
  - executionTimeframe: H1
  - initialCapitalUsd: 10000
  - riskPerTradePct: 0.5
  - minSpreadPoints: 5
  - commissionPerLotRoundTrip: 7
  - slippagePips: 0.2
  - symbols: US500, US30, US2000
  - swapPipsLongShort: {"EURUSD":[-1.3472,0.0107],"GBPUSD":[-1.713,-0.2977],"USDJPY":[-1.95912,-4.0755],"AUDUSD":[-0.687,-0.216],"NZDUSD":[0.134385,-0.24284],"USDCAD":[-0.26,-0.804],"USDCHF":[-0.99697,-1.6822],"XAUUSD":[-10.7151,-4.6917],"US500":[-13.4693,-3.663],"US30":[-23.2077,-99.606],"US2000":[-4.9956,-1.3586]}
  - usdExposureLimit: false
- Главные метрики:
  - Вердикт: REJECT
  - Сделок: 94
  - Прибыльных: 71.3%
  - Средний R: +0.079
  - Profit Factor: 1.52
  - Максимальная просадка: 1.6%
  - Итог после издержек, USD: 315.43
  - Итог до издержек, USD: 450.74
  - Стресс-тест, USD: 272.16
  - 95% ДИ среднего R: −0.024 … +0.184
  - Файлы: test/2026-11-20_10-40-00_IbsIndexControl
