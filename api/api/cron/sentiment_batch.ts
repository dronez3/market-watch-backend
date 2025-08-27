import { jsonResponse } from "../_common";
import { getServiceClient } from "../_supabase";

export const config = { runtime: "edge" };

/**
 * Vercel Cron entrypoint for batch sentiment.
 * Auth:
 *  - Production cron: request includes "x-vercel-cron" header (Vercel-managed).
 *  - Manual test (browser): provide ?token=ACTIONS_BEARER_TOKEN
 *
 * Inputs:
 *  - From env:
 *      CRON_SYMBOLS="AAPL,TSLA,NVDA,MSFT,SPY,QQQ"
 *      CRON_LOOKBACK_HOURS="72"
 *  - Optional overrides (query):
 *      ?symbols=AAPL,TSLA&hours=48
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const hasCronHeader = req.headers.has("x-vercel-cron");
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";

  // Allow either Vercel Cron header OR manual token for testing
  if (!hasCronHeader) {
    if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
    if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const envSyms = (process.env.CRON_SYMBOLS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const paramSyms = (url.searchParams.get("symbols") || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const symbols = (paramSyms.length ? paramSyms : envSyms);

  if (!symbols.length) {
    return jsonResponse({ ok: false, error: "No symbols configured. Set CRON_SYMBOLS or use ?symbols=AAPL,TSLA" }, 400);
  }

  const hours = Number(url.searchParams.get("hours") || process.env.CRON_LOOKBACK_HOURS || 72);
  const supabase = getServiceClient();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - hours * 3600 * 1000);

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

    await supabase.from("sentiment_scores").insert({
      symbol,
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      score,
      n_articles: articles?.length ?? 0
    });

    results.push({ symbol, n_articles: articles?.length ?? 0, score: Number(score.toFixed(3)) });
  }

  return jsonResponse({ ok: true, window_hours: hours, symbols, results });
}
