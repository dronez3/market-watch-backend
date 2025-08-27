import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Direct-link institutional flow ingest (upsert one row).
 * Example:
 * /api/institutional_ingest_link?token=TOKEN&symbol=AAPL&date=2025-08-26
 *   &buy_usd=25000000&sell_usd=18000000&net_usd_flow=7000000
 *   &block_trade_volume=3200000&block_trade_count=85
 *   &dark_volume=12000000&dark_share=0.42&source=CustomFeed
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);

  // Auth via query token (same pattern as other *_link endpoints)
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  // Required params
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const date = url.searchParams.get("date") || ""; // YYYY-MM-DD
  if (!symbol || !date) {
    return jsonResponse({ ok: false, error: "Missing required params: symbol, date (YYYY-MM-DD)" }, 400);
  }

  // Optional numerics
  const row = {
    symbol,
    date,
    buy_usd: url.searchParams.get("buy_usd") ? Number(url.searchParams.get("buy_usd")) : null,
    sell_usd: url.searchParams.get("sell_usd") ? Number(url.searchParams.get("sell_usd")) : null,
    net_usd_flow: url.searchParams.get("net_usd_flow") ? Number(url.searchParams.get("net_usd_flow")) : null,
    block_trade_volume: url.searchParams.get("block_trade_volume") ? Number(url.searchParams.get("block_trade_volume")) : null,
    block_trade_count: url.searchParams.get("block_trade_count") ? Number(url.searchParams.get("block_trade_count")) : null,
    dark_volume: url.searchParams.get("dark_volume") ? Number(url.searchParams.get("dark_volume")) : null,
    dark_share: url.searchParams.get("dark_share") ? Number(url.searchParams.get("dark_share")) : null, // 0..1
    source: url.searchParams.get("source") || null
  };

  try {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from("institutional_flows")
      .upsert(row, { onConflict: "symbol,date" });

    if (error) return jsonResponse({ ok: false, stage: "upsert", error: error.message }, 500);
    return jsonResponse({ ok: true, upserted: { symbol, date } });
  } catch (e: any) {
    return jsonResponse({ ok: false, stage: "exception", error: String(e?.message || e) }, 500);
  }
}
