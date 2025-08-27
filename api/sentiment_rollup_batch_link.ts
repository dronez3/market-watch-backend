import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Direct-link batch sentiment rollup for multiple symbols.
 * Usage:
 * /api/sentiment_rollup_batch_link?token=YOUR_TOKEN&symbols=AAPL,TSLA,NVDA&hours=72
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const symbolsParam = url.searchParams.get("symbols") || "";
  const lookbackHours = Number(url.searchParams.get("hours") || 72);

  const symbols = symbolsParam
    .split(",")
    .map(s => s.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) {
    return jsonResponse({ ok: false, error: "Provide ?symbols=AAPL,TSLA,...", example: "?symbols=AAPL,TSLA,NVDA&hours=72" }, 400);
  }

  const supabase = getServiceClient();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - lookbackHours * 3600 * 1000);

  const positive = ["beat","beats","surge","up","gain","bull","strong","optimistic","positive","record","grow","growth"];
  const negative = ["miss","falls","down","drop","bear","weak","pessimistic","negative","cut","loss","decline","risk"];

  const results: Array<{symbol:string;n_articles:number;score:number}> = [];

  for (const symbol of symbols) {
    const { data: articles, error: selErr } = await supabase
      .from("news_articles")
      .select("title, content")
      .eq("symbol", symbol)
      .gte("published_at", windowStart.toISOString())
      .lte("published_at", windowEnd.toISOString());

    if (selErr) {
      results.push({ symbol, n_articles: 0, score: 0 });
      continue;
    }

    let scoreSum = 0, tokenCount = 0;
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

    if (insErr) {
      results.push({ symbol, n_articles: articles?.length ?? 0, score: 0 });
    } else {
      results.push({ symbol, n_articles: articles?.length ?? 0, score: Number(score.toFixed(3)) });
    }
  }

  return jsonResponse({
    ok: true,
    window_hours: lookbackHours,
    results
  });
}
