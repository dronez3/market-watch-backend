import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

// GET /api/assess?symbol=AAPL&hours=72&horizon_days=5
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const hours = Number(url.searchParams.get("hours") || 72);
  const horizonDays = Number(url.searchParams.get("horizon_days") || 5);
  if (!symbol) return jsonResponse({ ok: false, error: "Missing ?symbol=XXX" }, 400);

  const supabase = getAnonClient();

  const { data: latestArr, error: daErr } = await supabase
    .from("daily_agg")
    .select("date, close, rsi, sma50, sma200, atr")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(1);
  if (daErr) return jsonResponse({ ok: false, stage: "daily_agg_latest", error: daErr.message }, 500);
  const latest: any = latestArr?.[0] || null;

  const { data: last7, error: mErr } = await supabase
    .from("daily_agg")
    .select("date, close")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(7);
  if (mErr) return jsonResponse({ ok: false, stage: "daily_agg_7", error: mErr.message }, 500);

  let pctChange7: number | null = null;
  if (last7 && last7.length >= 2) {
    const newest = Number(last7[0]?.close ?? NaN);
    const oldest = Number(last7[last7.length - 1]?.close ?? NaN);
    if (isFinite(newest) && isFinite(oldest) && oldest !== 0) {
      pctChange7 = (newest - oldest) / oldest;
    }
  }

  const { data: last30, error: aErr } = await supabase
    .from("daily_agg")
    .select("atr, close")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(30);
  if (aErr) return jsonResponse({ ok: false, stage: "daily_agg_30", error: aErr.message }, 500);

  let atrNow: number | null = latest?.atr ?? null;
  let atrAvg30: number |
