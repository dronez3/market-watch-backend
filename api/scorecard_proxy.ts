export const config = { runtime: "edge" };

// Minimal JSON helper to avoid external imports
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

// Safe JSON fetch
async function getJSON(u: string) {
  const r = await fetch(u, { cache: "no-store" });
  const ct = r.headers.get("content-type") || "";
  let data: any = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch { data = null; }
  }
  return { ok: r.ok, status: r.status, data };
}

/**
 * Public: aggregate signals for one symbol via your existing endpoints.
 * GET /api/scorecard_proxy?symbol=AAPL&horizon_days=5&hours=72
 */
export default async function handler(req: Request) {
  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
    const horizonDays = Number(url.searchParams.get("horizon_days") || 5);
    const hours = Number(url.searchParams.get("hours") || 72);

    if (!symbol) return json({ ok: false, error: "Missing ?symbol=XXX" }, 400);

    // Build URLs to your own working routes
    const probUrl  = `${origin}/api/prob?symbol=${encodeURIComponent(symbol)}&horizon_days=${encodeURIComponent(String(horizonDays))}`;
    const techUrl  = `${origin}/api/tech?symbol=${encodeURIComponent(symbol)}`;
    const optUrl   = `${origin}/api/options_signal_link?symbol=${encodeURIComponent(symbol)}`;
    const instUrl  = `${origin}/api/institutional_signal_link?symbol=${encodeURIComponent(symbol)}`;

    // Fetch sequentially (more robust on edge)
    const prob  = await getJSON(probUrl);
    const tech  = await getJSON(techUrl);
    const opts  = await getJSON(optUrl);
    const inst  = await getJSON(instUrl);

    // Base probability from /api/prob
    const baseP = prob.ok && prob.data?.ok ? Number(prob.data.probability_up ?? 0.5) : 0.5;

    // Optional tilts
    const optTilt = (opts.ok && opts.data?.ok && opts.data?.found !== false) ? Number(opts.data.tilt ?? 0) : 0;   // [-1..1]
    const instTilt = (inst.ok && inst.data?.ok && inst.data?.found !== false) ? Number(inst.data.tilt ?? 0) : 0;  // [-1..1]

    // Blend: small adjustments from options & institutional tilts (±5% each)
    let blended = baseP + 0.05 * optTilt + 0.05 * instTilt;
    blended = Math.max(0.05, Math.min(0.95, blended));

    // Collect technicals
    const rsi = tech.ok && tech.data?.ok && tech.data?.computed ? tech.data.rsi ?? null : null;
    const sma50 = tech.ok && tech.data?.ok && tech.data?.computed ? tech.data.sma50 ?? null : null;
    const sma200 = tech.ok && tech.data?.ok && tech.data?.computed ? tech.data.sma200 ?? null : null;
    const atr = tech.ok && tech.data?.ok && tech.data?.computed ? tech.data.atr ?? null : null;

    // Compose an analysis line
    const parts: string[] = [];
    parts.push(`${symbol}: ${(blended * 100).toFixed(0)}% short-term upside probability over ~${horizonDays} days.`);
    if (typeof rsi === "number") parts.push(`RSI ${Math.round(rsi)} (${rsi < 30 ? "oversold" : rsi > 70 ? "overbought" : "neutral"})`);
    if (typeof sma50 === "number" && typeof sma200 === "number") {
      parts.push(`Trend ${sma50 > sma200 ? "bullish" : sma50 < sma200 ? "bearish" : "neutral"} (SMA50 ${sma50 > sma200 ? ">" : sma50 < sma200 ? "<" : "="} SMA200)`);
    }
    if (prob.ok && prob.data?.signals?.pct_change_7 != null) {
      parts.push(`7-bar momentum ${Number(prob.data.signals.pct_change_7).toFixed(2)}%`);
    }
    if (opts.ok && opts.data?.ok && opts.data?.found !== false) {
      parts.push(`Options tilt: ${opts.data.label} (${Number(opts.data.tilt).toFixed(2)})`);
    }
    if (inst.ok && inst.data?.ok && inst.data?.found !== false) {
      parts.push(`Institutional tilt: ${inst.data.label} (${Number(inst.data.tilt).toFixed(2)})`);
    }

    // Simple action hint
    let action: "consider_accumulating" | "hold" | "watchlist_caution" = "hold";
    if (blended >= 0.60 && (typeof sma50 === "number") && (typeof sma200 === "number") && sma50 > sma200) action = "consider_accumulating";
    if (blended <= 0.45) action = "watchlist_caution";

    return json({
      ok: true,
      symbol,
      horizon_days: horizonDays,
      window_hours: hours,
      probability_base: Number(baseP.toFixed(2)),
      probability_blended: Number(blended.toFixed(2)),
      components: {
        prob: prob,
        tech: tech,
        options: opts,
        institutional: inst
      },
      technicals: { rsi, sma50, sma200, atr },
      action,
      analysis: parts.join(" • "),
      sources: { probUrl, techUrl, optUrl, instUrl }
    });
  } catch (e: any) {
    return json({ ok: false, stage: "top_level", error: String(e?.message || e) }, 500);
  }
}
