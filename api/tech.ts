import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

// GET /api/tech?symbol=AAPL
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol) return jsonResponse({ ok: false, error: "Provide ?symbol=XXX" }, 400);

  const supabase = getAnonClient();

  const { data: rows, error } = await supabase
    .from("daily_agg")
    .select("date, close, volume, rsi, macd, macd_signal, sma50, sma200, atr")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(1);

  if (error) return jsonResponse({ ok: false, stage: "select", error: error.message }, 500);

  const row = rows?.[0];
  if (!row) {
    return jsonResponse({ ok: true, symbol, computed: false, note: "No daily_agg row found yet" });
  }

  let crossover: "bullish" | "bearish" | "none" = "none";
  if (row.sma50 != null && row.sma200 != null) {
    if (row.sma50 > row.sma200) crossover = "bullish";
    else if (row.sma50 < row.sma200) crossover = "bearish";
  }

  return jsonResponse({
    ok: true,
    symbol,
    computed: true,
    rsi: row.rsi ?? null,
    macd: { value: row.macd ?? null, signal: row.macd_signal ?? null },
    sma50: row.sma50 ?? null,
    sma200: row.sma200 ?? null,
    crossover,
    atr: row.atr ?? null
  });
}
