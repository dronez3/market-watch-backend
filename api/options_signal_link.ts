import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Compute options tilt from the most recent row.
 * Public GET:
 *   /api/options_signal_link?symbol=AAPL
 * Optional:
 *   &fallback_days=7  -> search back up to N days for latest row
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const fallbackDays = Number(url.searchParams.get("fallback_days") || 7);
  if (!symbol) return jsonResponse({ ok: false, error: "Missing ?symbol=XXX" }, 400);

  const supabase = getAnonClient();

  // Find latest date within fallback window
  const since = new Date(Date.now() - fallbackDays * 86400_000).toISOString().slice(0,10); // YYYY-MM-DD
  const { data, error } = await supabase
    .from("options_summary")
    .select("date, call_volume, put_volume, call_oi, put_oi, iv_rank, iv_percentile")
    .eq("symbol", symbol)
    .gte("date", since)
    .order("date", { ascending: false })
    .limit(1);

  if (error) return jsonResponse({ ok: false, stage: "select", error: error.message }, 500);
  const row = data?.[0];
  if (!row) return jsonResponse({ ok: true, symbol, found: false, note: "No options_summary row in range" });

  const cv = Number(row.call_volume ?? 0);
  const pv = Number(row.put_volume ?? 0);
  const coi = Number(row.call_oi ?? 0);
  const poi = Number(row.put_oi ?? 0);
  const ivr = row.iv_rank != null ? Number(row.iv_rank) : null;

  const volRatio = pv === 0 ? (cv > 0 ? Infinity : 1) : cv / pv;   // >1 bullish
  const oiRatio  = poi === 0 ? (coi > 0 ? Infinity : 1) : coi / poi;

  // Simple, explainable tilt in [-1..+1]
  const r1 = isFinite(volRatio) ? Math.max(-1, Math.min(1, (volRatio - 1) * 0.5)) : 1; // volume tilt
  const r2 = isFinite(oiRatio)  ? Math.max(-1, Math.min(1, (oiRatio  - 1) * 0.5)) : 1; // OI tilt
  const r3 = ivr != null ? Math.max(-1, Math.min(1, (0.5 - ivr) * 0.6)) : 0; // low IV rank slightly bullish

  const tilt = Math.max(-1, Math.min(1, r1 * 0.6 + r2 * 0.3 + r3 * 0.1));
  const label: "bullish" | "neutral" | "bearish" =
    tilt > 0.15 ? "bullish" : tilt < -0.15 ? "bearish" : "neutral";

  return jsonResponse({
    ok: true,
    symbol,
    found: true,
    as_of: row.date,
    metrics: {
      call_volume: cv,
      put_volume: pv,
      call_oi: coi,
      put_oi: poi,
      iv_rank: ivr,
      volume_put_call: isFinite(volRatio) ? Number(volRatio.toFixed(2)) : null,
      oi_put_call: isFinite(oiRatio) ? Number(oiRatio.toFixed(2)) : null
    },
    tilt: Number(tilt.toFixed(2)),
    label,
    rationale: [
      `Volume put/call ratio ${isFinite(volRatio) ? volRatio.toFixed(2) : "∞"}`,
      `OI put/call ratio ${isFinite(oiRatio) ? oiRatio.toFixed(2) : "∞"}`,
      ivr != null ? `IV rank ${ivr}` : "IV rank unavailable"
    ]
  });
}
