# algotred-web

Движок бэктеста торговых стратегий (этап 1) и локальный сайт-оболочка над ним. Задание — в [TZ-backtest-engine.md](TZ-backtest-engine.md).

Нужен Node.js 20 или новее.

```
npm install
npm test                                              # тесты
npm run typecheck                                     # проверка типов
npm run validate                                      # проверка CSV из data/raw (шаг 2, пока заглушка)
npm run backtest -- --strategy TrendD1 --dataset dev  # бэктест (шаги 3–6, пока заглушка)
npm run dev                                           # сайт на http://localhost:3000
```

CSV из MetaTrader 5 кладутся в `data/raw/` под именами вида `EURUSD_H1.csv`. В git они не попадают.

Настройки — в `config/default.json`. Параметры стратегий в конфиг не вынесены: они зафиксированы в ТЗ.
