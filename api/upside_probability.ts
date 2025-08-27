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
    const oldest = last7[last7.length - 1]?.close as number | null;
    if (newest != null && oldest != null && oldest !== 0) {
      pctChange7 = (newest - oldest) / oldest; // e.g., 0.043 = +4.3%
    }
  }

  // 3) Latest sentiment within ~72h
  const now = new Date();
  const start = new Date(now.getTime() - 72 * 3600 * 1000).toISOString();
  const end = now.toISOString();
  const { data: ss, error: sErr } = await supabase
    .from("sentiment_scores")
    .select("score, window_end")
    .eq("symbol", symbol)
    .gte("window_start", start)
    .lte("window_end", end)
    .order("window_end", { ascending: false })
    .limit(1);
  if (sErr) return jsonResponse({ ok: false, stage: "sentiment", error: sErr.message }, 500);
  const sentiment = (ss?.[0]?.score as number | undefined) ?? null;

  // --- Combine signals into probability ---

  // RSI tilt
  if (latest?.rsi != null) {
    if (latest.rsi < 30) { p += 0.10; rationale.push("RSI oversold (<30)"); }
    else if (latest.rsi > 70) { p -= 0.10; rationale.push("RSI overbought (>70)"); }
    else { rationale.push("RSI neutral"); }
  } else {
    rationale.push("RSI missing");
  }

  // Trend tilt (SMA50 vs SMA200)
  if (latest?.sma50 != null && latest?.sma200 != null) {
    if (latest.sma50 > latest.sma200) { p += 0.07; rationale.push("Uptrend (SMA50>SMA200)"); }
    else if (latest.sma50 < latest.sma200) { p -= 0.07; rationale.push("Downtrend (SMA50<SMA200)"); }
    else { rationale.push("Trend neutral (SMA50≈SMA200)"); }
  } else {
    rationale.push("Trend MAs missing");
  }

  // Sentiment tilt (scaled & clamped)
  if (sentiment != null) {
    const tilt = Math.max(-0.08, Math.min(0.08, sentiment * 0.30));
    p += tilt;
    rationale.push(tilt >= 0 ? "Positive sentiment tilt" : "Negative sentiment tilt");
  } else {
    rationale.push("No recent sentiment");
  }

  // 7-bar momentum tilt (scaled & clamped)
  if (pctChange7 != null) {
    const tilt = Math.max(-0.06, Math.min(0.06, pctChange7 * 0.50));
    p += tilt;
    rationale.push(
      `7-bar momentum ${pctChange7 >= 0 ? "positive" : "negative"} (${(pctChange7 * 100).toFixed(1)}%)`
    );
  } else {
    rationale.push("Momentum unavailable (need ~7 daily rows)");
  }

  // Clamp to [0.05, 0.95]
  p = Math.max(0.05, Math.min(0.95, p));

  return jsonResponse({
    ok: true,
    symbol,
    horizon_days: horizonDays,
    probability_up: Number(p.toFixed(2)),
    signals: {
      rsi: latest?.rsi ?? null,
      sma50: latest?.sma50 ?? null,
      sma200: latest?.sma200 ?? null,
      sentiment: sentiment,
      pct_change_7: pctChange7 != null ? Number((pctChange7 * 100).toFixed(2)) : null
    },
    rationale
  });
}
