//+------------------------------------------------------------------+
//| Rsi2IndexSignal.mq5                                              |
//| Shows what the frozen rule Rsi2ReversionIndexD1 (TZ 17.12) says  |
//| on the daily candles of the US index CFDs of this terminal:      |
//| a signal to enter, an open position, a signal to leave, or       |
//| nothing, with the stop and the lot for the chosen risk.          |
//|                                                                  |
//| It is an indicator: it reads prices and draws text and marks.    |
//| It opens no orders, closes none and changes no account setting.  |
//|                                                                  |
//| The calculation repeats src/signals/daily-state.ts step by step  |
//| (entry and exit at the open of the next daily candle, the stop   |
//| checked on the day's range); research/check-mt5-signal.ts holds  |
//| the same loop in TypeScript and compares it with the engine.     |
//| The rule is frozen: its numbers are constants, not inputs.       |
//|                                                                  |
//| Since 1.10 it also feeds the project's "Signals" page: every 30  |
//| seconds it rewrites the daily bars of each index and feed.json   |
//| (contract facts, balance) in Common\Files\algotred_feed. The     |
//| page reads them; nothing is sent anywhere outside this computer. |
//|                                                                  |
//| Since 1.20 the texts follow the hour the orders are placed by    |
//| hand, 09:00 Tashkent time (TZ 17.49): the stop is shown as a     |
//| distance from the actual entry price, not from the day's open.   |
//+------------------------------------------------------------------+
#property copyright   "algotred"
#property version     "1.20"
#property description "Rsi2ReversionIndexD1: what the rule says today on the US indices."
#property description "Shows the signal, the stop and the lot. Places no orders."
#property indicator_chart_window
#property indicator_plots 0

input string InpSymbols       = "";     // Индексы через запятую (пусто = найти самому)
input double InpRiskPercent   = 1.0;    // Риск на сделку, % от счёта
input double InpAccountSize   = 0.0;    // Размер счёта для расчёта риска (0 = баланс)
input bool   InpShowHistory   = true;   // Рисовать прошлые сделки правила на графике
input int    InpHistoryTrades = 30;     // Сколько прошлых сделок рисовать
input bool   InpAlert         = true;   // Окно с сообщением в день входа и выхода
input bool   InpPush          = false;  // Сообщение на телефон (нужен MetaQuotes ID)
input bool   InpExport        = true;   // Записывать сделки правила в файл для сверки
input bool   InpFeed          = true;   // Передавать данные на страницу «Сигналы» сайта
input int    InpFontSize      = 10;     // Размер шрифта
input int    InpX             = 10;     // Отступ слева, точек
input int    InpY             = 25;     // Отступ сверху, точек

//--- the rule, fixed by TZ 17.4 and confirmed in TZ 17.12
#define RSI_PERIOD    2
#define BUY_BELOW     5.0
#define SELL_ABOVE    95.0
#define TREND_PERIOD  200
#define EXIT_PERIOD   5
#define ATR_PERIOD    20
#define ATR_MULTIPLE  2.0

#define PRICE_UNITS   100000000.0   // SMA sums prices as whole units of 1e-8, like src/indicators/sma.ts
#define MAX_BARS      20000
#define MIN_BARS      230
#define DAY_SECONDS   86400
#define REFRESH_SECONDS 10

// When the orders are placed by hand. The rule was checked with exactly this
// hour on dev, test and holdout (Rsi2ReversionIndexD1At9Tashkent, TZ 17.49).
#define ORDER_HOUR    "к 9:00 по Ташкенту"

#define FEED_FOLDER   "algotred_feed"   // inside the terminal's common Files folder
#define FEED_SECONDS  30

#define PREFIX        "algotred_rsi2_"
#define FONT          "Consolas"
#define SEP           " · "
#define LINE_LIMIT    63            // a text label is kept this short to be safe in every build

#define STATE_FLAT    0
#define STATE_ENTER   1
#define STATE_OPEN    2
#define STATE_EXIT    3

#define PENDING_NONE  0
#define PENDING_ENTRY 1
#define PENDING_EXIT  2

#define COLOR_PANEL   C'18,22,30'
#define COLOR_HEAD    clrWhite
#define COLOR_TEXT    clrSilver
#define COLOR_DIM     clrGray
#define COLOR_BUY     clrLime
#define COLOR_SELL    clrTomato
#define COLOR_EXIT    clrOrange
#define COLOR_HOLD    clrDeepSkyBlue
#define COLOR_NOTE    clrKhaki

//--- a closed trade of the rule
struct RuleTrade
  {
   int               direction;   // +1 buy, -1 sell
   datetime          signalTime;  // the day whose close gave the signal
   datetime          entryTime;   // the day of the entry, at its open
   double            entryPrice;
   double            stopLoss;
   datetime          exitTime;    // the day the position was closed in
   double            exitPrice;
   bool              byStop;
   double            r;           // the move in units of the stop distance, before costs
  };

//--- where the rule stands after the last bar given to Replay
struct RuleResult
  {
   int               state;
   int               direction;     // of the signal (ENTER) or of the position (OPEN, EXIT)
   double            stopDistance;  // ENTER: 2 x ATR(20)
   datetime          signalTime;
   datetime          entryTime;     // OPEN, EXIT
   double            entryPrice;
   double            stopLoss;
   int               days;
   bool              ready;         // every indicator has a value
   double            close;
   double            trendSma;
   double            exitSma;
   double            rsi;
   double            atr;
  };

string   g_symbols[];
string   g_titles[];
bool     g_exists[];
datetime g_exported[];
string   g_lines[];
color    g_colors[];
int      g_lineCount  = 0;
int      g_shownLines = 0;
string   g_drawnKey   = "";
datetime g_feedWritten = 0;     // local time of the last feed for the site
bool     g_feedDue     = false; // this refresh writes the feed
string   g_feedSymbols = "";    // the "symbols" array of feed.json being put together

//+------------------------------------------------------------------+
//| Small helpers                                                    |
//+------------------------------------------------------------------+
string DateText(const datetime time)
  {
   MqlDateTime parts;
   TimeToStruct(time, parts);
   return StringFormat("%02d.%02d.%04d", parts.day, parts.mon, parts.year);
  }

string TitleOf(const string symbol)
  {
   string name = symbol;
   StringToUpper(name);
   if(StringFind(name, "2000") >= 0 || StringFind(name, "RTY") >= 0 || StringFind(name, "RUS") >= 0)
      return "Russell 2000";
   if(StringFind(name, "500") >= 0 || StringFind(name, "SPX") >= 0)
      return "S&P 500";
   if(StringFind(name, "NDX") >= 0 || StringFind(name, "NAS") >= 0 || StringFind(name, "TEC") >= 0 ||
      StringFind(name, "100") >= 0 || StringFind(name, "NQ") >= 0)
      return "Nasdaq 100";
   if(StringFind(name, "30") >= 0 || StringFind(name, "DJ") >= 0)
      return "Dow Jones";
   return "";
  }

void AddSymbol(const string symbol, const bool exists)
  {
   const int size = ArraySize(g_symbols);
   for(int i = 0; i < size; i++)
      if(g_symbols[i] == symbol)
         return;
   ArrayResize(g_symbols, size + 1);
   ArrayResize(g_titles, size + 1);
   ArrayResize(g_exists, size + 1);
   ArrayResize(g_exported, size + 1);
   g_symbols[size]  = symbol;
   g_titles[size]   = TitleOf(symbol);
   g_exists[size]   = exists;
   g_exported[size] = 0;
   if(exists)
      SymbolSelect(symbol, true);
  }

// The first name of the list this broker has.
void AddFirstKnown(const string aliases)
  {
   string names[];
   const int count = StringSplit(aliases, ',', names);
   for(int i = 0; i < count; i++)
     {
      bool custom = false;
      if(SymbolExist(names[i], custom))
        {
         AddSymbol(names[i], true);
         return;
        }
     }
  }

void BuildSymbolList()
  {
   ArrayResize(g_symbols, 0);
   ArrayResize(g_titles, 0);
   ArrayResize(g_exists, 0);
   ArrayResize(g_exported, 0);
   string list = InpSymbols;
   StringTrimLeft(list);
   StringTrimRight(list);
   if(list != "")
     {
      string names[];
      const int count = StringSplit(list, ',', names);
      for(int i = 0; i < count; i++)
        {
         string name = names[i];
         StringTrimLeft(name);
         StringTrimRight(name);
         if(name == "")
            continue;
         bool custom = false;
         AddSymbol(name, SymbolExist(name, custom));
        }
      return;
     }
   AddFirstKnown("US500,SPX500,SP500,US500.cash,US500Cash,USA500,SPX,US500m,SPX500m");
   AddFirstKnown("US2000,RUSSELL2000,RUS2000,US2000.cash,US2000Cash,USA2000,RTY,US2000m");
   AddFirstKnown("NDX100,NAS100,USTEC,US100,USTECH,USTECH100,USTECH100M,NAS100.cash,US100.cash,US100Cash,USTECm,NAS100m");
   AddFirstKnown("US30,DJ30,WS30,DJI30,US30.cash,US30Cash,USA30,US30m");
  }

//+------------------------------------------------------------------+
//| The rule over daily bars, oldest first                           |
//+------------------------------------------------------------------+
void AddTrade(RuleTrade &trades[], int &total, const int direction, const datetime signalTime,
              const datetime entryTime, const double entryPrice, const double stopLoss,
              const datetime exitTime, const double exitPrice, const bool byStop)
  {
   ArrayResize(trades, total + 1, 256);
   const double distance = direction * (entryPrice - stopLoss);
   trades[total].direction  = direction;
   trades[total].signalTime = signalTime;
   trades[total].entryTime  = entryTime;
   trades[total].entryPrice = entryPrice;
   trades[total].stopLoss   = stopLoss;
   trades[total].exitTime   = exitTime;
   trades[total].exitPrice  = exitPrice;
   trades[total].byStop     = byStop;
   trades[total].r          = direction * (exitPrice - entryPrice) / distance;
   total++;
  }

// Walks the first `count` bars as closed days and reports the state after the last one.
void Replay(const MqlRates &bars[], const int count, const int digits, RuleResult &result, RuleTrade &trades[])
  {
   int      total = 0;
   ArrayResize(trades, 0, 256);

   bool     held          = false;
   int      heldDirection = 0;
   datetime heldSignal    = 0;
   datetime heldEntryTime = 0;
   double   heldEntry     = 0.0;
   double   heldStop      = 0.0;
   int      heldDays      = 0;

   int      pending          = PENDING_NONE;
   int      pendingDirection = 0;
   double   pendingDistance  = 0.0;
   datetime pendingSignal    = 0;

   // Wilder RSI on closes, as MT5's Relative Strength Index
   double   gainSum = 0.0, lossSum = 0.0, gain = 0.0, loss = 0.0, rsi = 0.0;
   int      rsiCount = 0;
   bool     rsiReady = false;
   // Wilder ATR (MT5's own ATR indicator is a simple average and shows other numbers)
   double   rangeSum = 0.0, atr = 0.0;
   int      atrCount = 0;
   bool     atrReady = false;
   // simple averages of the close, summed in whole units of 1e-8
   long     trendSum = 0, exitSum = 0;
   double   trendSma = 0.0, exitSma = 0.0;
   bool     trendReady = false, exitReady = false;

   for(int i = 0; i < count; i++)
     {
      const double open  = bars[i].open;
      const double high  = bars[i].high;
      const double low   = bars[i].low;
      const double close = bars[i].close;

      //--- the open of the day: what the previous close decided
      if(pending == PENDING_ENTRY && !held)
        {
         const double stop = NormalizeDouble(open - pendingDirection * pendingDistance, digits);
         // a stop on the wrong side of the open: no trade
         if(pendingDirection * (open - stop) > 0.0)
           {
            held          = true;
            heldDirection = pendingDirection;
            heldSignal    = pendingSignal;
            heldEntryTime = bars[i].time;
            heldEntry     = open;
            heldStop      = stop;
            heldDays      = 0;
           }
        }
      else if(pending == PENDING_EXIT && held)
        {
         AddTrade(trades, total, heldDirection, heldSignal, heldEntryTime, heldEntry, heldStop, bars[i].time, open, false);
         held = false;
        }
      pending = PENDING_NONE;

      //--- inside the day: the stop, at the open when the day opens beyond it
      if(held)
        {
         if(heldDirection > 0 && low <= heldStop)
           {
            AddTrade(trades, total, heldDirection, heldSignal, heldEntryTime, heldEntry, heldStop, bars[i].time, MathMin(open, heldStop), true);
            held = false;
           }
         else if(heldDirection < 0 && high >= heldStop)
           {
            AddTrade(trades, total, heldDirection, heldSignal, heldEntryTime, heldEntry, heldStop, bars[i].time, MathMax(open, heldStop), true);
            held = false;
           }
        }

      //--- the close of the day: the indicators
      if(i > 0)
        {
         const double previous = bars[i - 1].close;
         const double change   = close - previous;
         const double up       = change > 0.0 ? change : 0.0;
         const double down     = change < 0.0 ? -change : 0.0;
         if(rsiCount < RSI_PERIOD)
           {
            gainSum += up;
            lossSum += down;
            rsiCount++;
            if(rsiCount == RSI_PERIOD)
              {
               gain = gainSum / RSI_PERIOD;
               loss = lossSum / RSI_PERIOD;
              }
           }
         else
           {
            gain = (gain * (RSI_PERIOD - 1) + up) / RSI_PERIOD;
            loss = (loss * (RSI_PERIOD - 1) + down) / RSI_PERIOD;
           }
         rsiReady = (rsiCount == RSI_PERIOD);
         if(rsiReady)
           {
            if(loss == 0.0)
               rsi = (gain == 0.0) ? 50.0 : 100.0;
            else
               rsi = 100.0 - 100.0 / (1.0 + gain / loss);
           }

         const double range = MathMax(high - low, MathMax(MathAbs(high - previous), MathAbs(low - previous)));
         if(atrCount < ATR_PERIOD)
           {
            rangeSum += range;
            atrCount++;
            if(atrCount == ATR_PERIOD)
               atr = rangeSum / ATR_PERIOD;
           }
         else
            atr = (atr * (ATR_PERIOD - 1) + range) / ATR_PERIOD;
         atrReady = (atrCount == ATR_PERIOD);
        }

      trendSum += (long)MathRound(close * PRICE_UNITS);
      if(i >= TREND_PERIOD)
         trendSum -= (long)MathRound(bars[i - TREND_PERIOD].close * PRICE_UNITS);
      trendReady = (i >= TREND_PERIOD - 1);
      if(trendReady)
         trendSma = (double)trendSum / (TREND_PERIOD * PRICE_UNITS);

      exitSum += (long)MathRound(close * PRICE_UNITS);
      if(i >= EXIT_PERIOD)
         exitSum -= (long)MathRound(bars[i - EXIT_PERIOD].close * PRICE_UNITS);
      exitReady = (i >= EXIT_PERIOD - 1);
      if(exitReady)
         exitSma = (double)exitSum / (EXIT_PERIOD * PRICE_UNITS);

      //--- the close of the day: the rule
      if(held)
        {
         heldDays++;
         // the exit, checked from the close of the entry day on
         if(exitReady && (heldDirection > 0 ? close > exitSma : close < exitSma))
            pending = PENDING_EXIT;
        }
      else if(atrReady && rsiReady && trendReady)
        {
         const bool buy  = close > trendSma && rsi < BUY_BELOW;
         const bool sell = close < trendSma && rsi > SELL_ABOVE;
         if(buy || sell)
           {
            pending          = PENDING_ENTRY;
            pendingDirection = buy ? 1 : -1;
            pendingDistance  = ATR_MULTIPLE * atr;
            pendingSignal    = bars[i].time;
           }
        }
     }

   result.state        = STATE_FLAT;
   result.direction    = 0;
   result.stopDistance = 0.0;
   result.signalTime   = 0;
   result.entryTime    = 0;
   result.entryPrice   = 0.0;
   result.stopLoss     = 0.0;
   result.days         = 0;
   if(held)
     {
      result.direction  = heldDirection;
      result.signalTime = heldSignal;
      result.entryTime  = heldEntryTime;
      result.entryPrice = heldEntry;
      result.stopLoss   = heldStop;
      result.days       = heldDays;
     }
   if(pending == PENDING_ENTRY)
     {
      result.state        = STATE_ENTER;
      result.direction    = pendingDirection;
      result.stopDistance = pendingDistance;
      result.signalTime   = pendingSignal;
     }
   else if(pending == PENDING_EXIT && held)
      result.state = STATE_EXIT;
   else if(held)
      result.state = STATE_OPEN;

   result.ready    = atrReady && rsiReady && trendReady && exitReady;
   result.close    = count > 0 ? bars[count - 1].close : 0.0;
   result.trendSma = trendSma;
   result.exitSma  = exitSma;
   result.rsi      = rsi;
   result.atr      = atr;
  }

//+------------------------------------------------------------------+
//| Risk and lot                                                     |
//+------------------------------------------------------------------+
double AccountSize()
  {
   return InpAccountSize > 0.0 ? InpAccountSize : AccountInfoDouble(ACCOUNT_BALANCE);
  }

// Money lost by one lot when the price moves `distance` against it.
double LossPerLot(const string symbol, const double distance)
  {
   const double tickSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickValue <= 0.0)
      tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   if(tickSize <= 0.0 || tickValue <= 0.0)
      return 0.0;
   return distance / tickSize * tickValue;
  }

// The lot for the chosen risk, rounded down to the lot step; below the minimum the trade is skipped.
string LotText(const string symbol, const double distance)
  {
   const string currency = AccountInfoString(ACCOUNT_CURRENCY);
   const double risk     = AccountSize() * InpRiskPercent / 100.0;
   const double perLot   = LossPerLot(symbol, distance);
   const double step     = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
   const double minLot   = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   const double maxLot   = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   if(risk <= 0.0)
      return "лот: нет размера счёта, впишите его в настройках";
   if(perLot <= 0.0 || step <= 0.0 || minLot <= 0.0)
      return "лот: брокер не дал цену пункта или шаг лота";
   const int lotDigits = step >= 1.0 ? 0 : (step >= 0.1 ? 1 : (step >= 0.01 ? 2 : 3));
   double lots = MathFloor(risk / perLot / step + 1e-9) * step;
   if(maxLot > 0.0 && lots > maxLot)
      lots = maxLot;
   if(lots < minLot - 1e-12)
      return "ПРОПУСТИТЬ: мин. лот " + DoubleToString(minLot, lotDigits) + " рискует " +
             DoubleToString(minLot * perLot, 2) + " " + currency;
   return "лот " + DoubleToString(lots, lotDigits) + SEP + "риск " + DoubleToString(lots * perLot, 2) + " " + currency;
  }

// What is really open on the account in this symbol.
string AccountText(const string symbol)
  {
   double buy = 0.0, sell = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      if(PositionGetSymbol(i) != symbol)
         continue;
      if(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
         buy += PositionGetDouble(POSITION_VOLUME);
      else
         sell += PositionGetDouble(POSITION_VOLUME);
     }
   if(buy <= 0.0 && sell <= 0.0)
      return "счёт: нет позиции";
   string text = "счёт:";
   if(buy > 0.0)
      text += " покупка " + DoubleToString(buy, 2);
   if(sell > 0.0)
      text += " продажа " + DoubleToString(sell, 2);
   return text;
  }

//+------------------------------------------------------------------+
//| The panel                                                        |
//+------------------------------------------------------------------+
void PushLine(const string text, const color tone)
  {
   ArrayResize(g_lines, g_lineCount + 1, 64);
   ArrayResize(g_colors, g_lineCount + 1, 64);
   g_lines[g_lineCount]  = (text == "") ? " " : text;
   g_colors[g_lineCount] = tone;
   g_lineCount++;
  }

// Adds a line, breaking it at a separator when it is longer than a label may be.
void AddLine(const string line, const color tone)
  {
   string text = line;
   while(StringLen(text) > LINE_LIMIT)
     {
      int cut = -1;
      int from = 0;
      while(true)
        {
         const int found = StringFind(text, SEP, from);
         if(found < 0 || found > LINE_LIMIT)
            break;
         cut = found;
         from = found + 1;
        }
      if(cut > 4)
        {
         PushLine(StringSubstr(text, 0, cut), tone);
         text = "    " + StringSubstr(text, cut + StringLen(SEP));
        }
      else
        {
         PushLine(StringSubstr(text, 0, LINE_LIMIT), tone);
         text = "    " + StringSubstr(text, LINE_LIMIT);
        }
     }
   PushLine(text, tone);
  }

void Render()
  {
   int  width = 0;
   int  lineHeight = InpFontSize * 2;
   uint w = 0, h = 0;
   TextSetFont(FONT, -InpFontSize * 10);
   for(int i = 0; i < g_lineCount; i++)
     {
      int lineWidth = (int)(StringLen(g_lines[i]) * InpFontSize * 0.8);
      if(TextGetSize(g_lines[i], w, h) && w > 0)
        {
         lineWidth = (int)w;
         if((int)h + 3 > lineHeight || i == 0)
            lineHeight = (int)h + 3;
        }
      if(lineWidth > width)
         width = lineWidth;
     }
   const int pad = 8;

   const string back = PREFIX + "panel";
   if(ObjectFind(0, back) < 0)
     {
      ObjectCreate(0, back, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, back, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, back, OBJPROP_BGCOLOR, COLOR_PANEL);
      ObjectSetInteger(0, back, OBJPROP_BORDER_TYPE, BORDER_FLAT);
      ObjectSetInteger(0, back, OBJPROP_COLOR, clrDimGray);
      ObjectSetInteger(0, back, OBJPROP_BACK, false);
      ObjectSetInteger(0, back, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, back, OBJPROP_HIDDEN, true);
     }
   ObjectSetInteger(0, back, OBJPROP_XDISTANCE, InpX);
   ObjectSetInteger(0, back, OBJPROP_YDISTANCE, InpY);
   ObjectSetInteger(0, back, OBJPROP_XSIZE, width + 2 * pad);
   ObjectSetInteger(0, back, OBJPROP_YSIZE, g_lineCount * lineHeight + 2 * pad);

   for(int i = 0; i < g_lineCount; i++)
     {
      const string name = PREFIX + "line" + IntegerToString(i, 3, '0');
      if(ObjectFind(0, name) < 0)
        {
         ObjectCreate(0, name, OBJ_LABEL, 0, 0, 0);
         ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
         ObjectSetInteger(0, name, OBJPROP_ANCHOR, ANCHOR_LEFT_UPPER);
         ObjectSetString(0, name, OBJPROP_FONT, FONT);
         ObjectSetInteger(0, name, OBJPROP_FONTSIZE, InpFontSize);
         ObjectSetInteger(0, name, OBJPROP_BACK, false);
         ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
         ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
        }
      ObjectSetInteger(0, name, OBJPROP_XDISTANCE, InpX + pad);
      ObjectSetInteger(0, name, OBJPROP_YDISTANCE, InpY + pad + i * lineHeight);
      ObjectSetInteger(0, name, OBJPROP_COLOR, g_colors[i]);
      ObjectSetString(0, name, OBJPROP_TEXT, g_lines[i]);
     }
   for(int i = g_lineCount; i < g_shownLines; i++)
      ObjectDelete(0, PREFIX + "line" + IntegerToString(i, 3, '0'));
   g_shownLines = g_lineCount;
   ChartRedraw(0);
  }

//+------------------------------------------------------------------+
//| Marks of the rule's trades on the chart of an index              |
//+------------------------------------------------------------------+
void Mark(const string name, const ENUM_OBJECT type, const datetime time, const double price,
          const color tone, const string tip)
  {
   ObjectCreate(0, name, type, 0, time, price);
   ObjectSetInteger(0, name, OBJPROP_COLOR, tone);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
   ObjectSetString(0, name, OBJPROP_TOOLTIP, tip);
  }

void Segment(const string name, const datetime fromTime, const double fromPrice, const datetime toTime,
             const double toPrice, const color tone, const ENUM_LINE_STYLE style, const string tip)
  {
   ObjectCreate(0, name, OBJ_TREND, 0, fromTime, fromPrice, toTime, toPrice);
   ObjectSetInteger(0, name, OBJPROP_COLOR, tone);
   ObjectSetInteger(0, name, OBJPROP_STYLE, style);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, name, OBJPROP_RAY_LEFT, false);
   ObjectSetInteger(0, name, OBJPROP_RAY_RIGHT, false);
   ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
   ObjectSetInteger(0, name, OBJPROP_HIDDEN, true);
   ObjectSetString(0, name, OBJPROP_TOOLTIP, tip);
  }

void DrawHistory(const RuleTrade &trades[], const RuleResult &said, const datetime lastBar, const int digits)
  {
   const int total = ArraySize(trades);
   const string key = IntegerToString(total) + "/" + IntegerToString((long)lastBar) + "/" +
                      IntegerToString(said.state) + "/" + IntegerToString((long)said.entryTime);
   if(key == g_drawnKey)
      return;
   g_drawnKey = key;
   ObjectsDeleteAll(0, PREFIX + "mark");
   const int first = MathMax(0, total - InpHistoryTrades);
   for(int i = first; i < total; i++)
     {
      const string id   = PREFIX + "mark" + IntegerToString(i);
      const bool   buy  = trades[i].direction > 0;
      const color  tone = trades[i].r > 0.0 ? clrLimeGreen : clrTomato;
      const string tip  = StringFormat("%s %s - %s: %+.2f R%s", buy ? "Покупка" : "Продажа",
                                       DateText(trades[i].entryTime), DateText(trades[i].exitTime),
                                       trades[i].r, trades[i].byStop ? " (стоп)" : "");
      Mark(id + "in", buy ? OBJ_ARROW_BUY : OBJ_ARROW_SELL, trades[i].entryTime, trades[i].entryPrice,
           buy ? clrDodgerBlue : clrOrangeRed, tip);
      Mark(id + "out", trades[i].byStop ? OBJ_ARROW_STOP : OBJ_ARROW_CHECK, trades[i].exitTime,
           trades[i].exitPrice, tone, tip);
      Segment(id + "line", trades[i].entryTime, trades[i].entryPrice, trades[i].exitTime, trades[i].exitPrice,
              tone, STYLE_DOT, tip);
     }
   if(said.state == STATE_OPEN || said.state == STATE_EXIT)
     {
      const bool   buy = said.direction > 0;
      const string tip = (buy ? "Покупка" : "Продажа") + " по правилу с " + DateText(said.entryTime) +
                         ", стоп " + DoubleToString(said.stopLoss, digits);
      Mark(PREFIX + "mark_now_in", buy ? OBJ_ARROW_BUY : OBJ_ARROW_SELL, said.entryTime, said.entryPrice,
           buy ? clrDodgerBlue : clrOrangeRed, tip);
      Segment(PREFIX + "mark_now_stop", said.entryTime, said.stopLoss, lastBar, said.stopLoss,
              clrTomato, STYLE_DASH, tip);
     }
  }

//+------------------------------------------------------------------+
//| The file for the check against the backtest engine               |
//+------------------------------------------------------------------+
string StateName(const int state)
  {
   switch(state)
     {
      case STATE_ENTER: return "enter";
      case STATE_OPEN:  return "open";
      case STATE_EXIT:  return "exit";
      default:          return "flat";
     }
  }

// The symbol with everything but Latin letters and digits replaced: safe in a file name.
string PlainName(const string symbol)
  {
   string name = "";
   const int length = StringLen(symbol);
   for(int i = 0; i < length; i++)
     {
      const ushort letter = StringGetCharacter(symbol, i);
      const bool   plain  = (letter >= '0' && letter <= '9') || (letter >= 'A' && letter <= 'Z') ||
                            (letter >= 'a' && letter <= 'z');
      name += plain ? ShortToString(letter) : "_";
     }
   return name;
  }

string FileNameOf(const string symbol)
  {
   return "algotred_rsi2_" + PlainName(symbol) + ".csv";
  }

//+------------------------------------------------------------------+
//| The feed for the project's "Signals" page                        |
//+------------------------------------------------------------------+
string JsonText(const string value)
  {
   string text = value;
   StringReplace(text, "\\", "\\\\");
   StringReplace(text, "\"", "\\\"");
   return "\"" + text + "\"";
  }

// The daily bars in the format of MT5's own export, the day still trading as the last row.
// Written under another name and moved into place, so the page never reads half a file.
bool WriteFeedBars(const string symbol, const MqlRates &bars[], const int copied, const int digits)
  {
   const string name = FEED_FOLDER + "\\" + PlainName(symbol) + "_D1.csv";
   const string temp = name + ".tmp";
   const int handle = FileOpen(temp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(handle == INVALID_HANDLE)
     {
      PrintFormat("Rsi2IndexSignal: cannot open %s, error %d", temp, GetLastError());
      return false;
     }
   FileWriteString(handle, "<DATE>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\r\n");
   for(int i = 0; i < copied; i++)
      FileWriteString(handle, TimeToString(bars[i].time, TIME_DATE) + "\t" +
                      DoubleToString(bars[i].open, digits) + "\t" +
                      DoubleToString(bars[i].high, digits) + "\t" +
                      DoubleToString(bars[i].low, digits) + "\t" +
                      DoubleToString(bars[i].close, digits) + "\t" +
                      IntegerToString(bars[i].tick_volume) + "\t" +
                      IntegerToString(bars[i].real_volume) + "\t" +
                      IntegerToString(bars[i].spread) + "\r\n");
   FileClose(handle);
   return FileMove(temp, FILE_COMMON, name, FILE_COMMON | FILE_REWRITE);
  }

// One index for feed.json: its file and the broker's contract facts.
void AddFeedSymbol(const string symbol, const string title, const int digits, const bool dayOpen)
  {
   double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tickValue <= 0.0)
      tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   const double tickSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickSize <= 0.0)
      return;
   if(g_feedSymbols != "")
      g_feedSymbols += ",";
   g_feedSymbols += "{\"symbol\":" + JsonText(symbol) +
                    ",\"title\":" + JsonText(title) +
                    ",\"file\":" + JsonText(PlainName(symbol) + "_D1.csv") +
                    ",\"digits\":" + IntegerToString(digits) +
                    ",\"tickSize\":" + DoubleToString(tickSize, 8) +
                    ",\"tickValue\":" + DoubleToString(MathMax(tickValue, 0.0), 8) +
                    ",\"lotMin\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN), 4) +
                    ",\"lotStep\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP), 4) +
                    ",\"lotMax\":" + DoubleToString(SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX), 4) +
                    ",\"dayOpen\":" + (dayOpen ? "true" : "false") + "}";
  }

void WriteFeedMeta()
  {
   const string name = FEED_FOLDER + "\\feed.json";
   const string temp = name + ".tmp";
   const int handle = FileOpen(temp, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON, '\t', CP_UTF8);
   if(handle == INVALID_HANDLE)
     {
      PrintFormat("Rsi2IndexSignal: cannot open %s, error %d", temp, GetLastError());
      return;
     }
   FileWriteString(handle, "{\"version\":1" +
                   ",\"serverTime\":" + JsonText(TimeToString(TimeTradeServer(), TIME_DATE | TIME_SECONDS)) +
                   ",\"server\":" + JsonText(AccountInfoString(ACCOUNT_SERVER)) +
                   ",\"currency\":" + JsonText(AccountInfoString(ACCOUNT_CURRENCY)) +
                   ",\"balance\":" + DoubleToString(MathMax(AccountSize(), 0.0), 2) +
                   ",\"symbols\":[" + g_feedSymbols + "]}\r\n");
   FileClose(handle);
   FileMove(temp, FILE_COMMON, name, FILE_COMMON | FILE_REWRITE);
  }

void ExportTrades(const string symbol, const MqlRates &bars[], const int closedCount, const int digits,
                  const RuleResult &said, const RuleTrade &trades[])
  {
   const string file = FileNameOf(symbol);
   const int handle = FileOpen(file, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(handle == INVALID_HANDLE)
     {
      PrintFormat("Rsi2IndexSignal: cannot open %s, error %d", file, GetLastError());
      return;
     }
   FileWriteString(handle, "#symbol\t" + symbol + "\tdigits\t" + IntegerToString(digits) +
                   "\tbars\t" + IntegerToString(closedCount) +
                   "\tfirst\t" + TimeToString(bars[0].time, TIME_DATE) +
                   "\tlast\t" + TimeToString(bars[closedCount - 1].time, TIME_DATE) +
                   "\tstate\t" + StateName(said.state) + "\r\n");
   FileWriteString(handle, "direction\tsignal\tentry\tentry_price\tstop\texit\texit_price\treason\tr\r\n");
   const int total = ArraySize(trades);
   for(int i = 0; i < total; i++)
      FileWriteString(handle, (trades[i].direction > 0 ? "BUY" : "SELL") + "\t" +
                      TimeToString(trades[i].signalTime, TIME_DATE) + "\t" +
                      TimeToString(trades[i].entryTime, TIME_DATE) + "\t" +
                      DoubleToString(trades[i].entryPrice, digits) + "\t" +
                      DoubleToString(trades[i].stopLoss, digits) + "\t" +
                      TimeToString(trades[i].exitTime, TIME_DATE) + "\t" +
                      DoubleToString(trades[i].exitPrice, digits) + "\t" +
                      (trades[i].byStop ? "stop" : "strategy") + "\t" +
                      DoubleToString(trades[i].r, 6) + "\r\n");
   FileClose(handle);
  }

//+------------------------------------------------------------------+
//| A message once for every day with something to do                |
//+------------------------------------------------------------------+
void Notify(const string symbol, const RuleResult &said, const datetime asOf)
  {
   if(!InpAlert && !InpPush)
      return;
   if(said.state != STATE_ENTER && said.state != STATE_EXIT)
      return;
   const string key = PREFIX + "day_" + symbol;
   if(GlobalVariableCheck(key) && (datetime)(long)GlobalVariableGet(key) == asOf)
      return;
   GlobalVariableSet(key, (double)(long)asOf);
   string text = "Rsi2ReversionIndexD1, " + symbol + ": ";
   if(said.state == STATE_ENTER)
      text += (said.direction > 0 ? "сигнал КУПИТЬ" : "сигнал ПРОДАТЬ");
   else
      text += "сигнал ВЫЙТИ из позиции";
   text += " утром после свечи " + DateText(asOf) + ", " + ORDER_HOUR;
   if(InpAlert)
      Alert(text);
   if(InpPush)
      SendNotification(text);
  }

//+------------------------------------------------------------------+
//| One index: its lines on the panel                                |
//+------------------------------------------------------------------+
void DescribeSymbol(const int index)
  {
   const string symbol = g_symbols[index];
   const string head   = g_titles[index] == "" ? symbol : symbol + " (" + g_titles[index] + ")";
   if(!g_exists[index])
     {
      AddLine(head + SEP + "у этого брокера такого инструмента нет", COLOR_DIM);
      return;
     }
   MqlRates bars[];
   ResetLastError();
   const int copied = CopyRates(symbol, PERIOD_D1, 0, MAX_BARS, bars);
   if(copied <= 0)
     {
      AddLine(head + SEP + "дневная история загружается", COLOR_DIM);
      return;
     }
   if(copied < MIN_BARS)
     {
      AddLine(head + SEP + "мало истории: дневных свечей " + IntegerToString(copied), COLOR_DIM);
      AddLine("  правилу нужно больше " + IntegerToString(MIN_BARS), COLOR_DIM);
      return;
     }
   const int      digits  = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   const datetime now     = TimeTradeServer();
   // the last bar is the day still trading until the server's next midnight
   const bool     dayOpen = now < bars[copied - 1].time + DAY_SECONDS;
   const int      closedCount = dayOpen ? copied - 1 : copied;
   const datetime asOf    = bars[closedCount - 1].time;

   RuleResult said;
   RuleTrade  trades[];
   Replay(bars, closedCount, digits, said, trades);

   if(g_feedDue && WriteFeedBars(symbol, bars, copied, digits))
      AddFeedSymbol(symbol, g_titles[index], digits, dayOpen);

   const double todayOpen  = bars[copied - 1].open;
   const double todayHigh  = bars[copied - 1].high;
   const double todayLow   = bars[copied - 1].low;
   const double todayPrice = bars[copied - 1].close;

   AddLine(head + SEP + "свеча " + DateText(asOf) + SEP + AccountText(symbol), COLOR_HEAD);

   const bool   buy      = said.direction > 0;
   const string position = buy ? "покупка" : "продажа";
   const string toClose  = buy ? "покупку" : "продажу";
   if(said.state == STATE_ENTER)
     {
      const color tone = buy ? COLOR_BUY : COLOR_SELL;
      if(dayOpen)
        {
         // The order is placed by hand in the morning (TZ 17.49): the stop is the
         // signal's distance from the fill, not from the open of the day.
         const double stop = NormalizeDouble(todayPrice - said.direction * said.stopDistance, digits);
         AddLine("  ВХОД СЕГОДНЯ: " + (buy ? "КУПИТЬ" : "ПРОДАТЬ") + " по рынку, " + ORDER_HOUR, tone);
         AddLine("  открытие дня " + DoubleToString(todayOpen, digits) + SEP + "сейчас " +
                 DoubleToString(todayPrice, digits), COLOR_TEXT);
         AddLine("  стоп на " + DoubleToString(said.stopDistance, digits) + (buy ? " ниже" : " выше") +
                 " цены входа" + SEP + "сейчас это " + DoubleToString(stop, digits), COLOR_TEXT);
         AddLine("  " + LotText(symbol, said.stopDistance), COLOR_TEXT);
        }
      else
        {
         AddLine("  СИГНАЛ: " + (buy ? "КУПИТЬ" : "ПРОДАТЬ") + " в следующий день, " + ORDER_HOUR, tone);
         AddLine("  стоп на " + DoubleToString(said.stopDistance, digits) + (buy ? " ниже" : " выше") +
                 " цены входа (2 x ATR)", COLOR_TEXT);
         AddLine("  " + LotText(symbol, said.stopDistance), COLOR_TEXT);
        }
     }
   else if(said.state == STATE_OPEN)
     {
      AddLine("  ПОЗИЦИЯ ПО ПРАВИЛУ: " + position + " с " + DateText(said.entryTime) + " по " +
              DoubleToString(said.entryPrice, digits), COLOR_HOLD);
      AddLine("  стоп на " + DoubleToString(MathAbs(said.entryPrice - said.stopLoss), digits) +
              (buy ? " ниже" : " выше") + " вашей цены входа" + SEP + "выход: день закроется " +
              (buy ? "выше" : "ниже") + " SMA(5)", COLOR_TEXT);
      if(dayOpen && (buy ? todayLow <= said.stopLoss : todayHigh >= said.stopLoss))
         AddLine("  от открытия дня входа стоп сегодня задет: проверьте сделку", COLOR_NOTE);
     }
   else if(said.state == STATE_EXIT)
     {
      if(dayOpen)
         AddLine("  ВЫХОД СЕГОДНЯ: закрыть " + toClose + " по рынку, " + ORDER_HOUR, COLOR_EXIT);
      else
         AddLine("  ВЫХОД: закрыть " + toClose + " в следующий день, " + ORDER_HOUR, COLOR_EXIT);
      AddLine("  вход был " + DateText(said.entryTime) + " по " + DoubleToString(said.entryPrice, digits) +
              SEP + "стоп " + DoubleToString(said.stopLoss, digits), COLOR_TEXT);
     }
   else if(!said.ready)
      AddLine("  индикаторы ещё не посчитаны", COLOR_DIM);
   else if(said.close > said.trendSma)
      AddLine("  сигнала нет: для покупки нужен RSI(2) ниже 5", COLOR_DIM);
   else
      AddLine("  сигнала нет: для продажи нужен RSI(2) выше 95", COLOR_DIM);

   if(said.state == STATE_OPEN || said.state == STATE_EXIT)
      AddLine("  закрытие " + DoubleToString(said.close, digits) + SEP + "SMA(5) " +
              DoubleToString(said.exitSma, digits) + SEP + "RSI(2) " + DoubleToString(said.rsi, 1), COLOR_TEXT);
   else
      AddLine("  RSI(2) " + DoubleToString(said.rsi, 1) + SEP + "закрытие " + DoubleToString(said.close, digits) +
              SEP + "SMA(200) " + DoubleToString(said.trendSma, digits), COLOR_TEXT);

   // what tomorrow would bring if the day closed at the current price
   if(dayOpen)
     {
      RuleResult maybe;
      RuleTrade  unused[];
      Replay(bars, copied, digits, maybe, unused);
      string next = "сигнала нет";
      color  tone = COLOR_DIM;
      if(maybe.state == STATE_ENTER)
        {
         next = maybe.direction > 0 ? "ВХОД, покупка" : "ВХОД, продажа";
         tone = COLOR_NOTE;
        }
      else if(maybe.state == STATE_EXIT)
        {
         next = "ВЫХОД";
         tone = COLOR_NOTE;
        }
      else if(maybe.state == STATE_OPEN)
         next = "держать позицию";
      AddLine("  если день закроется по " + DoubleToString(todayPrice, digits) + ": завтра " + next, tone);
     }

   Notify(symbol, said, asOf);
   if(InpShowHistory && symbol == _Symbol)
      DrawHistory(trades, said, bars[copied - 1].time, digits);
   if(InpExport && g_exported[index] != asOf)
     {
      ExportTrades(symbol, bars, closedCount, digits, said, trades);
      g_exported[index] = asOf;
     }
  }

void Refresh()
  {
   g_lineCount = 0;
   AddLine("Rsi2ReversionIndexD1" + SEP + "правило по дневным свечам индексов США", COLOR_HEAD);
   const double size = AccountSize();
   if(size > 0.0)
      AddLine("счёт " + DoubleToString(size, 2) + " " + AccountInfoString(ACCOUNT_CURRENCY) + SEP + "риск " +
              DoubleToString(InpRiskPercent, 2) + "% = " + DoubleToString(size * InpRiskPercent / 100.0, 2) +
              SEP + "сервер " + TimeToString(TimeTradeServer(), TIME_MINUTES), COLOR_TEXT);
   else
      AddLine("счёт не подключён: впишите размер счёта в настройках", COLOR_NOTE);
   const int total = ArraySize(g_symbols);
   if(total == 0)
     {
      AddLine(" ", COLOR_DIM);
      AddLine("Индексы не найдены по известным именам.", COLOR_NOTE);
      AddLine("Впишите их имена через запятую в настройке «Индексы».", COLOR_NOTE);
     }
   g_feedDue     = InpFeed && (TimeLocal() - g_feedWritten >= FEED_SECONDS);
   g_feedSymbols = "";
   for(int i = 0; i < total; i++)
     {
      AddLine(" ", COLOR_DIM);
      DescribeSymbol(i);
     }
   if(g_feedDue)
     {
      WriteFeedMeta();
      g_feedWritten = TimeLocal();
     }
   AddLine(" ", COLOR_DIM);
   AddLine("Программа сделок не открывает и не закрывает.", COLOR_DIM);
   Render();
  }

//+------------------------------------------------------------------+
//| Events                                                           |
//+------------------------------------------------------------------+
int OnInit()
  {
   IndicatorSetString(INDICATOR_SHORTNAME, "Rsi2IndexSignal");
   BuildSymbolList();
   EventSetTimer(REFRESH_SECONDS);
   Refresh();
   return INIT_SUCCEEDED;
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   ObjectsDeleteAll(0, PREFIX);
   ChartRedraw(0);
  }

void OnTimer()
  {
   Refresh();
  }

int OnCalculate(const int rates_total, const int prev_calculated, const datetime &time[],
                const double &open[], const double &high[], const double &low[], const double &close[],
                const long &tick_volume[], const long &volume[], const int &spread[])
  {
   return rates_total;
  }
//+------------------------------------------------------------------+
