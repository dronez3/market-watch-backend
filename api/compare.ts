import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Public: compare tickers (default SPY vs QQQ)
 * GET /api/compare?symbols=SPY,QQQ&hours=72&horizon_days=5
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbols = (url.searchParams.get("symbols") || "SPY,QQQ")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const hours = Number(url.searchParams.get("hours") || 72);
  const horizonDays = Number(url.searchParams.get("horizon_days") || 5);

  const supabase = getAnonClient();
  const results: any[] = [];

  for (const symbol of symbols) {
    // Latest technicals
    const { data: latestArr, error: daErr } = await supabase
      .from("daily_agg")
      .select("date, close, rsi, sma50, sma200, atr")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(1);
    if (daErr) return jsonResponse({ ok: false, symbol, stage: "daily_agg_latest", error: daErr.message }, 500);
    const latest: any = latestArr?.[0] ?? null;

    // 7-bar momentum
    const { data: last7, error: mErr } = await supabase
      .from("daily_agg")
      .select("date, close")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(7);
    if (mErr) return jsonResponse({ ok: false, symbol, stage: "daily_agg_7", error: mErr.message }, 500);

    let pctChange7: number | null = null;
    if (last7 && last7.length >= 2) {
      const newest = Number((last7[0] as any)?.close ?? NaN);
      const oldest = Number((last7[last7.length - 1] as any)?.close ?? NaN);
      if (isFinite(newest) && isFinite(oldest) && oldest !== 0) pctChange7 = (newest - oldest) / oldest;
    }

    // ATR vs 30-day avg -> volatility label
    const { data: last30, error: aErr } = await supabase
      .from("daily_agg")
      .select("atr")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(30);
    if (aErr) return jsonResponse({ ok: false, symbol, stage: "daily_agg_30", error: aErr.message }, 500);

    const atrNow: number | null = latest?.atr ?? null;
    let atrAvg30: number | null = null;
    if (last30 && last30.length > 0) {
      const vals = (last30 as any[]).map(r => r.atr == null ? null : Number(r.atr)).filter(v => v != null) as number[];
      if (vals.length > 0) atrAvg30 = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    let volatility: "high" | "normal" | "low" | null = null;
    if (atrNow != null && atrAvg30 != null) {
      const ratio = atrNow / (atrAvg30 || 1);
      volatility = ratio > 1.15 ? "high" : ratio < 0.85 ? "low" : "normal";
    }

    // latest sentiment in window
    const now = new Date();
    const start = new Date(now.getTime() - hours * 3600 * 1000).toISOString();
    const { data: ss, error: sErr } = await supabase
      .from("sentiment_scores")
      .select("score, window_end")
      .eq("symbol", symbol)
      .gte("window_start", start)
      .lte("window_end", now.toISOString())
      .order("window_end", { ascending: false })
      .limit(1);
    if (sErr) return jsonResponse({ ok: false, symbol, stage: "sentiment", error: sErr.message }, 500);
    const sentiment: number | null = ss?.[0] ? Number((ss[0] as any).score) : null;

    // Probability model (same weights as /api/prob)
    let p = 0.5;
    const rationale: string[] = [];
    if (latest?.rsi != null) {
      if (latest.rsi < 30) { p += 0.10; rationale.push("RSI oversold"); }
      else if (latest.rsi > 70) { p -= 0.10; rationale.push("RSI overbought"); }
      else rationale.push("RSI neutral");
    } else rationale.push("RSI missing");

    if (latest?.sma50 != null && latest?.sma200 != null) {
      if (latest.sma50 > latest.sma200) { p += 0.07; rationale.push("Uptrend (SMA50>SMA200)"); }
      else if (latest.sma50 < latest.sma200) { p -= 0.07; rationale.push("Downtrend (SMA50<SMA200)"); }
      else rationale.push("Trend neutral");
    } else rationale.push("Trend MAs missing");

    if (sentiment != null) {
      const tilt = Math.max(-0.08, Math.min(0.08, sentiment * 0.30));
      p += tilt; rationale.push(tilt >= 0 ? "Positive sentiment tilt" : "Negative sentiment tilt");
    } else rationale.push("No recent sentiment");

    if (pctChange7 != null) {
      const tilt = Math.max(-0.06, Math.min(0.06, pctChange7 * 0.50));
      p += tilt; rationale.push(`7-bar momentum ${pctChange7 >= 0 ? "positive" : "negative"} (${(pctChange7 * 100).toFixed(1)}%)`);
    } else rationale.push("Momentum unavailable");

    p = Math.max(0.05, Math.min(0.95, p));
    const probability_up = Number(p.toFixed(2));

    results.push({
      symbol,
      probability_up,
      momentum_7bar_pct: pctChange7 != null ? Number((pctChange7 * 100).toFixed(2)) : null,
      volatility,
      sentiment,
      signals: { rsi: latest?.rsi ?? null, sma50: latest?.sma50 ?? null, sma200: latest?.sma200 ?? null },
      rationale
    });
  }

  // Sort best to worst
  results.sort((a, b) => (b.probability_up ?? 0) - (a.probability_up ?? 0));
  const byMomentum = [...results].sort((a, b) => (b.momentum_7bar_pct ?? -1e9) - (a.momentum_7bar_pct ?? -1e9));
  const bySent = [...results].sort((a, b) => (b.sentiment ?? -1e9) - (a.sentiment ?? -1e9));
  const summary = {
    highest_probability: results[0]?.symbol ?? null,
    strongest_momentum: byMomentum[0]?.symbol ?? null,
    best_sentiment: bySent[0]?.symbol ?? null
  };

  return jsonResponse({
    ok: true,
    horizon_days: horizonDays,
    window_hours: hours,
    count: results.length,
    summary,
    results
  });
}
