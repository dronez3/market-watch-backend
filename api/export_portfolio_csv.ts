import { withCORS, preflight } from "./_cors";
import { rateGate } from "./_rate";
import { vUUID, vIntInRange } from "./_validate";

export const config = { runtime: "edge" };

function csvEscape(v: any) { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toCSV(rows: any[]) {
  const headers = ["symbol","probability_up","momentum_7bar_pct","sentiment","volatility","liquidity_score","action","rsi","sma50","sma200","risk_flags"];
  const head = headers.join(",") + "\n";
  const body = rows.map(r => [
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
  ].map(csvEscape).join(",")).join("\n");
  return head + body + "\n";
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;

  // Rate limit: 12 downloads / 60s per IP
  const limited = await rateGate(req, "csv_portfolio", 12, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;

    // Validate inputs
    let user: string, hours: number;
    try {
      user = vUUID(url.searchParams.get("user") || "");
      hours = vIntInRange(url.searchParams.get("hours"), 72, 6, 168);
    } catch (e: any) {
      return withCORS(new Response(`error,validation_failed,${String(e?.message || e)}`, { status: 400, headers: { "content-type": "text/plain" } }), req);
    }

    const insightsUrl = `${origin}/api/action_portfolio_insights?user=${encodeURIComponent(user)}&hours=${encodeURIComponent(String(hours))}`;
    const r = await fetch(insightsUrl, { cache: "no-store" });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || data.ok !== true) {
      return withCORS(new Response(`error,upstream failed,status=${r.status}`, { status: 502, headers: { "content-type": "text/plain" } }), req);
    }

    const rows = Array.isArray(data.results) ? data.results : [];
    const csv = toCSV(rows);
    return withCORS(new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="portfolio_${user.slice(0,8)}_${Date.now()}.csv"`
      }
    }), req);
  } catch (e: any) {
    return withCORS(new Response(`error,${String(e?.message || e)}`, { status: 500, headers: { "content-type": "text/plain" } }), req);
  }
}
