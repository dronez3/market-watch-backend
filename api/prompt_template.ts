export const config = { runtime: "edge" };

// tiny JSON helper
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function getJSON(u: string) {
  const r = await fetch(u, { cache: "no-store" });
  const ct = r.headers.get("content-type") || "";
  let data: any = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch { /* ignore */ }
  }
  return { ok: r.ok, status: r.status, data };
}

/**
 * Build a GPT-ready prompt for a ticker using /api/scorecard_proxy.
 *
 * GET /api/prompt_template?symbol=AAPL&hours=72&horizon_days=5
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;

  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const hours = Number(url.searchParams.get("hours") || 72);
  const horizon = Number(url.searchParams.get("horizon_days") || 5);
  if (!symbol) return json({ ok: false, error: "Missing ?symbol=XXX" }, 400);

  // Pull the unified data (probability, technicals, options, institutional)
  const scoreUrl = `${origin}/api/scorecard_proxy?symbol=${encodeURIComponent(symbol)}&hours=${hours}&horizon_days=${horizon}`;
  const score = await getJSON(scoreUrl);

  if (!score.ok || !score.data || score.data.ok !== true) {
    return json({ ok: false, stage: "scorecard_proxy", status: score.status, data: score.data }, 502);
  }

  // Extract fields with safe fallbacks
  const baseP: number | null = typeof score.data.probability_base === "number" ? score.data.probability_base : null;
  const blendedP: number | null = typeof score.data.probability_blended === "number" ? score.data.probability_blended : null;

  const tech = score.data.technicals || {};
  const rsi = (typeof tech.rsi === "number") ? Math.round(tech.rsi) : null;
  const sma50 = (typeof tech.sma50 === "number") ? Math.round(tech.sma50) : null;
  const sma200 = (typeof tech.sma200 === "number") ? Math.round(tech.sma200) : null;
  const trend =
    (sma50 != null && sma200 != null)
      ? (sma50 > sma200 ? "bullish" : sma50 < sma200 ? "bearish" : "neutral")
      : "unknown";

  const probSignals = score.data.components?.prob?.data?.signals || {};
  const momentum7 = (typeof probSignals.pct_change_7 === "number") ? Number(probSignals.pct_change_7) : null;
  const sentiment = (typeof probSignals.sentiment === "number") ? Number(probSignals.sentiment) : null;

  const opt = score.data.components?.options?.data;
  const optLabel = opt && opt.ok && opt.found !== false ? (opt.label || "neutral") : "unknown";
  const optTilt = opt && opt.ok && opt.found !== false && typeof opt.tilt === "number" ? Number(opt.tilt) : null;

  const inst = score.data.components?.institutional?.data;
  const instLabel = inst && inst.ok && inst.found !== false ? (inst.label || "neutral") : "unknown";
  const instTilt = inst && inst.ok && inst.found !== false && typeof inst.tilt === "number" ? Number(inst.tilt) : null;

  // Construct the GPT prompt (clean, no fluff)
  const prompt = [
    `You are an AI stock assistant. Provide a concise, data-backed short-term assessment.`,
    ``,
    `Ticker: ${symbol}`,
    `Horizon: ~${horizon} trading days`,
    `Data window (sentiment): last ${hours} hours`,
    ``,
    `Inputs:`,
    `- Short-term upside probability (base): ${baseP != null ? (baseP*100).toFixed(0)+"%" : "N/A"}`,
    `- Short-term upside probability (blended): ${blendedP != null ? (blendedP*100).toFixed(0)+"%" : "N/A"}`,
    `- Momentum (7 bars): ${momentum7 != null ? momentum7.toFixed(2)+"%" : "N/A"}`,
    `- News sentiment: ${sentiment != null ? (sentiment >= 0 ? "+" : "") + sentiment.toFixed(3) : "N/A"}`,
    `- RSI: ${rsi ?? "N/A"} (${rsi != null ? (rsi < 30 ? "oversold" : rsi > 70 ? "overbought" : "neutral") : "—"})`,
    `- Trend: ${trend} (SMA50 ${sma50 ?? "N/A"} vs SMA200 ${sma200 ?? "N/A"})`,
    `- Options tilt: ${optLabel}${optTilt != null ? ` (${optTilt.toFixed(2)})` : ""}`,
    `- Institutional tilt: ${instLabel}${instTilt != null ? ` (${instTilt.toFixed(2)})` : ""}`,
    ``,
    `Task:`,
    `1) Assess short-term risk and opportunity.`,
    `2) State the likely direction and key drivers (1–3 bullets).`,
    `3) Advise a simple portfolio action (e.g., “consider accumulating”, “hold”, or “watchlist / caution”),`,
    `   including one risk to watch (earnings, macro, liquidity, etc.).`,
  ].join("\n");

  return json({
    ok: true,
    symbol,
    horizon_days: horizon,
    window_hours: hours,
    prompt,
    // For debugging / chaining if needed:
    inputs: {
      probability_base: baseP,
      probability_blended: blendedP,
      momentum_7bar_pct: momentum7,
      sentiment,
      rsi,
      sma50,
      sma200,
      trend,
      options_label: optLabel,
      options_tilt: optTilt,
      institutional_label: instLabel,
      institutional_tilt: instTilt
    },
    source: scoreUrl
  });
}
