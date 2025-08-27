import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Rolls up intraday 'prices' rows into 'daily_agg' for the last N days.
 * Computes: close, volume, SMA50, SMA200, RSI(14), ATR(14). (MACD fields left null.)
 * Usage:
 * /api/daily_agg_backfill_link?token=TOKEN&symbol=AAPL&days=220
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const days = Math.max(1, Number(url.searchParams.get("days") || 220));
  if (!symbol) return jsonResponse({ ok: false, error: "Missing symbol" }, 400);

  const supabase = getServiceClient();
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  // Pull intraday bars for period (ascending)
  const { data: bars, error: selErr } = await supabase
    .from("prices")
    .select("ts, high, low, close, volume")
    .eq("symbol", symbol)
    .gte("ts", since)
    .order("ts", { ascending: true });

  if (selErr) return jsonResponse({ ok: false, stage: "select", error: selErr.message }, 500);
  if (!bars || bars.length === 0) return jsonResponse({ ok: true, symbol, upserted: 0, note: "No price rows in range" });

  // Group by UTC date
  type DayRow = { date: string; high: number; low: number; close: number; volume: number };
  const dayMap = new Map<string, DayRow>();
  for (const b of bars) {
    const d = new Date(b.ts).toISOString().slice(0, 10); // YYYY-MM-DD
    const r = dayMap.get(d);
    const high = Number(b.high ?? 0);
    const low = Number(b.low ?? 0);
    const close = Number(b.close ?? 0);
    const volume = Number(b.volume ?? 0);
    if (!r) {
      dayMap.set(d, { date: d, high, low, close, volume });
    } else {
      r.high = Math.max(r.high, high);
      r.low = r.low === 0 ? low : Math.min(r.low, low);
      r.close = close; // last close of the day (bars are ascending)
      r.volume += volume;
    }
  }
  const daysArr = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Helpers
  const sma = (vals: number[], win: number, idx: number) => {
    if (idx + 1 < win) return null;
    let s = 0;
    for (let i = idx - win + 1; i <= idx; i++) s += vals[i];
    return s / win;
  };
  const rsi14 = (closes: number[], idx: number) => {
    if (idx < 14) return null;
    let gains = 0, losses = 0;
    for (let i = idx - 14 + 1; i <= idx; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  };
  const atr14 = (highs: number[], lows: number[], closes: number[], idx: number) => {
    if (idx < 14) return null;
    const trs: number[] = [];
    for (let i = idx - 14 + 1; i <= idx; i++) {
      const prevClose = closes[i - 1] ?? closes[i];
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - prevClose),
        Math.abs(lows[i] - prevClose)
      );
      trs.push(tr);
    }
    const sum = trs.reduce((a, b) => a + b, 0);
    return sum / trs.length;
  };

  // Build arrays for indicators
  const closes = daysArr.map(d => d.close);
  const highs = daysArr.map(d => d.high);
  const lows = daysArr.map(d => d.low);

  // Build rows for upsert
  const upsertRows = daysArr.map((d, i) => ({
    symbol,
    date: d.date,
    close: d.close,
    volume: d.volume,
    rsi: rsi14(closes, i),
    macd: null as number | null,
    macd_signal: null as number | null,
    sma50: sma(closes, 50, i),
    sma200: sma(closes, 200, i),
    atr: atr14(highs, lows, closes, i)
  }));

  try {
    const { data, error } = await supabase.from("daily_agg").upsert(upsertRows, { onConflict: "symbol,date" }).select("symbol,date");
    if (error) return jsonResponse({ ok: false, stage: "upsert", error: error.message }, 500);
    const last = upsertRows[upsertRows.length - 1];
    return jsonResponse({
      ok: true,
      symbol,
      days_processed: daysArr.length,
      upserted: data?.length ?? upsertRows.length,
      latest_sample: last
    });
  } catch (e: any) {
    return jsonResponse({ ok: false, stage: "exception", error: String(e?.message || e) }, 500);
  }
}
