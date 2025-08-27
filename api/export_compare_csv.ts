import { withCORS, preflight } from "./_cors";
import { rateGate } from "./_rate";
import { vSymbolsList, vIntInRange } from "./_validate";

export const config = { runtime: "edge" };

function csvEscape(v: any) { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function toCSV(rows: any[]) {
  const headers = ["symbol","probability_up","momentum_7bar_pct","sentiment","volatility","rsi","sma50","sma200","top_rationales"];
  const head = headers.join(",") + "\n";
  const body = rows.map(r => [
    r.symbol,
    r.probability_up != null ? Number(r.probability_up).toFixed(4) : "",
    r.momentum_7bar_pct != null ? Number(r.momentum_7bar_pct).toFixed(2) : "",
    r.sentiment != null ? Number(r.sentiment).toFixed(3) : "",
    r.volatility ?? "",
    r.signals?.rsi != null ? Math.round(r.signals.rsi) : "",
    r.signals?.sma50 != null ? Math.round(r.signals.sma50) : "",
    r.signals?.sma200 != null ? Math.round(r.signals.sma200) : "",
    Array.isArray(r.rationale) ? r.rationale.slice(0,3).join(" | ") : ""
  ].map(csvEscape).join(",")).join("\n");
  return head + body + "\n";
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;

  // Rate limit: 12 downloads / 60s per IP
  const limited = await rateGate(req, "csv_compare", 12, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;

    // Validate inputs
    let symbols: string[], horizon: number;
    try {
      symbols = vSymbolsList(url.searchParams.get("symbols") || "", 25);
      horizon = vIntInRange(url.searchParams.get("horizon_days"), 5, 1, 14);
    } catch (e: any) {
      return withCORS(new Response(`error,validation_failed,${String(e?.message || e)}`, { status: 400, headers: { "content-type": "text/plain" } }), req);
    }

    const compareUrl = `${origin}/api/compare_proxy?symbols=${encodeURIComponent(symbols.join(","))}&horizon_days=${encodeURIComponent(String(horizon))}`;
    const r = await fetch(compareUrl, { cache: "no-store" });
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
        "content-disposition": `attachment; filename="compare_${Date.now()}.csv"`
      }
    }), req);
  } catch (e: any) {
    return withCORS(new Response(`error,${String(e?.message || e)}`, { status: 500, headers: { "content-type": "text/plain" } }), req);
  }
}
