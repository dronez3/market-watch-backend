import { jsonResponse, requireBearer } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

type News = {
  symbol: string;
  published_at: string; // ISO
  source?: string; title: string; url?: string; content?: string;
};

const POS = ["beat","beats","surge","up","gain","bull","strong","optimistic","positive","record","grow","growth"];
const NEG = ["miss","falls","down","drop","bear","weak","pessimistic","negative","cut","loss","decline","risk"];

export default async function handler(req: Request) {
  const auth = requireBearer(req);
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.err }, auth.status);
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Use POST" }, 405);

  let body: { items: News[]; lookback_hours?: number } | null = null;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400); }

  const items = body?.items || [];
  const lookbackHours = Number(body?.lookback_hours ?? 72);
  if (!Array.isArray(items) || items.length === 0) {
    return jsonResponse({ ok: false, error: "Provide { items: News[] }" }, 400);
  }

  const supabase = getServiceClient();

  // Insert news
  const rows = items.map(n => ({
    symbol: n.symbol.toUpperCase(),
    published_at: new Date(n.published_at).toISOString(),
    source: n.source ?? null,
    title: n.title,
    url: n.url ?? null,
    content: n.content ?? null
  }));

  const { error: insErr } = await supabase.from("news_articles").insert(rows);
  if (insErr) return jsonResponse({ ok: false, stage: "insert_news", error: insErr.message }, 500);

  // Recompute sentiment for each affected symbol (last 72h default)
  const affected = Array.from(new Set(rows.map(r => r.symbol)));
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - lookbackHours * 3600 * 1000);

  let updated = 0;
  for (const symbol of affected) {
    const { data: articles, error: selErr } = await supabase
      .from("news_articles")
      .select("title, content")
      .eq("symbol", symbol)
      .gte("published_at", windowStart.toISOString())
      .lte("published_at", windowEnd.toISOString());

    if (selErr) continue;

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
    if (!sentErr) updated++;
  }

  return jsonResponse({ ok: true, inserted_news: rows.length, updated_symbols: updated, symbols: affected });
}
