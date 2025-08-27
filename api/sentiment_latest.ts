import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  if (!symbol) return jsonResponse({ ok: false, error: "Provide ?symbol=XXX" }, 400);

  const supabase = getAnonClient();
  const { data, error } = await supabase
    .from("sentiment_scores")
    .select("window_end, score, n_articles")
    .eq("symbol", symbol)
    .order("window_end", { ascending: false })
    .limit(1);

  if (error) return jsonResponse({ ok: false, error: error.message }, 500);
  if (!data || data.length === 0) return jsonResponse({ ok: true, symbol, found: false });

  return jsonResponse({ ok: true, symbol, found: true, latest: data[0] });
}
