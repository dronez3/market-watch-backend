import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

const POS = ["beat","beats","surge","up","gain","bull","strong","optimistic","positive","record","grow","growth"];
const NEG = ["miss","falls","down","drop","bear","weak","pessimistic","negative","cut","loss","decline","risk"];

/**
 * Direct-link news ingest + immediate sentiment recompute (no cron).
 * Example:
 * /api/news_ingest_link?token=TOKEN&symbol=AAPL&published_at=2025-08-26T13:00:00Z&title=CPI%20cools&source=Wire&url=https%3A%2F%2Fex.com&content=Headline...
 * Optional: &hours=72
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
  const lookbackHours = Number(url.searchParams.get("hours") || 72);

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

  const supabase = getServiceClient();

  // Insert the news item
  const { error: insErr } = await supabase.from("news_articles").insert([row]);
  if (insErr) return jsonResponse({ ok: false, stage: "insert_news", error: insErr.message }, 500);

  // Recompute sentiment immediately for this symbol over lookback window
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - lookbackHours * 3600 * 1000);

  const { data: articles, error: selErr } = await supabase
    .from("news_articles")
    .select("title, content")
    .eq("symbol", symbol)
    .gte("published_at", windowStart.toISOString())
    .lte("published_at", windowEnd.toISOString());

  if (selErr) return jsonResponse({ ok: true, inserted_news: 1, sentiment_updated: false, note: "select failed" });

  let scoreSum = 0, tokenCount = 0;
  for (const a of (articles || [])) {
    const text = `${a.title || ""} ${a.content || ""}`.toLowerCase();
    const tokens = text.split(/\W+/).filter(Boolean);
    tokenCount += tokens.length;
    for (const t of tokens) {
      if (POS.includes(t)) scoreSum += 1;
      if (NEG.includes(t)) scoreSum -= 1;
    }
  }
  const score = tokenCount > 0 ? scoreSum / tokenCount : 0;

  const { error: sentErr } = await supabase.from("sentiment_scores").insert({
    symbol,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    score,
    n_articles: (articles || []).length
  });

  return jsonResponse({
    ok: true,
    inserted_news: 1,
    sentiment_updated: !sentErr,
    score: Number(score.toFixed(3)),
    n_articles: (articles || []).length
  });
}
