export const config = { runtime: "edge" };

function csvEscape(v: any) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(rows: any[]) {
  const headers = [
    "symbol",
    "probability_up",
    "momentum_7bar_pct",
    "sentiment",
    "volatility",
    "liquidity_score",
    "action",
    "rsi",
    "sma50",
    "sma200",
    "risk_flags"
  ];
  const head = headers.join(",") + "\n";
  const body = rows.map(r => {
    const line = [
      r.symbol,
      r.probability_up != null ? Number(r.probability_up).toFixed(4) : "",
      r.momentum_7bar_pct != null ? Number(r.momentum_7bar_pct).toFixed(2) : "",
      r.sentiment != null ? Number(r.sentiment).toFixed(3) : "",
      r.volatility ?? "",
      r.liquidity_score != null ? Number(r.liquidity_score).toFixed(2) : "",
      (r.action || (r.probability_up >= 0.60 ? "consider_accumulating" : r.probability_up <= 0.45 ? "watchlist_caution" : "hold")).replace("_"," "),
      r.signals?.rsi != null ? Math.round(r.signals.rsi) : "",
      r.signals?.sma50 != null ? Math.round(r.signals.sma50) : "",
      r.signals?.sma200 != null ? Math.round(r.signals.sma200) : "",
      Array.isArray(r.risk_flags) ? r.risk_flags.join(" | ") : ""
    ];
    return line.map(csvEscape).join(",");
  }).join("\n");
  return head + body + "\n";
}

/**
 * GET /api/export_portfolio_csv?user=UUID&hours=72
 * -> Returns text/csv built from /api/action_portfolio_insights (no token on client)
 */
export default async function handler(req: Request) {
  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const user = (url.searchParams.get("user") || "").trim();
    const hours = Number(url.searchParams.get("hours") || 72);
    if (!user) {
      return new Response("error,missing user", { status: 400, headers: { "content-type": "text/plain" } });
    }

    const insightsUrl = `${origin}/api/action_portfolio_insights?user=${encodeURIComponent(user)}&hours=${encodeURIComponent(String(hours))}`;
    const r = await fetch(insightsUrl, { cache: "no-store" });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || data.ok !== true) {
      const msg = `error,upstream failed,status=${r.status}`;
      return new Response(msg, { status: 502, headers: { "content-type": "text/plain" } });
    }

    const rows = Array.isArray(data.results) ? data.results : [];
    const csv = toCSV(rows);
    return new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="portfolio_${user.slice(0,8)}_${Date.now()}.csv"`
      }
    });
  } catch (e: any) {
    return new Response(`error,${String(e?.message || e)}`, { status: 500, headers: { "content-type": "text/plain" } });
  }
}
