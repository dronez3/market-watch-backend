export const config = { runtime: "edge" };

import { rateGate } from "./_rate";
import { vSymbol, vIntInRange } from "./_validate";

// Minimal JSON helper
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
 * Public: aggregate signals for one symbol via your existing endpoints,
 * plus expected return (drift/vol over lookback).
 *
 * GET /api/scorecard_plus_proxy?symbol=AAPL&horizon_days=5&hours=72&lookback_days=90
 */
export default async function handler(req: Request) {
  // Rate limit: 60 req / 60s per IP for this route
  const limited = await rateGate(req, "scorecard_plus", 60, 60);
  if (limited) return limited;

  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;

    // Strict validation
    let symbol: string, horizonDays: number, hours: number, lookback: number;
    try {
      symbol = vSymbol(url.searchParams.get("symbol") || "");
      horizonDays = vIntInRange(url.searchParams.get("horizon_days"), 5, 1, 14);
      hours = vIntInRange(url.searchParams.get("hours"), 72, 6, 168);
      lookback = vIntInRange(url.searchParams.get("lookback_days"), 90, 20, 250);
    } catch (e: any) {
      return json({ ok:false, error: `Validation failed: ${String(e?.message || e)}` }, 400);
    }

    // Upstream URLs (all public)
    const probUrl  = `${origin}/api/prob?symbol=${encodeURIComponent(symbol)}&horizon_days=${encodeURIComponent(String(horizonDays))}`;
    const techUrl  = `${origin}/api/tech?symbol=${encodeURIComponent(symbol)}`;
    const optUrl   = `${origin}/api/options_signal_link?symbol=${encodeURIComponent(symbol)}`;
    const instUrl  = `${origin}/api/institutional_signal_link?symbol=${encodeURIComponent(symbol)}`;
    const expUrl   = `${origin}/api/expected_return?symbol=${encodeURIComponent(symbol)}&horizon_days=${encodeURIComponent(String(horizonDays))}&lookback_days=${encodeURIComponent(String(lookback))}`;

    // Fetch sequentially for robustness on Edge
    const prob = await getJSON(probUrl);
    const tech = await getJSON(techUrl);
    const opts = await getJSON(optUrl);
    const inst = await getJSON(instUrl);
    const exp  = await getJSON(expUrl);

    // Base probability
    const baseP = prob.ok && prob.data?.ok ? Number(prob.data.probability_up ?? 0.5) : 0.5;

    // Tilts
    const optTilt  = (opts.ok && opts.data?.ok && opts.data?.found !== false) ? Number(opts.data.tilt ?? 0) : 0; // [-1..1]
    const instTilt = (inst.ok && inst.data?.ok && inst.data?.found !== false) ? Number(inst.data.tilt ?? 0) : 0;  // [-1..1]

    // Blended probability
    let blended = baseP + 0.05 * optTilt + 0.05 * instTilt;
    blended = Math.max(0.05, Math.min(0.95, blended));

    // Technicals
    const rsi   = tech.ok && tech.data?.ok && tech.data?.computed ? tech.data.rsi   ?? null : null;
    const sma50 = tech.ok && tech.data?.ok && tech.data?.computed ? tech.data.sma50 ?? null : null;
    const sma200= tech.ok && tech.data?.ok && tech.data?.computed ? tech.data.sma200?? null : null;

    // Momentum (from /api/prob signals)
    const mom7 = prob.ok && prob.data?.signals?.pct_change_7 != null
      ? Number(prob.data.signals.pct_change_7) : null;

    // Expected return
    const expOK = exp.ok && exp.data?.ok === true && exp.data?.enough_data !== false;
    const erPct   = expOK ? Number(exp.data.expected_return_pct) : null; // %
    const erLow   = expOK ? Number(exp.data.conf_interval_68_pct?.low) : null; // %
    const erHigh  = expOK ? Number(exp.data.conf_interval_68_pct?.high) : null; // %
    const erConf  = expOK ? Number(exp.data.confidence ?? 0) : null;

    // Build analysis line
    const parts: string[] = [];
    parts.push(`${symbol}: ${(blended * 100).toFixed(0)}% short-term upside probability over ~${horizonDays} days.`);
    if (typeof rsi === "number") parts.push(`RSI ${Math.round(rsi)} (${rsi < 30 ? "oversold" : rsi > 70 ? "overbought" : "neutral"})`);
    if (typeof sma50 === "number" && typeof sma200 === "number") {
      parts.push(`Trend ${sma50 > sma200 ? "bullish" : sma50 < sma200 ? "bearish" : "neutral"} (SMA50 ${sma50 > sma200 ? ">" : sma50 < sma200 ? "<" : "="} SMA200)`);
    }
    if (mom7 != null) parts.push(`7-bar momentum ${Number(mom7).toFixed(2)}%`);
    if (opts.ok && opts.data?.ok && opts.data?.found !== false) parts.push(`Options tilt: ${opts.data.label} (${Number(opts.data.tilt).toFixed(2)})`);
    if (inst.ok && inst.data?.ok && inst.data?.found !== false) parts.push(`Institutional tilt: ${inst.data.label} (${Number(inst.data.tilt).toFixed(2)})`);
    if (expOK) parts.push(`Expected return ~${erPct?.toFixed(2)}% (68%: ${erLow?.toFixed(2)}% .. ${erHigh?.toFixed(2)}%)`);

    // Action hint
    let action: "consider_accumulating" | "hold" | "watchlist_caution" = "hold";
    if (blended >= 0.60 && (typeof sma50 === "number") && (typeof sma200 === "number") && sma50 > sma200) action = "consider_accumulating";
    if (blended <= 0.45) action = "watchlist_caution";

    return json({
      ok: true,
      symbol,
      horizon_days: horizonDays,
      window_hours: hours,
      lookback_days: lookback,
      probability_base: Number(baseP.toFixed(2)),
      probability_blended: Number(blended.toFixed(2)),
      expected_return: expOK ? {
        pct: Number(erPct!.toFixed(2)),
        conf68: { low: Number(erLow!.toFixed(2)), high: Number(erHigh!.toFixed(2)) },
        confidence: Number(erConf!.toFixed(2))
      } : { available: false },
      technicals: { rsi, sma50, sma200 },
      momentum_7bar_pct: mom7 != null ? Number(Number(mom7).toFixed(2)) : null,
      action,
      analysis: parts.join(" • "),
      components: { prob, tech, options: opts, institutional: inst, expected_return: exp },
      sources: { probUrl, techUrl, optUrl, instUrl, expUrl }
    });
  } catch (e: any) {
    return json({ ok:false, stage:"top_level", error:String(e?.message || e) }, 500);
  }
}
