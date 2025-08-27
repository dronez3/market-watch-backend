import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Portfolio insights for a user:
 * - probability_up (same weights as /api/upside_probability)
 * - 7-bar momentum
 * - sentiment (latest ~72h)
 * - volatility (ATR vs 30d avg)
 * - liquidity flags (instrument_meta.liquidity_score)
 *
 * GET /api/portfolio_insights_link?token=TOKEN&user=UUID&hours=72
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const user = url.searchParams.get("user") || "";
  const hours = Number(url.searchParams.get("hours") || 72);
  if (!user) return jsonResponse({ ok: false, error: "Missing ?user=UUID" }, 400);

  const supabase = getServiceClient();

  // 1) Get holdings
  const { data: holdings, error: hErr } = await supabase
    .from("user_portfolio")
    .select("symbol, shares, cost_basis")
    .eq("user_id", user);
  if (hErr) return jsonResponse({ ok: false, stage: "holdings", error: hErr.message }, 500);

  const symbols = (holdings || []).map(h => h.symbol.toUpperCase());
  if (symbols.length === 0) return jsonResponse({ ok: true, user, results: [] });

  // 2) Pull latest daily_agg for each symbol
  const results: any[] = [];
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - hours * 3600 * 1000).toISOString();

  for (const sym of symbols) {
    // latest technicals
    const { data: da } = await supabase
      .from("daily_agg")
      .select("date, close, rsi, sma50, sma200, atr")
      .eq("symbol", sym)
      .order("date", { ascending: false })
      .limit(1);

    const latest = da?.[0] || null;

    // 7-bar momentum
    const { data: last7 } = await supabase
      .from("daily_agg")
      .select("date, close, atr")
      .eq("symbol", sym)
      .order("date", { ascending: false })
      .limit(7);

    let pctChange7: number | null = null;
    let atrNow: number | null = latest?.atr ?? null;
    let atrAvg30: number | null = null;

    // 30-day ATR avg
    const { data: last30 } = await supabase
      .from("daily_agg")
      .select("atr, close")
      .eq("symbol", sym)
      .order("date", { ascending: false })
      .limit(30);

    if (last7 && last7.length >= 2) {
      const newest = last7[0]?.close as number | null;
      const oldest = last7[last7.length - 1]?.close as number | null;
      if (newest != null && oldest != null && oldest !== 0) {
        pctChange7 = (newest - oldest) / oldest;
      }
    }

    if (last30 && last30.length > 0) {
      const vals = last30.map(r => (r.atr == null ? null : Number(r.atr))).filter(v => v != null) as number[];
      if (vals.length > 0) atrAvg30 = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    let volatility: "high" | "normal" | "low" | null = null;
    if (atrNow != null && atrAvg30 != null) {
      const ratio = atrNow / (atrAvg30 || 1);
      volatility = ratio > 1.15 ? "high" : ratio < 0.85 ? "low" : "normal";
    }

    // sentiment (latest in window)
    const { data: ss } = await supabase
      .from("sentiment_scores")
      .select("score, window_end")
      .eq("symbol", sym)
      .gte("window_start", windowStart)
      .lte("window_end", new Date().toISOString())
      .order("window_end", { ascending: false })
      .limit(1);
    const sentiment = (ss?.[0]?.score as number | undefined) ?? null;

    // liquidity meta
    const { data: meta } = await supabase
      .from("instrument_meta")
      .select("liquidity_score, beta_1y")
      .eq("symbol", sym)
      .limit(1);
    const liquidity = meta && meta[0] ? Number(meta[0].liquidity_score) : null;
    const beta = meta && meta[0] ? Number(meta[0].beta_1y) : null;

    // probability model (same as single-symbol endpoint)
    let p = 0.5;
    const rationale: string[] = [];

    if (latest?.rsi != null) {
      if (latest.rsi < 30) { p += 0.10; rationale.push("RSI oversold"); }
      else if (latest.rsi > 70) { p -= 0.10; rationale.push("RSI overbought"); }
      else { rationale.push("RSI neutral"); }
    } else {
      rationale.push("RSI missing");
    }
    if (latest?.sma50 != null && latest?.sma200 != null) {
      if (latest.sma50 > latest.sma200) { p += 0.07; rationale.push("Uptrend (SMA50>SMA200)"); }
      else if (latest.sma50 < latest.sma200) { p -= 0.07; rationale.push("Downtrend (SMA50<SMA200)"); }
      else { rationale.push("Trend neutral"); }
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
      rationale.push(`7-bar momentum ${pctChange7 >= 0 ? "positive" : "negative"}`);
    } else {
      rationale.push("Momentum unavailable");
    }
    p = Math.max(0.05, Math.min(0.95, p));

    // risk flags
    const risk_flags: string[] = [];
    if (volatility === "high") risk_flags.push("High volatility");
    if (liquidity != null && liquidity < 0.3) risk_flags.push("Low liquidity");
    if (beta != null && beta > 1.3) risk_flags.push("High beta");

    results.push({
      symbol: sym,
      shares: (holdings || []).find(h => h.symbol.toUpperCase() === sym)?.shares ?? null,
      cost_basis: (holdings || []).find(h => h.symbol.toUpperCase() === sym)?.cost_basis ?? null,
      probability_up: Number(p.toFixed(2)),
      momentum_7bar_pct: pctChange7 != null ? Number((pctChange7 * 100).toFixed(2)) : null,
      sentiment,
      volatility,
      liquidity_score: liquidity,
      beta_1y: beta,
      signals: {
        rsi: latest?.rsi ?? null,
        sma50: latest?.sma50 ?? null,
        sma200: latest?.sma200 ?? null
      },
      risk_flags,
      rationale
    });
  }

  // Sort: highest probability first
  results.sort((a, b) => (b.probability_up ?? 0) - (a.probability_up ?? 0));

  return jsonResponse({ ok: true, user, window_hours: hours, count: results.length, results });
}
