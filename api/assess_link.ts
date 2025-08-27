import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Natural-language assessment for a symbol (public GET).
 * Usage:
 *   /api/assess_link?symbol=AAPL&hours=72&horizon_days=5
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const hours = Number(url.searchParams.get("hours") || 72);
  const horizonDays = Number(url.searchParams.get("horizon_days") || 5);
  if (!symbol) return jsonResponse({ ok: false, error: "Missing ?symbol=XXX" }, 400);

  const supabase = getAnonClient();

  // Latest daily technicals
  const { data: latestArr, error: daErr } = await supabase
    .from("daily_agg")
    .select("date, close, rsi, sma50, sma200, atr")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(1);
  if (daErr) return jsonResponse({ ok: false, stage: "daily_agg_latest", error: daErr.message }, 500);
  const latest: any = latestArr?.[0] || null;

  // 7-bar momentum
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

  // 30-day ATR average (for volatility label)
  const { data: last30, error: aErr } = await supabase
    .from("daily_agg")
    .select("atr, close")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(30);
  if (aErr) return jsonResponse({ ok: false, stage: "daily_agg_30", error: aErr.message }, 500);

  let atrNow: number | null = latest?.atr ?? null;
  let atrAvg30: number | null = null;
  if (last30 && last30.length > 0) {
    const vals = (last30 as any[]).map(r => (r.atr == null ? null : Number(r.atr))).filter(v => v != null) as number[];
    if (vals.length > 0) atrAvg30 = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  let volatility: "high" | "normal" | "low" | null = null;
  if (atrNow != null && atrAvg30 != null) {
    const ratio = atrNow / (atrAvg30 || 1);
    volatility = ratio > 1.15 ? "high" : ratio < 0.85 ? "low" : "normal";
  }

  // Latest sentiment within window
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
  const sentiment: number | null = (ss?.[0]?.score as number | undefined) ?? null;

  // Probability model (same as earlier)
  let p = 0.5;
  const rationale: string[] = [];

  if (latest?.rsi != null) {
    if (latest.rsi < 30) { p += 0.10; rationale.push("RSI oversold (<30)"); }
    else if (latest.rsi > 70) { p -= 0.10; rationale.push("RSI overbought (>70)"); }
    else { rationale.push("RSI neutral"); }
  } else {
    rationale.push("RSI missing");
  }

  if (latest?.sma50 != null && latest?.sma200 != null) {
    if (latest.sma50 > latest.sma200) { p += 0.07; rationale.push("Uptrend (SMA50>SMA200)"); }
    else if (latest.sma50 < latest.sma200) { p -= 0.07; rationale.push("Downtrend (SMA50<SMA200)"); }
    else { rationale.push("Trend neutral (SMA50≈SMA200)"); }
  } else {
    rationale.push("Trend MAs missing");
  }

  if (sentiment != null) {
    const tilt = Math.max(-0.08, Math.min(0.08, sentiment * 0.30));
    p += tilt;
    rationale.push(tilt >= 0 ? "Positive sentiment tilt" : "Negative sentiment tilt");
  } else {
    rationale.push("No recent sentiment");
  }

  if (pctChange7 != null) {
    const tilt = Math.max(-0.06, Math.min(0.06, pctChange7 * 0.50));
    p += tilt;
    rationale.push(`7-bar momentum ${pctChange7 >= 0 ? "positive" : "negative"} (${(pctChange7 * 100).toFixed(1)}%)`);
  } else {
    rationale.push("Momentum unavailable (need ~7 daily rows)");
  }

  p = Math.max(0.05, Math.min(0.95, p));
  const probability_up = Number(p.toFixed(2));

  // Build a readable assessment string
  const parts: string[] = [];
  parts.push(`${symbol}: ${isFinite(probability_up) ? (probability_up * 100).toFixed(0) : "—"}% short-term upside probability over ~${horizonDays} days.`);
  if (latest?.rsi != null) parts.push(`RSI ${Math.round(latest.rsi)} (${latest.rsi < 30 ? "oversold" : latest.rsi > 70 ? "overbought" : "neutral"})`);
  if (latest?.sma50 != null && latest?.sma200 != null) {
    parts.push(`Trend ${latest.sma50 > latest.sma200 ? "bullish" : latest.sma50 < latest.sma200 ? "bearish" : "neutral"} (SMA50 ${latest.sma50 > latest.sma200 ? ">" : latest.sma50 < latest.sma200 ? "<" : "="} SMA200)`);
  }
  if (pctChange7 != null) parts.push(`7-bar momentum ${(pctChange7 * 100).toFixed(1)}%`);
  if (sentiment != null) parts.push(`News sentiment ${sentiment >= 0 ? "+" : ""}${sentiment.toFixed(3)} (last ${hours}h)`);
  if (volatility) parts.push(`Volatility: ${volatility} (ATR vs 30-day avg)`);

  // Simple action hint
  let action: "consider_accumulating" | "hold" | "watchlist_caution" = "hold";
  if (probability_up >= 0.6 && (latest?.sma50 ?? 0) > (latest?.sma200 ?? 0)) action = "consider_accumulating";
  if (probability_up <= 0.45 || volatility === "high") action = "watchlist_caution";

  const analysis = parts.join(" • ");

  return jsonResponse({
    ok: true,
    symbol,
    horizon_days: horizonDays,
    probability_up,
    sentiment,
    momentum_7bar_pct: pctChange7 != null ? Number((pctChange7 * 100).toFixed(2)) : null,
    volatility_label: volatility,
    technicals: {
      rsi: latest?.rsi ?? null,
      sma50: latest?.sma50 ?? null,
      sma200: latest?.sma200 ?? null,
      atr: atrNow,
      atr_avg_30d: atrAvg30
    },
    rationale,
    action,
    analysis
  });
}
