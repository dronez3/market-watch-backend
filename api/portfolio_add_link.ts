import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Upsert one holding for a user (direct-link).
 * Required query params:
 *   token=...  (ACTIONS_BEARER_TOKEN)
 *   user=UUID  (portfolio owner)
 *   symbol=TSLA
 * Optional:
 *   shares=10.5
 *   cost_basis=245.25
 *
 * Example:
 * /api/portfolio_add_link?token=TOKEN&user=7e4b9c4b-9af2-4d8e-9b9b-1d3e2a6f0f11&symbol=AAPL&shares=5&cost_basis=220
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const user = url.searchParams.get("user") || "";
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const shares = url.searchParams.get("shares");
  const cost = url.searchParams.get("cost_basis");

  if (!user || !symbol) {
    return jsonResponse({ ok: false, error: "Missing required params: user, symbol" }, 400);
  }

  const payload = {
    user_id: user, // must be a valid UUID per schema
    symbol,
    shares: shares != null ? Number(shares) : null,
    cost_basis: cost != null ? Number(cost) : null
  };

  try {
    const supabase = getServiceClient();
    const { error } = await supabase
      .from("user_portfolio")
      .upsert(payload, { onConflict: "user_id,symbol" });

    if (error) return jsonResponse({ ok: false, stage: "upsert", error: error.message }, 500);
    return jsonResponse({ ok: true, upserted: payload });
  } catch (e: any) {
    return jsonResponse({ ok: false, stage: "exception", error: String(e?.message || e) }, 500);
  }
}
