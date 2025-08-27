export const config = { runtime: "edge" };

import { withCORS, preflight } from "./_cors";
import { rateGate } from "./_rate";
import { vSymbol } from "./_validate";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

type Headline = { source: string; title: string; url: string; published_at: string | null };

function getClose(row: any): number | null {
  if (!row || typeof row !== "object") return null;
  const lc: Record<string, any> = {};
  for (const k of Object.keys(row)) lc[k.toLowerCase()] = (row as any)[k];
  return [lc.close, lc.c, lc.adj_close, lc.adjustedclose, lc.price, lc.last]
    .map((x) => (Number.isFinite(x) ? Number(x) : null))
    .find((x) => x !== null) ?? null;
}

export default async function handler(req: Request) {
  const pf = preflight(req);
  if (pf) return pf;

  // 30 req / 60s / IP for this composite endpoint
  const limited = await rateGate(req, "why_proxy", 30, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);
    let symbol: string;
    try {
      symbol = vSymbol(url.searchParams.get("symbol") || "");
    } catch (e: any) {
      return withCORS(json({ ok: false, stage: "validate", error: String(e?.message || e) }, 400), req);
    }

    const horizon = Number(url.searchParams.get("horizon_days") || 5);
    const hours = Number(url.searchParams.get("hours") || 72);
    const origin = `${url.protocol}//${url.host}`;

    // Fetch in parallel (no writes, no secrets)
    const [qRes, hRes, nsRes, newsRes, pRes, erRes] = await Promise.all([
      fetch(`${origin}/api/quote_proxy?symbol=${encodeURIComponent(symbol)}&force=true`, { cache: "no-store" }).then(r => r.json()).catch(() => null),
      fetch(`${origin}/api/history_proxy?symbol=${encodeURIComponent(symbol)}&range=5d&interval=1d`, { cache: "no-store" }).then(r => r.json()).catch(() => null),
      fetch(`${origin}/api/news_sentiment?symbol=${encodeURIComponent(symbol)}&hours=${hours}`, { cache: "no-store" }).then(r => r.json()).catch(() => null),
      fetch(`${origin}/api/news_proxy?symbol=${encodeURIComponent(symbol)}&hours=${hours}&limit=5`, { cache: "no-store" }).then(r => r.json()).catch(() => null),
      fetch(`${origin}/api/prob?symbol=${encodeURIComponent(symbol)}&horizon_days=${horizon}`, { cache: "no-store" }).then(r => r.json()).catch(() => null),
      fetch(`${origin}/api/expected_return?symbol=${encodeURIComponent(symbol)}&horizon_days=${horizon}&lookback_days=90`, { cache: "no-store" }).then(r => r.json()).catch(() => null)
    ]);

    const price: number | null = Number.isFinite(qRes?.price) ? Number(qRes.price) : null;
    const prevClose: number | null = (() => {
      const rows: any[] = Array.isArray(hRes?.rows) ? hRes.rows : [];
      if (!rows.length) return null;
      const last = rows[rows.length - 1];
      return getClose(last);
    })();

    const change_abs = price !== null && prevClose !== null ? Number((price - prevClose).toFixed(2)) : null;
    const change_pct = price !== null && prevClose !== null && prevClose !== 0
      ? Number((((price - prevClose) / prevClose) * 100).toFixed(2))
      : null;

    const probability_up: number | null =
      Number.isFinite(pRes?.probability_up) ? Number(pRes.probability_up) : null;

    const er = erRes || {};
    const expected_return = ((): { er: number | null; low: number | null; high: number | null } => {
      const cand = [
        { er: er.expected_return, low: er.low, high: er.high },
        { er: er.value, low: er.lo, high: er.hi }
      ].find(x => [x.er, x.low, x.high].some(v => Number.isFinite(v)));
      return {
        er: Number.isFinite(cand?.er) ? Number(cand.er) : null,
        low: Number.isFinite(cand?.low) ? Number(cand.low) : null,
        high: Number.isFinite(cand?.high) ? Number(cand.high) : null
      };
    })();

    const sentiment = {
      score: Number.isFinite(nsRes?.score) ? Number(nsRes.score) : 0,
      bucket: typeof nsRes?.bucket === "string" ? nsRes.bucket : "neutral",
      count: Number.isFinite(nsRes?.count) ? Number(nsRes.count) : 0
    };

    const top_headlines: Headline[] = Array.isArray(newsRes?.articles)
      ? newsRes.articles.slice(0, 5).map((a: any) => ({
          source: String(a?.source ?? ""),
          title: String(a?.title ?? ""),
          url: String(a?.url ?? ""),
          published_at: a?.published_at ?? null
        }))
      : [];

    return withCORS(
      json({
        ok: true,
        symbol,
        price,
        prev_close: prevClose,
        change_abs,
        change_pct,
        probability_up,
        expected_return,
        news_sentiment: sentiment,
        top_headlines,
        providers: {
          quote: qRes?.provider ?? null,
          news: newsRes?.provider ?? null
        }
      }),
      req
    );
  } catch (e: any) {
    return withCORS(json({ ok: false, stage: "top", error: String(e?.message || e) }, 502), req);
  }
}
