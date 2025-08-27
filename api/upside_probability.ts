import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Improved probability model (still lightweight & explainable):
 * Base: 0.50
 * RSI tilt: ±0.10  (oversold <30 = +; overbought >70 = -)
 * Trend tilt (SMA50 vs SMA200): ±0.07
 * Sentiment tilt (latest within 72h): clamp(score * 0.30, -0.08, +0.08)
 * 7-bar momentum tilt (from daily_agg): clamp(pct_change_7 * 0.50, -0.06, +0.06)
 * Final clamp to [0.05, 0.95]
 *
 * GET params:
 *   ?symbol=TSLA&horizon_days=5
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const horizonDays = Number(url.searchParams.get("horizon_days") || 5);
  if (!symbol) return jsonResponse({ ok: false, error: "Provide ?symbol=XXX" }, 400);

  const supabase = getAnonClient();
  const rationale: string[] = [];
  let p = 0.5;

  // 1) Latest technicals row
  const { data: da, error: daErr } = await supabase
    .from("daily_agg")
    .select("date, close, rsi, sma50, sma200")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(1);
  if (daErr) return jsonResponse({ ok: false, stage: "daily_agg_latest", error: daErr.message }, 500);
  const latest = da?.[0];

  // 2) 7-bar momentum (from daily_agg)
  const { data: last7, error: mErr } = await supabase
    .from("daily_agg")
    .select("date, close")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(7);
  if (mErr) return jsonResponse({ ok: false, stage: "daily_agg_7", error: mErr.message }, 500);

  let pctChange7: number | null = null;
  if (last7 && last7.length >= 2) {
    const newest = last7[0]?.close as number | null;
    const oldest = last7[last7.length - 1]?.close as number
