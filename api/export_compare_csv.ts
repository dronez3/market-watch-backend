import { withCORS, preflight } from "./_cors";
import { rateGate } from "./_rate";

export const config = { runtime: "edge" };

// --- Local normalizer (accepts ^GSPC, .INX, BRK-B, etc.) --------------------
function stripWeirdWhitespace(s: string) {
  return s.replace(/[\u00A0\u200B-\u200D\uFEFF]/g, " ").trim();
}
function normalizeSymbol(raw: string): string {
  let s = stripWeirdWhitespace((raw || "").toUpperCase());
  if (!s) throw new Error(`Bad symbol: ${raw}`);

  // Strip Yahoo/Google index prefixes
  if (s.startsWith("^") || s.startsWith(".")) s = s.slice(1);

  // Normalize hyphen to dot (e.g., BRK-B -> BRK.B)
  s = s.replace(/-/g, ".");

  // Common index aliases -> ETF proxies (keeps downstream happy)
  const indexMap: Record<string, string> = {
    // S&P 500
    GSPC: "SPY", INX: "SPY", SPX: "SPY", US500: "SPY",
    // Nasdaq 100
    NDX: "QQQ", IXNDX: "QQQ", NAS100: "QQQ", US100: "QQQ",
    // Dow Jones
    DJI: "DIA", DJIA: "DIA",
    // Russell 2000
    RUT: "IWM", RTY: "IWM",
    // Nasdaq Composite (approx)
    IXIC: "QQQ"
  };
  if (s in indexMap) s = indexMap[s];

  // Final sanity: conservative charset/length
  if (!/^[A-Z][A-Z0-9.]{0,15}$/.test(s)) {
    throw new Error(`Bad symbol: ${raw}`);
  }
  return s;
}

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

    // Normalize & validate symbols here to avoid any cached-module issues
    const raw = url.searchParams.get("symbols") || "";
    const list = raw.split(",").map(s => s.trim()).filter(Boolean);
    if (!list.length) {
      return withCORS(new Response("error,validation_failed,Missing symbols", { status: 400, headers: { "content-type": "text/plain" } }), req);
    }
    const normalized: string[] = [];
    for (const item of list) {
      try {
        normalized.push(normalizeSymbol(item));
      } catch (e: any) {
        return withCORS(new Response(`error,validation_failed,${String(e?.message || e)}`, { status: 400, headers: { "content-type": "text/plain" } }), req);
      }
    }

    // horizon_days range check
    const hRaw = url.searchParams.get("horizon_days");
    const horizon = hRaw == null ? 5 : Math.trunc(Number(hRaw));
    if (!Number.isFinite(horizon) || horizon < 1 || horizon > 14) {
      return withCORS(new Response("error,validation_failed,Bad horizon_days", { status: 400, headers: { "content-type": "text/plain" } }), req);
    }

    const compareUrl = `${origin}/api/compare_proxy?symbols=${encodeURIComponent(normalized.join(","))}&horizon_days=${encodeURIComponent(String(horizon))}`;
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
