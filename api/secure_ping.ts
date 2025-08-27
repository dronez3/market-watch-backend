import { jsonResponse, requireBearer } from "./_common";

export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  // TEMP: allow ?token=... for easy browser testing (remove later in Task 2)
  const url = new URL(req.url);
  const alt = url.searchParams.get("token");
  const expected = process.env.ACTIONS_BEARER_TOKEN;

  if (alt && expected && alt === expected) {
    return jsonResponse({ ok: true, route: "secure_ping", via: "query", msg: "Authorized" });
  }

  const auth = requireBearer(req);
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.err }, auth.status);
  return jsonResponse({ ok: true, route: "secure_ping", via: "header", msg: "Authorized" });
}
