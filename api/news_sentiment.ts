export const config = { runtime: "edge" };

import { withCORS, preflight } from "./_cors";
import { rateGate } from "./_rate";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8" }
  });
}

// Tiny keyword model (fast, not magic). If your provider gives sentiment, we average that instead.
const POS = ["beat","beats","growth","surge","record","upgrade","raises","profit","outperform","strong","rally","win"];
const NEG = ["miss","misses","downgrade","cuts","cut","falls","fall","drop","plunge","loss","lawsuit","weak","recall","probe"];

function scoreText(t: string) {
  const s = (t || "").toLowerCase();
  let sc = 0;
  for (const w of POS) if (s.includes(w)) sc += 1;
  for (const w of NEG) if (s.includes(w)) sc -= 1;
  return sc;
}

function bucket(x: number) { return x > 0.5 ? "positive" : x < -0.5 ? "negative" : "neutral"; }

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;

  const limited = await rateGate(req, "news_sentiment", 60, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
    const hours = Math.max(1, Math.min(Number(url.searchParams.get("hours") || 72), 240));

    // Reuse your news_proxy (no token, safe)
    const origin = `${url.protocol}//${url.host}`;
    const r = await fetch(`${origin}/api/news_proxy?symbol=${encodeURIComponent(symbol)}&hours=${hours}`, { cache:"no-store" });
    const j = await r.json().catch(() => null);
    if (!j?.ok) return withCORS(json({ ok:false, stage:"news_proxy", error:j?.error || "news fail" }, 502), req);

    const arts = Array.isArray(j.articles) ? j.articles : [];
    if (!arts.length) return withCORS(json({ ok:true, symbol, count:0, score:0, bucket:"neutral", top_headlines: [] }), req);

    // Prefer provider sentiment if present
    const providerScores = arts.map((a: any) => Number(a.sentiment)).filter((n: any) => Number.isFinite(n));
    let score: number;
    if (providerScores.length) {
      score = providerScores.reduce((x:any,y:any)=>x+y,0) / providerScores.length; // already roughly -1..+1 on Marketaux
    } else {
      // Keyword model: normalize to ~ -1..+1 by dividing by article count
      const sum = arts.map((a: any) => scoreText(a.title || "")).reduce((x:number,y:number)=>x+y, 0);
      score = sum / Math.max(arts.length, 1);
    }

    const out = {
      ok: true,
      symbol,
      count: arts.length,
      score: Number(score.toFixed(2)),
      bucket: bucket(score),
      top_headlines: arts.slice(0,5).map((a:any) => ({ source:a.source, title:a.title, url:a.url, published_at:a.published_at }))
    };
    return withCORS(json(out), req);
  } catch (e: any) {
    return withCORS(json({ ok:false, stage:"top", error:String(e?.message || e) }, 502), req);
  }
}
