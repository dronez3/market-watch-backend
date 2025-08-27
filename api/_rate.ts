import { getServiceClient } from "./_supabase";

// Extract client IP from common proxy headers (Vercel/Edge)
function clientIP(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * rateGate: simple per-IP sliding-window limiter.
 * - key: logical bucket name (e.g., "scorecard_plus", "csv_compare")
 * - limit: max requests allowed within windowSec
 * - windowSec: window length in seconds
 *
 * Returns:
 *  - Response (429) if over limit
 *  - null if allowed (and logs this hit)
 */
export async function rateGate(req: Request, key: string, limit = 60, windowSec = 60) {
  const ip = clientIP(req);
  const now = new Date();
  const since = new Date(now.getTime() - windowSec * 1000).toISOString();

  const supabase = getServiceClient();

  // Count recent events
  const { count } = await supabase
    .from("rate_gate")
    .select("*", { count: "exact", head: true })
    .eq("k", key)
    .eq("ip", ip)
    .gte("ts", since);

  if ((count ?? 0) >= limit) {
    return new Response(JSON.stringify({
      ok: false,
      error: "rate_limited",
      key,
      limit,
      window_sec: windowSec,
      retry_after_sec: windowSec
    }), {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(windowSec)
      }
    });
  }

  // Record this hit
  await supabase.from("rate_gate").insert({ ip, k: key });

  // Opportunistic cleanup (≈2%) to keep table tidy
  if (Math.random() < 0.02) {
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
    await supabase.from("rate_gate").delete().lt("ts", dayAgo);
  }

  return null; // allowed
}
