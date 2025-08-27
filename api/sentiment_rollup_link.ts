import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * TEMP direct-link variant for browser testing.
 * Usage:
 * /api/sentiment_rollup_link?token=YOUR_TOKEN&symbol=AAPL&hours=72
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const lookbackHours = Number(url.searchParams.get("hours") || 72);
  if (!symbol) return jsonResponse({ ok: false, error: "Missing symbol" }, 400);

  const supabase = getServiceClient();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - lookbackHours * 3600 * 1000);

  const { data: articles, error: selErr } = await supabase
    .from("news_articles")
    .select("title, content")
    .eq("symbol", symbol)
    .gte("published_at", windowStart.toISOString())
    .lte("published_at", windowEnd.toISOString());

  if (selErr) return jsonResponse({ ok: false, stage: "select", error: selErr.message }, 500);

  const positive = ["beat", "beats", "surge", "up", "gain", "bull", "strong", "optimistic", "positive", "record", "grow", "growth"];
  const negative = ["miss", "falls", "down", "drop", "bear", "weak", "pessimistic", "negative", "cut", "loss", "decline", "risk"];

  let scoreSum = 0; let tokenCount = 0;
  for (const a of (articles || [])) {
    const text = `${a.title || ""} ${a.content || ""}`.toLowerCase();
    const tokens = text.split(/\W+/).filter(Boolean);
    tokenCount += tokens.length;
    for (const t of tokens) {
      if (positive.includes(t)) scoreSum += 1;
      if (negative.includes(t)) scoreSum -= 1;
    }
  }
  const score = tokenCount > 0 ? scoreSum / tokenCount : 0;

  const { error: insErr } = await supabase.from("sentiment_scores").insert({
    symbol,
    window_start: windowStart.toISOString(),
    window_end: windowEnd.toISOString(),
    score,
    n_articles: articles?.length ?? 0
  });
  if (insErr) return jsonResponse({ ok: false, stage: "insert", error: insErr.message }, 500);

  return jsonResponse({
    ok: true,
    symbol,
    window_hours: lookbackHours,
    n_articles: articles?.length ?? 0,
    score: Number(score.toFixed(3))
  });
}
