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
    "rsi",
    "sma50",
    "sma200",
    "top_rationales"
  ];
  const head = headers.join(",") + "\n";
  const body = rows.map(r => {
    const line = [
      r.symbol,
      r.probability_up != null ? Number(r.probability_up).toFixed(4) : "",
      r.momentum_7bar_pct != null ? Number(r.momentum_7bar_pct).toFixed(2) : "",
      r.sentiment != null ? Number(r.sentiment).toFixed(3) : "",
      r.volatility ?? "",
      r.signals?.rsi != null ? Math.round(r.signals.rsi) : "",
      r.signals?.sma50 != null ? Math.round(r.signals.sma50) : "",
      r.signals?.sma200 != null ? Math.round(r.signals.sma200) : "",
      Array.isArray(r.rationale) ? r.rationale.slice(0,3).join(" | ") : ""
    ];
    return line.map(csvEscape).join(",");
  }).join("\n");
  return head + body + "\n";
}

/**
 * GET /api/export_compare_csv?symbols=SPY,QQQ,AAPL&horizon_days=5
 * -> Returns text/csv built from /api/compare_proxy
 */
export default async function handler(req: Request) {
  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const symbols = (url.searchParams.get("symbols") || "").trim();
    const horizon = Number(url.searchParams.get("horizon_days") || 5);
    if (!symbols) {
      return new Response("error,missing symbols", { status: 400, headers: { "content-type": "text/plain" } });
    }
    const compareUrl = `${origin}/api/compare_proxy?symbols=${encodeURIComponent(symbols)}&horizon_days=${encodeURIComponent(String(horizon))}`;
    const r = await fetch(compareUrl, { cache: "no-store" });
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
        "content-disposition": `attachment; filename="compare_${Date.now()}.csv"`
      }
    });
  } catch (e: any) {
    return new Response(`error,${String(e?.message || e)}`, { status: 500, headers: { "content-type": "text/plain" } });
  }
}
