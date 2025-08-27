import { jsonResponse, requireBearer } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

type Bar = {
  symbol: string; // e.g., "AAPL"
  ts: string;     // ISO date-time
  open?: number; high?: number; low?: number; close?: number;
  volume?: number;
};

export default async function handler(req: Request) {
  const auth = requireBearer(req);
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.err }, auth.status);

  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Use POST" }, 405);

  let body: { bars: Bar[] } | null = null;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  const bars = body?.bars || [];
  if (!Array.isArray(bars) || bars.length === 0) {
    return jsonResponse({ ok: false, error: "Provide { bars: Bar[] }" }, 400);
  }

  // normalize
  const rows = bars.map(b => ({
    symbol: b.symbol,
    ts: new Date(b.ts).toISOString(),
    open: b.open ?? null,
    high: b.high ?? null,
    low: b.low ?? null,
    close: b.close ?? null,
    volume: b.volume ?? null
  }));

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("prices").upsert(rows, { onConflict: "symbol,ts" });
    if (error) return jsonResponse({ ok: false, stage: "upsert", error: error.message }, 500);
    return jsonResponse({ ok: true, count: data?.length ?? rows.length });
  } catch (e: any) {
    return jsonResponse({ ok: false, stage: "exception", error: String(e?.message || e) }, 500);
  }
}
