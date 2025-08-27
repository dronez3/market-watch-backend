import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * TEMP: Direct-link news ingest.
 * Example:
 * /api/news_ingest_link?token=TOKEN&symbol=AAPL&published_at=2025-08-26T13:00:00Z&title=CPI%20cools%20again&source=ExampleWire&url=https%3A%2F%2Fexample.com%2Fmacro%2Fcpi-cools&content=Headline%20easing%3B%20goods%20deflation
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const published_at = url.searchParams.get("published_at") || "";
  const title = url.searchParams.get("title") || "";
  const source = url.searchParams.get("source");
  const link = url.searchParams.get("url");
  const content = url.searchParams.get("content");

  if (!symbol || !published_at || !title) {
    return jsonResponse({ ok: false, error: "Missing required params: symbol, published_at, title" }, 400);
  }

  const row = {
    symbol,
    published_at: new Date(published_at).toISOString(),
    source: source ?? null,
    title,
    url: link ?? null,
    content: content ?? null
  };

  try {
    const supabase = getServiceClient();
    const { data, error } = await supabase.from("news_articles").insert([row]).select();
    if (error) return jsonResponse({ ok: false, stage: "insert", error: error.message }, 500);
    return jsonResponse({ ok: true, count: data?.length ?? 1, item: data?.[0] ?? row });
  } catch (e: any) {
    return jsonResponse({ ok: false, stage: "exception", error: String(e?.message || e) }, 500);
  }
}
