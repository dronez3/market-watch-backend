import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Token-protected multi-day upsert into daily_agg.
 * Example:
 * /api/daily_multi_upsert_link?token=TOKEN&symbol=AAPL&d1=2025-08-13&c1=220&d2=2025-08-14&c2=221.2 ...
 * Accepts up to 30 (dN, cN) pairs.
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol) return jsonResponse({ ok:false, error:"Missing ?symbol=XXX" }, 400);

  const rows: any[] = [];
  for (let i = 1; i <= 30; i++) {
    const d = url.searchParams.get(`d${i}`);
    const c = url.searchParams.get(`c${i}`);
    if (!d && !c) continue;
    if (!d || !c) return jsonResponse({ ok:false, error:`Missing pair for d${i}/c${i}` }, 400);
    const close = Number(c);
    if (!isFinite(close)) return jsonResponse({ ok:false, error:`Bad number for c${i}` }, 400);
    rows.push({ symbol, date: d, close });
  }
  if (rows.length === 0) return jsonResponse({ ok:false, error:"Provide at least one dN/cN pair" }, 400);

  const supabase = getServiceClient();
  const { error } = await supabase.from("daily_agg").upsert(rows, { onConflict: "symbol,date" });
  if (error) return jsonResponse({ ok:false, stage:"upsert", error:error.message }, 500);

  return jsonResponse({ ok:true, symbol, count: rows.length });
}
