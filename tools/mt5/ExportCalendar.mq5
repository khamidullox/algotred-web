//+------------------------------------------------------------------+
//| ExportCalendar.mq5                                               |
//| Exports the history of the MetaTrader 5 economic calendar to a   |
//| tab-separated UTF-16 file in the common Files folder, the way    |
//| MT5 exports bars, for the algotred backtest project.             |
//| <DATE> <TIME> are as the terminal gives them: the server's       |
//| offset from UTC at the moment of export, applied to the whole    |
//| history (checked 2026-11-19: summer events came out an hour      |
//| early). <UTC> undoes that offset and is the time to rely on.     |
//| Reads only: it opens no orders and changes no settings.          |
//+------------------------------------------------------------------+
#property copyright   "algotred"
#property version     "1.01"
#property description "Economic calendar history -> Common\\Files\\algotred_calendar.csv"
#property script_show_inputs

input datetime InpFrom = D'2014.01.01 00:00';        // From (server time)
input datetime InpTo   = 0;                          // To (0 = now + 7 days)
input string   InpFile = "algotred_calendar.csv";    // File in Common\Files

string ImportanceName(const ENUM_CALENDAR_EVENT_IMPORTANCE value)
  {
   switch(value)
     {
      case CALENDAR_IMPORTANCE_LOW:      return "LOW";
      case CALENDAR_IMPORTANCE_MODERATE: return "MODERATE";
      case CALENDAR_IMPORTANCE_HIGH:     return "HIGH";
      default:                           return "NONE";
     }
  }

string TypeName(const ENUM_CALENDAR_EVENT_TYPE value)
  {
   switch(value)
     {
      case CALENDAR_TYPE_EVENT:     return "EVENT";
      case CALENDAR_TYPE_INDICATOR: return "INDICATOR";
      case CALENDAR_TYPE_HOLIDAY:   return "HOLIDAY";
      default:                      return "OTHER";
     }
  }

string TimeModeName(const ENUM_CALENDAR_EVENT_TIMEMODE value)
  {
   switch(value)
     {
      case CALENDAR_TIMEMODE_DATETIME:  return "DATETIME";
      case CALENDAR_TIMEMODE_DATE:      return "DATE";
      case CALENDAR_TIMEMODE_NOTIME:    return "NOTIME";
      case CALENDAR_TIMEMODE_TENTATIVE: return "TENTATIVE";
      default:                          return "OTHER";
     }
  }

// Calendar values are integers scaled by 10^6; LONG_MIN means "no value".
string Value(const long raw, const int digits)
  {
   if(raw == LONG_MIN)
      return "";
   return DoubleToString((double)raw / 1000000.0, digits);
  }

string Clean(string text)
  {
   StringReplace(text, "\t", " ");
   StringReplace(text, "\r", " ");
   StringReplace(text, "\n", " ");
   return text;
  }

// First day of the month after `time`, 00:00.
datetime NextMonth(const datetime time)
  {
   MqlDateTime parts;
   TimeToStruct(time, parts);
   parts.mon++;
   if(parts.mon > 12)
     {
      parts.mon = 1;
      parts.year++;
     }
   parts.day  = 1;
   parts.hour = 0;
   parts.min  = 0;
   parts.sec  = 0;
   return StructToTime(parts);
  }

void OnStart()
  {
   const datetime to = (InpTo == 0) ? TimeTradeServer() + 7 * 86400 : InpTo;
   // The terminal shifts calendar times by the server's current offset from
   // UTC; rounded here to whole half hours.
   const long offset = (long)MathRound((double)(TimeTradeServer() - TimeGMT()) / 1800.0) * 1800;
   const int handle = FileOpen(InpFile, FILE_WRITE | FILE_TXT | FILE_UNICODE | FILE_COMMON);
   if(handle == INVALID_HANDLE)
     {
      PrintFormat("Cannot open %s: error %d", InpFile, GetLastError());
      return;
     }
   FileWriteString(handle,
                   "<DATE>\t<TIME>\t<UTC>\t<VALUE_ID>\t<EVENT_ID>\t<EVENT_CODE>\t<NAME>\t<COUNTRY>\t<CURRENCY>\t"
                   "<IMPORTANCE>\t<TYPE>\t<TIMEMODE>\t<UNIT>\t<MULTIPLIER>\t<ACTUAL>\t<FORECAST>\t<PREVIOUS>\t"
                   "<REVISED_PREVIOUS>\t<IMPACT>\t<PERIOD>\t<REVISION>\r\n");

   long     total = 0;
   datetime first = 0;
   datetime last  = 0;
   MqlCalendarValue values[];
   // Month by month: a whole decade in one call can be too large.
   for(datetime from = InpFrom; from < to;)
     {
      datetime next = NextMonth(from);
      if(next > to)
         next = to;
      ResetLastError();
      const int count = CalendarValueHistory(values, from, next);
      if(count < 0)
         PrintFormat("CalendarValueHistory %s: error %d", TimeToString(from, TIME_DATE), GetLastError());
      for(int i = 0; i < count; i++)
        {
         MqlCalendarEvent   event;
         MqlCalendarCountry country;
         if(!CalendarEventById(values[i].event_id, event))
            continue;
         if(!CalendarCountryById(event.country_id, country))
            continue;
         const int digits = (int)event.digits;
         string line = TimeToString(values[i].time, TIME_DATE) + "\t" +
                       TimeToString(values[i].time, TIME_MINUTES) + "\t" +
                       TimeToString(values[i].time - (datetime)offset, TIME_DATE | TIME_MINUTES) + "\t" +
                       IntegerToString((long)values[i].id) + "\t" +
                       IntegerToString((long)values[i].event_id) + "\t" +
                       Clean(event.event_code) + "\t" +
                       Clean(event.name) + "\t" +
                       country.code + "\t" +
                       country.currency + "\t" +
                       ImportanceName(event.importance) + "\t" +
                       TypeName(event.type) + "\t" +
                       TimeModeName(event.time_mode) + "\t" +
                       IntegerToString((int)event.unit) + "\t" +
                       IntegerToString((int)event.multiplier) + "\t" +
                       Value(values[i].actual_value, digits) + "\t" +
                       Value(values[i].forecast_value, digits) + "\t" +
                       Value(values[i].prev_value, digits) + "\t" +
                       Value(values[i].revised_prev_value, digits) + "\t" +
                       IntegerToString((int)values[i].impact_type) + "\t" +
                       TimeToString(values[i].period, TIME_DATE) + "\t" +
                       IntegerToString(values[i].revision) + "\r\n";
         FileWriteString(handle, line);
         if(first == 0 || values[i].time < first)
            first = values[i].time;
         if(values[i].time > last)
            last = values[i].time;
         total++;
        }
      from = next;
     }
   FileClose(handle);
   PrintFormat("algotred calendar: %I64d records from %s to %s, server offset %+.1f h -> Common\\Files\\%s",
               total, TimeToString(first), TimeToString(last), (double)offset / 3600.0, InpFile);
  }
//+------------------------------------------------------------------+
