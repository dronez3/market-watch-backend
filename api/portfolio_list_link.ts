import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * List holdings for a user (direct-link).
 * /api/portfolio_list_link?token=TOKEN&user=UUID
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const user = url.searchParams.get("user") || "";
  if (!user) return jsonResponse({ ok: false, error: "Missing ?user=UUID" }, 400);

  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("user_portfolio")
    .select("symbol, shares, cost_basis")
    .eq("user_id", user)
    .order("symbol");

  if (error) return jsonResponse({ ok: false, stage: "select", error: error.message }, 500);
  return jsonResponse({ ok: true, user, holdings: data || [] });
}
