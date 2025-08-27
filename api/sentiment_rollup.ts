import { jsonResponse, requireBearer } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Computes a simple sentiment score over a lookback window and writes to sentiment_scores.
 * Scoring: naive keyword approach (+1 for positive word, -1 for negative word) / tokens
 * Inputs (JSON body):
 *  - symbol: string
 *  - lookback_hours?: number (default 72)
 */
export default async function handler(req: Request) {
  const auth = requireBearer(req);
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.err }, auth.status);
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Use POST" }, 405);

  let body: { symbol: string; lookback_hours?: number } | null = null;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400); }

  const symbol = (body?.symbol || "").toUpperCase();
  const lookbackHours = Number(body?.lookback_hours ?? 72);
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

  // Very naive keyword bag (you can replace later with a model)
  const positive = ["beat", "beats", "surge", "up", "gain", "bull", "strong", "optimistic", "positive", "record", "grow", "growth"];
  const negative = ["miss", "falls", "down", "drop", "bear", "weak", "pessimistic", "negative", "cut", "loss", "decline", "risk"];

  let scoreSum = 0;
  let tokenCount = 0;

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
