import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Direct-link options ingest (one row, upsert).
 * Example:
 * /api/options_ingest_link?token=TOKEN&symbol=AAPL&date=2025-08-26&call_volume=120000&put_volume=80000&call_oi=950000&put_oi=870000&iv_rank=0.45&iv_percentile=58
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);

  // auth via query token (same as other link endpoints)
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  // required
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const date = url.searchParams.get("date") || ""; // YYYY-MM-DD
  if (!symbol || !date) return jsonResponse({ ok: false, error: "Missing required params: symbol, date" }, 400);

  // optional numeric fields
  const row = {
    symbol,
    date, // stored as DATE in Supabase
    call_volume: url.searchParams.get("call_volume") ? Number(url.searchParams.get("call_volume")) : null,
    put_volume:  url.searchParams.get("put_volume")  ? Number(url.searchParams.get("put_volume"))  : null,
    call_oi:     url.searchParams.get("call_oi")     ? Number(url.searchParams.get("call_oi"))     : null,
    put_oi:      url.searchParams.get("put_oi")      ? Number(url.searchParams.get("put_oi"))      : null,
    iv_rank:     url.searchParams.get("iv_rank")     ? Number(url.searchParams.get("iv_rank"))     : null,         // 0..1
    iv_percentile: url.searchParams.get("iv_percentile") ? Number(url.searchParams.get("iv_percentile")) : null   // 0..100
  };

  const supabase = getServiceClient();

  // Upsert without reading data length (avoids TS "never" issues)
  const { error } = await supabase.from("options_summary").upsert(row, { onConflict: "symbol,date" });
  if (error) return jsonResponse({ ok: false, stage: "upsert", error: error.message }, 500);

  return jsonResponse({ ok: true, upserted: { symbol, date } });
}
