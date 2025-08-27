import { jsonResponse } from "./_common";

export const config = { runtime: "edge" };

/**
 * Build a natural-language assessment by calling your existing /api/insight_link.
 * Public GET. Uses ACTIONS_BEARER_TOKEN from env (or ?token= override).
 *
 * Usage:
 *   /api/assess_proxy?symbol=AAPL&hours=72&horizon_days=5
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const hours = Number(url.searchParams.get("hours") || 72);
  const horizonDays = Number(url.searchParams.get("horizon_days") || 5);
  if (!symbol) return jsonResponse({ ok: false, error: "Missing ?symbol=XXX" }, 400);

  const base = (process.env.SELF_BASE_URL || "https://market-watch-backend.vercel.app").replace(/\/+$/, "");
  const token = url.searchParams.get("token") || process.env.ACTIONS_BEARER_TOKEN || "";
  if (!token) return jsonResponse({ ok: false, error: "Missing ACTIONS_BEARER_TOKEN" }, 500);

  const insightUrl =
    `${base}/api/insight_link?token=${encodeURIComponent(token)}&symbol=${encodeURIComponent(symbol)}&hours=${encodeURIComponent(String(hours))}&horizon_days=${encodeURIComponent(String(horizonDays))}`;

  try {
    const r = await fetch(insightUrl);
    const data = await r.json();

    if (!data?.ok) {
      return jsonResponse({ ok: false, stage: "insight_link", proxied: insightUrl, data }, 502);
    }

    const p: number = data.probability_up ?? 0.5;
    const tech = data.technicals || {};
    const rsi = tech.rsi;
    const sma50 = tech.sma50;
    const sma200 = tech.sma200;
    const volatility: "high" | "normal" | "low" | null = data.volatility ?? null;

    const parts: string[] = [];
    parts.push(`${symbol}: ${(p * 100).toFixed(0)}% short-term upside probability over ~${horizonDays} days.`);
    if (typeof rsi === "number") parts.push(`RSI ${Math.round(rsi)} (${rsi < 30 ? "oversold" : rsi > 70 ? "overbought" : "neutral"})`);
    if (typeof sma50 === "number" && typeof sma200 === "number") {
      parts.push(`Trend ${sma50 > sma200 ? "bullish" : sma50 < sma200 ? "bearish" : "neutral"} (SMA50 ${sma50 > sma200 ? ">" : sma50 < sma200 ? "<" : "="} SMA200)`);
    }
    if (data.momentum) parts.push(`Momentum: ${data.momentum}`);
    if (typeof data.sentiment === "number") parts.push(`News sentiment ${data.sentiment >= 0 ? "+" : ""}${data.sentiment.toFixed(3)} (last ${hours}h)`);
    if (volatility) parts.push(`Volatility: ${volatility} (ATR vs 30-day avg)`);

    let action: "consider_accumulating" | "hold" | "watchlist_caution" = "hold";
    if (p >= 0.6 && typeof sma50 === "number" && typeof sma200 === "number" && sma50 > sma200) action = "consider_accumulating";
    if (p <= 0.45 || volatility === "high") action = "watchlist_caution";

    return jsonResponse({
      ok: true,
      symbol,
      horizon_days: horizonDays,
      probability_up: Number(p.toFixed(2)),
      sentiment: data.sentiment ?? null,
      momentum: data.momentum ?? null,
      volatility_label: volatility,
      technicals: tech,
      action,
      analysis: parts.join(" • "),
      via: "insight_link",
      proxied: insightUrl
    });
  } catch (e: any) {
    return jsonResponse({ ok: false, stage: "fetch_insight", error: String(e?.message || e) }, 500);
  }
}
