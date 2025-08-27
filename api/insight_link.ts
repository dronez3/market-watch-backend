import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Direct-link combined insight for a symbol.
 * Usage:
 * /api/insight_link?token=YOUR_TOKEN&symbol=AAPL&hours=72&horizon_days=5
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const hours = Number(url.searchParams.get("hours") || 72);
  const horizonDays = Number(url.searchParams.get("horizon_days") || 5);
  if (!symbol) return jsonResponse({ ok: false, error: "Missing ?symbol=XXX" }, 400);

  const supabase = getAnonClient();

  // --- Pull latest daily_agg row (technicals) ---
  const { data: latestArr, error: daErr } = await supabase
    .from("daily_agg")
    .select("date, close, volume, rsi, sma50, sma200, atr")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(1);
  if (daErr) return jsonResponse({ ok: false, stage: "daily_agg_latest", error: daErr.message }, 500);
  const latest = latestArr?.[0];

  // --- Pull last 30 daily_agg rows for momentum & ATR mean ---
  const { data: last30, error: last30Err } = await supabase
    .from("daily_agg")
    .select("date, close, atr")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(30);
  if (last30Err) return jsonResponse({ ok: false, stage: "daily_agg_30", error: last30Err.message }, 500);

  // Compute 7-bar momentum
  let pctChange7: number | null = null;
  if (last30 && last30.length >= 7) {
    const newest = last30[0]?.close as number | null;
    const oldest = last30[6]?.close as number | null;
    if (newest != null && oldest != null && oldest !== 0) {
      pctChange7 = (newest - oldest) / oldest; // 0.043 = +4.3%
    }
  }

  // ATR vs 30-day avg
  let atrNow: number | null = latest?.atr ?? null;
  let atrAvg30: number | null = null;
  if (last30 && last30.length > 0) {
    const vals = last30.map(r => (r.atr == null ? null : Number(r.atr))).filter(v => v != null) as number[];
    if (vals.length > 0) atrAvg30 = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  let volatility: "high" | "normal" | "low" | null = null;
  if (atrNow != null && atrAvg30 != null) {
    const ratio = atrNow / (atrAvg30 || 1);
    volatility = ratio > 1.15 ? "high" : ratio < 0.85 ? "low" : "normal";
  }

  // --- Latest sentiment within lookback window ---
  const now = new Date();
  const startIso = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
  const { data: ss, error: sErr } = await supabase
    .from("sentiment_scores")
    .select("score, window_end")
    .eq("symbol", symbol)
    .gte("window_start", startIso)
    .lte("window_end", now.toISOString())
    .order("window_end", { ascending: false })
    .limit(1);
  if (sErr) return jsonResponse({ ok: false, stage: "sentiment", error: sErr.message }, 500);
  const sentiment = (ss?.[0]?.score as number | undefined) ?? null;

  // --- Probability model (same spirit as /api/upside_probability) ---
  let p = 0.5;
  const rationale: string[] = [];

  // RSI tilt
  if (latest?.rsi != null) {
    if (latest.rsi < 30) { p += 0.10; rationale.push("RSI oversold (<30)"); }
    else if (latest.rsi > 70) { p -= 0.10; rationale.push("RSI overbought (>70)"); }
    else { rationale.push("RSI neutral"); }
  } else {
    rationale.push("RSI missing");
  }

  // Trend tilt
  if (latest?.sma50 != null && latest?.sma200 != null) {
    if (latest.sma50 > latest.sma200) { p += 0.07; rationale.push("Uptrend (SMA50>SMA200)"); }
    else if (latest.sma50 < latest.sma200) { p -= 0.07; rationale.push("Downtrend (SMA50<SMA200)"); }
    else { rationale.push("Trend neutral"); }
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

  // 7-bar momentum tilt
  if (pctChange7 != null) {
    const tilt = Math.max(-0.06, Math.min(0.06, pctChange7 * 0.50));
    p += tilt;
    rationale.push(`7-bar momentum ${pctChange7 >= 0 ? "positive" : "negative"} (${(pctChange7 * 100).toFixed(1)}%)`);
  } else {
    rationale.push("Momentum unavailable (need ~7 daily rows)");
  }

  // Clamp probability
  p = Math.max(0.05, Math.min(0.95, p));
  const probability_up = Number(p.toFixed(2));

  // Expected return (simple, readable stub: ±3% max around 0.50)
  const expected_return_pct = Number(((p - 0.5) * 6).toFixed(2)); // e.g., p=0.60 → +0.60%

  // Momentum label
  let momentum: "positive" | "neutral" | "negative" | null = null;
  if (pctChange7 != null) {
    momentum = Math.abs(pctChange7) < 0.005 ? "neutral" : (pctChange7 > 0 ? "positive" : "negative");
  }

  // Crossover
  let crossover: "bullish" | "bearish" | "none" | null = null;
  if (latest?.sma50 != null && latest?.sma200 != null) {
    crossover = latest.sma50 > latest.sma200 ? "bullish" : (latest.sma50 < latest.sma200 ? "bearish" : "none");
  }

  return jsonResponse({
    ok: true,
    symbol,
    horizon_days: horizonDays,
    sentiment: sentiment,
    probability_up,
    momentum,
    volatility,
    expected_return_pct,
    technicals: {
      rsi: latest?.rsi ?? null,
      sma50: latest?.sma50 ?? null,
      sma200: latest?.sma200 ?? null,
      crossover,
      atr: atrNow,
      atr_avg_30d: atrAvg30
    },
    rationale
  });
}
