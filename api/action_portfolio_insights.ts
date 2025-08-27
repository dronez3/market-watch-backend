export const config = { runtime: "edge" };

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

/**
 * GET /api/action_portfolio_insights?user=UUID&hours=72
 * Proxies -> /api/portfolio_insights_link with server-side token.
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const user = url.searchParams.get("user") || "";
  const hours = Number(url.searchParams.get("hours") || 72);
  const token = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!user) return json({ ok:false, error:"Missing ?user=UUID" }, 400);
  if (!token) return json({ ok:false, error:"Server missing ACTIONS_BEARER_TOKEN" }, 500);

  const origin = `${url.protocol}//${url.host}`;
  const tgt = `${origin}/api/portfolio_insights_link?token=${encodeURIComponent(token)}&user=${encodeURIComponent(user)}&hours=${encodeURIComponent(String(hours))}`;

  try {
    const r = await fetch(tgt, { cache: "no-store" });
    const data = await r.json().catch(() => null);
    return json(data ?? { ok:false, error:"Bad upstream response" }, r.status);
  } catch (e: any) {
    return json({ ok:false, stage:"fetch_upstream", error:String(e?.message || e) }, 500);
  }
}
