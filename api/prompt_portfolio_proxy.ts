export const config = { runtime: "edge" };

// tiny JSON helper
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

// safe fetch
async function getJSON(u: string) {
  const r = await fetch(u, { cache: "no-store" });
  const ct = r.headers.get("content-type") || "";
  let data: any = null;
  if (ct.includes("application/json")) {
    try { data = await r.json(); } catch {}
  }
  return { ok: r.ok, status: r.status, data };
}

/**
 * Build a GPT-ready prompt for the WHOLE portfolio.
 *
 * GET /api/prompt_portfolio_proxy?user=UUID&token=TOKEN&hours=72&horizon_days=5
 */
export default async function handler(req: Request) {
  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;

    const user = url.searchParams.get("user") || "";
    const token = url.searchParams.get("token") || "";
    const hours = Number(url.searchParams.get("hours") || 72);
    const horizon = Number(url.searchParams.get("horizon_days") || 5);

    if (!user) return json({ ok:false, error:"Missing ?user=UUID" }, 400);
    if (!token) return json({ ok:false, error:"Missing ?token=..." }, 400);

    const src = `${origin}/api/portfolio_insights_link?token=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}&hours=${encodeURIComponent(String(hours))}`;
    const res = await getJSON(src);
    if (!res.ok || !res.data || res.data.ok !== true) {
      return json({ ok:false, stage:"portfolio_insights_link", status:res.status, data:res.data }, 502);
    }

    const results = Array.isArray(res.data.results) ? res.data.results : [];
    // Build compact lines per symbol
    const lines = results.map((r: any, i: number) => {
      const p = r.probability_up != null ? `${(r.probability_up*100).toFixed(0)}%` : "—";
      const mom = r.momentum_7bar_pct != null ? `${Number(r.momentum_7bar_pct).toFixed(2)}%` : "—";
      const sent = r.sentiment != null ? `${r.sentiment >= 0 ? "+" : ""}${Number(r.sentiment).toFixed(3)}` : "—";
      const vol = r.volatility ?? "—";
      const liq = r.liquidity_score != null ? Number(r.liquidity_score).toFixed(2) : "—";
      const risks = Array.isArray(r.risk_flags) ? r.risk_flags.join(", ") : "—";
      return `${i+1}. ${r.symbol}: prob_up ${p}, momentum(7) ${mom}, sentiment ${sent}, volatility ${vol}, liquidity ${liq}; signals RSI ${r.signals?.rsi ?? "—"}, SMA50 ${r.signals?.sma50 ?? "—"}, SMA200 ${r.signals?.sma200 ?? "—"}; risks: ${risks}.`;
    });

    const prompt = [
      `You are an AI portfolio assistant. Provide a concise, data-backed short-term assessment for this portfolio.`,
      ``,
      `Horizon: ~${horizon} trading days`,
      `Data window (sentiment/flows): last ${hours} hours`,
      ``,
      `Portfolio snapshot (ranked by short-term upside probability):`,
      ...lines,
      ``,
      `Tasks:`,
      `1) Identify which positions likely outperform in the next ${horizon} days and why (1–2 bullets each).`,
      `2) Flag positions with high volatility and/or low liquidity; suggest de-risk or sizing guidance where appropriate.`,
      `3) Give a prioritized action list (e.g., “consider accumulating”, “hold”, “watchlist / caution”) with one key risk to watch for each top action.`,
    ].join("\n");

    return json({
      ok: true,
      user,
      horizon_days: horizon,
      window_hours: hours,
      count: results.length,
      prompt,
      // pass-through if you want to inspect upstream data
      source: src
    });
  } catch (e: any) {
    return json({ ok:false, stage:"top_level", error:String(e?.message || e) }, 500);
  }
}
