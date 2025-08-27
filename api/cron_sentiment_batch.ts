import { jsonResponse } from "./_common";

export const config = { runtime: "edge" };

/**
 * Cron proxy: calls the existing batch-link endpoint you already tested.
 * Auth:
 *  - Vercel Cron: header `x-vercel-cron` present -> allowed
 *  - Manual test: require ?token=ACTIONS_BEARER_TOKEN
 *
 * Optional overrides:
 *   ?symbols=AAPL,TSLA&hours=48
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const hasCronHeader = req.headers.has("x-vercel-cron");

  const tokenEnv = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!tokenEnv) return jsonResponse({ ok: false, error: "Missing ACTIONS_BEARER_TOKEN" }, 500);

  // If not invoked by Vercel Cron, enforce token in query for manual tests
  if (!hasCronHeader) {
    const tokenParam = url.searchParams.get("token") || "";
    if (tokenParam !== tokenEnv) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const base = (process.env.SELF_BASE_URL || "https://market-watch-backend.vercel.app").replace(/\/+$/, "");
  const symbols = (url.searchParams.get("symbols") || process.env.CRON_SYMBOLS || "AAPL,TSLA,NVDA,MSFT,SPY,QQQ").toUpperCase();
  const hours = url.searchParams.get("hours") || process.env.CRON_LOOKBACK_HOURS || "72";

  const proxied = `${base}/api/sentiment_rollup_batch_link?token=${encodeURIComponent(tokenEnv)}&symbols=${encodeURIComponent(symbols)}&hours=${encodeURIComponent(hours)}`;

  try {
    const r = await fetch(proxied);
    const data = await r.json();
    return jsonResponse({ ok: true, via: "proxy", proxied, data });
  } catch (e: any) {
    return jsonResponse({ ok: false, stage: "fetch_proxy", proxied, error: String(e?.message || e) }, 500);
  }
}
