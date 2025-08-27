// api/health.ts
export const config = { runtime: "edge" };

import { withCORS, preflight } from "./_cors";
import { jsonOK, jsonErr } from "./_errors";
import { getServiceClient } from "./_supabase";

// Quick “can I talk to Supabase?” check
async function pingSupabase() {
  const sb = getServiceClient();
  // Head-count query against daily_agg; cheap and safe
  const { count, error } = await sb
    .from("daily_agg")
    .select("*", { count: "exact", head: true })
    .limit(1);
  if (error) throw new Error(`supabase: ${error.message}`);
  return { table: "daily_agg", count: count ?? 0 };
}

// Optional: check cache table exists
async function pingCache() {
  const sb = getServiceClient();
  const { count, error } = await sb
    .from("live_cache")
    .select("*", { count: "exact", head: true })
    .limit(1);
  if (error) throw new Error(`live_cache: ${error.message}`);
  return { table: "live_cache", count: count ?? 0 };
}

async function deepChecks(origin: string) {
  // Hit internal public endpoints (no writes)
  const q = await fetch(`${origin}/api/quote_proxy?symbol=AAPL&force=true`, { cache: "no-store" }).then(r => r.json()).catch(() => null);
  const h = await fetch(`${origin}/api/history_proxy?symbol=AAPL&range=5d&interval=1d&force=true`, { cache: "no-store" }).then(r => r.json()).catch(() => null);

  const quoteOK = !!(q && q.ok === true && typeof q.price === "number");
  const histOK  = !!(h && h.ok === true && Array.isArray(h.rows) && h.rows.length > 0);

  return {
    quote: { ok: quoteOK, provider: q?.provider ?? null, err: quoteOK ? null : q },
    history: { ok: histOK, provider: h?.provider ?? null, err: histOK ? null : h }
  };
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;

  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const deep = url.searchParams.get("deep") === "true";
    const secret = url.searchParams.get("secret") || "";
    const requireSecret = deep; // only deep mode requires secret

    if (requireSecret) {
      const expected = process.env.HEALTH_SECRET || "";
      if (!expected) return withCORS(jsonErr("auth", "Server missing HEALTH_SECRET", 500), req);
      if (secret !== expected) return withCORS(jsonErr("auth", "Unauthorized", 401), req);
    }

    const env = {
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      ACTIONS_BEARER_TOKEN: !!process.env.ACTIONS_BEARER_TOKEN,
      WRITER_BEARER_TOKEN: !!process.env.WRITER_BEARER_TOKEN,
      HEALTH_SECRET: !!process.env.HEALTH_SECRET
    };

    // Shallow checks
    const supabasePing = await pingSupabase();
    let cachePing: any = null;
    try { cachePing = await pingCache(); } catch (e: any) { cachePing = { ok:false, error: String(e?.message || e) }; }

    let deepStatus: any = null;
    if (deep) {
      deepStatus = await deepChecks(origin);
    }

    // Decide HTTP status
    const healthy =
      env.SUPABASE_URL &&
      env.SUPABASE_SERVICE_ROLE_KEY &&
      env.WRITER_BEARER_TOKEN &&
      supabasePing &&
      (!deep || (deepStatus && deepStatus.quote.ok && deepStatus.history.ok));

    const payload = {
      ok: healthy,
      now: new Date().toISOString(),
      env,
      supabase: supabasePing,
      cache: cachePing,
      deep: deep ? deepStatus : undefined
    };

    return withCORS(
      new Response(JSON.stringify(payload), {
        status: healthy ? 200 : 503,
        headers: { "content-type": "application/json; charset=utf-8" }
      }),
      req
    );
  } catch (e: any) {
    return withCORS(jsonErr("health_top", e, 500), req);
  }
}
