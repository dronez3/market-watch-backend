import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Public GET:
 *   /api/institutional_signal_link?symbol=AAPL
 * Optional:
 *   &fallback_days=10  (search back up to N days)
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const fallbackDays = Number(url.searchParams.get("fallback_days") || 10);
  if (!symbol) return jsonResponse({ ok: false, error: "Missing ?symbol=XXX" }, 400);

  const supabase = getAnonClient();
  const since = new Date(Date.now() - fallbackDays * 86400_000).toISOString().slice(0, 10); // YYYY-MM-DD

  const { data, error } = await supabase
    .from("institutional_flows")
    .select("date, buy_usd, sell_usd, net_usd_flow, block_trade_volume, block_trade_count, dark_volume, dark_share, source")
    .eq("symbol", symbol)
    .gte("date", since)
    .order("date", { ascending: false })
    .limit(1);

  if (error) return jsonResponse({ ok: false, stage: "select", error: error.message }, 500);

  const row = data && data.length ? (data[0] as any) : null;
  if (!row) {
    return jsonResponse({ ok: true, symbol, found: false, note: "No institutional_flows row in range" });
  }

  // Normalize metrics
  const buy = row.buy_usd != null ? Number(row.buy_usd) : null;
  const sell = row.sell_usd != null ? Number(row.sell_usd) : null;
  let net = row.net_usd_flow != null ? Number(row.net_usd_flow) : null;
  if (net == null && buy != null && sell != null) net = buy - sell;

  const blockVol = row.block_trade_volume != null ? Number(row.block_trade_volume) : null; // shares
  const blockCnt = row.block_trade_count != null ? Number(row.block_trade_count) : null;
  const darkShare = row.dark_share != null ? Number(row.dark_share) : null; // 0..1

  // Scoring (tilt in [-1..+1]), simple & explainable
  let tilt = 0;
  const rationale: string[] = [];

  // Net flow ($) thresholds (tunable)
  if (net != null) {
    if (net > 10_000_000) { tilt += 0.30; rationale.push(`Strong net buying: $${Math.round(net/1e6)}M`); }
    else if (net > 1_000_000) { tilt += 0.15; rationale.push(`Net buying: $${Math.round(net/1e6)}M`); }
    else if (net < -10_000_000) { tilt -= 0.30; rationale.push(`Strong net selling: $${Math.round(-net/1e6)}M`); }
    else if (net < -1_000_000) { tilt -= 0.15; rationale.push(`Net selling: $${Math.round(-net/1e6)}M`); }
    else rationale.push("Net flow ~flat");
  } else {
    rationale.push("Net flow unavailable");
  }

  // Block trades (volume-driven proxy)
  if (blockVol != null) {
    if (blockVol > 2_000_000) { tilt += 0.10; rationale.push(`Heavy block volume: ${Math.round(blockVol/1e6)}M sh`); }
    else if (blockVol > 500_000) { tilt += 0.05; rationale.push(`Elevated block volume: ${Math.round(blockVol/1e3)}k sh`); }
    else rationale.push("Block volume modest");
  } else {
    rationale.push("Block volume unavailable");
  }

  // Dark share (higher can be cautious)
  if (darkShare != null) {
    if (darkShare >= 0.50) { tilt -= 0.10; rationale.push(`High dark share: ${(darkShare*100).toFixed(0)}%`); }
    else if (darkShare >= 0.40) { tilt -= 0.05; rationale.push(`Elevated dark share: ${(darkShare*100).toFixed(0)}%`); }
    else if (darkShare <= 0.20) { tilt += 0.05; rationale.push(`Low dark share: ${(darkShare*100).toFixed(0)}%`); }
    else rationale.push(`Dark share normal: ${(darkShare*100).toFixed(0)}%`);
  } else {
    rationale.push("Dark share unavailable");
  }

  // Clamp and label
  tilt = Math.max(-1, Math.min(1, tilt));
  const label: "bullish" | "neutral" | "bearish" = tilt > 0.15 ? "bullish" : tilt < -0.15 ? "bearish" : "neutral";

  return jsonResponse({
    ok: true,
    symbol,
    found: true,
    as_of: row.date,
    metrics: {
      net_usd_flow: net,
      buy_usd: buy,
      sell_usd: sell,
      block_trade_volume: blockVol,
      block_trade_count: blockCnt,
      dark_share: darkShare,
      source: row.source || null
    },
    tilt: Number(tilt.toFixed(2)),
    label,
    rationale
  });
}
