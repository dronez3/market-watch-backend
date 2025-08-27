import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * TEMP endpoint for direct-link browser testing ONLY.
 * Usage (example):
 * /api/prices_upsert_link?token=YOUR_TOKEN&symbol=AAPL&ts=2025-08-26T14:30:00Z&open=220&high=221&low=219&close=220.5&volume=1000000
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const ts = url.searchParams.get("ts") || "";
  if (!symbol || !ts) {
    return jsonResponse({ ok: false, error: "Missing required params: symbol, ts" }, 400);
  }

  const open = url.searchParams.get("open");
  const high = url.searchParams.get("high");
  const low = url.searchParams.get("low");
  const close = url.searchParams.get("close");
  const volume = url.searchParams.get("volume");

  const row = {
    symbol,
    ts: new Date(ts).toISOString(),
    open: open ? Number(open) : null,
    high: high ? Number(high) : null,
    low: low ? Number(low) : null,
    close: close ? Number(close) : null,
    volume: volume ? Number(volume) : null
  };

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("prices").upsert([row], { onConflict: "symbol,ts" });
    if (error) return jsonResponse({ ok: false, stage: "upsert", error: error.message }, 500);
    return jsonResponse({ ok: true, count: data?.length ?? 1, row });
  } catch (e: any) {
    return jsonResponse({ ok: false, stage: "exception", error: String(e?.message || e) }, 500);
  }
}
