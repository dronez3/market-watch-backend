export const config = { runtime: "edge" };

import { withCORS, preflight } from "./_cors";
import { rateGate } from "./_rate";
import { cacheGet, cachePut } from "./_cache";
import { vSymbol } from "./_validate";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8" }
  });
}

type Article = {
  source: string;
  title: string;
  url: string;
  published_at: string | null;
  sentiment: number | null;
};

// Keep a tight whitelist of reputable domains
const TRUSTED = [
  "reuters.com", "apnews.com", "wsj.com", "ft.com",
  "cnbc.com", "marketwatch.com", "investors.com"
];

function isoHoursAgo(h: number) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

function hostOf(u: string): string {
  try { return new URL(u).hostname.replace(/^www\./,""); } catch { return ""; }
}

async function fetchMarketaux(symbol: string, hours: number, limit: number) {
  const key = process.env.MARKETAUX_API_KEY;
  if (!key) return { ok:false, stage:"marketaux", error:"no key" as const };
  const since = isoHoursAgo(hours);
  const domains = TRUSTED.join(",");
  const url =
    `https://api.marketaux.com/v1/news/all?symbols=${encodeURIComponent(symbol)}` +
    `&published_after=${encodeURIComponent(since)}&language=en&filter_entities=true` +
    `&limit=${limit}&api_token=${key}&domains=${encodeURIComponent(domains)}`;

  const r = await fetch(url, { cache:"no-store" });
  if (!r.ok) return { ok:false, stage:"marketaux", error:`status ${r.status}` as const };
  const j: any = await r.json().catch(() => null);
  const data: any[] = Array.isArray(j?.data) ? j.data : [];
  const articles: Article[] = data
    .map((a: any): Article => ({
      source: (a?.source as string) ?? hostOf((a?.url as string) || ""),
      title: (a?.title as string) ?? "",
      url: (a?.url as string) ?? "",
      published_at: (a?.published_at as string) ?? (a?.published_utc as string) ?? null,
      sentiment: Number.isFinite(a?.sentiment_score) ? Number(a.sentiment_score) : null
    }))
    .filter((art: Article) => !!art.url && TRUSTED.includes(hostOf(art.url)));
  return { ok:true as const, provider:"marketaux" as const, articles };
}

async function fetchNewsAPI(symbol: string, hours: number, limit: number) {
  const key = process.env.NEWSAPI_API_KEY;
  if (!key) return { ok:false, stage:"newsapi", error:"no key" as const };
  const since = isoHoursAgo(hours);
  const domains = TRUSTED.join(",");
  const url =
    `https://newsapi.org/v2/everything?q=${encodeURIComponent(symbol)}` +
    `&from=${encodeURIComponent(since)}&language=en&sortBy=publishedAt&pageSize=${limit}` +
    `&domains=${encodeURIComponent(domains)}`;

  const r = await fetch(url, { headers: { "X-Api-Key": key }, cache:"no-store" });
  if (!r.ok) return { ok:false, stage:"newsapi", error:`status ${r.status}` as const };
  const j: any = await r.json().catch(() => null);
  const data: any[] = Array.isArray(j?.articles) ? j.articles : [];
  const articles: Article[] = data
    .map((a: any): Article => ({
      source: (a?.source?.name as string) ?? hostOf((a?.url as string) || ""),
      title: (a?.title as string) ?? "",
      url: (a?.url as string) ?? "",
      published_at: (a?.publishedAt as string) ?? null,
      sentiment: null
    }))
    .filter((art: Article) => !!art.url && TRUSTED.includes(hostOf(art.url)));
  return { ok:true as const, provider:"newsapi" as const, articles };
}

async function fetchGDELT(symbol: string, hours: number, limit: number) {
  // GDELT v2 search
  const end = new Date();
  const start = new Date(Date.now() - hours * 3600 * 1000);
  function yyyymmddhhmmss(d: Date) {
    const pad = (n: number, w=2) => String(n).toString().padStart(w,"0");
    return d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate()) +
           pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds());
  }
  const url =
    `https://api.gdeltproject.org/api/v2/searchapi/search?query=${encodeURIComponent(symbol)}` +
    `&mode=ArtList&maxrecords=${limit}&startdatetime=${yyyymmddhhmmss(start)}` +
    `&enddatetime=${yyyymmddhhmmss(end)}&format=json`;

  const r = await fetch(url, { cache:"no-store" });
  if (!r.ok) return { ok:false, stage:"gdelt", error:`status ${r.status}` as const };
  const j: any = await r.json().catch(() => null);
  const data: any[] = Array.isArray(j?.articles) ? j.articles : (Array.isArray(j?.artList) ? j.artList : []);
  const articles: Article[] = data
    .map((a: any): Article => {
      const u: string = (a?.url as string) ?? (a?.seurl as string) ?? "";
      return {
        source: hostOf(u),
        title: (a?.title as string) || (a?.semtitle as string) || "",
        url: u,
        published_at: (a?.seendate as string) || (a?.date as string) || null,
        sentiment: null
      };
    })
    .filter((art: Article) => !!art.url && TRUSTED.includes(hostOf(art.url)));
  return { ok:true as const, provider:"gdelt" as const, articles };
}

function deDupe(list: Article[]): Article[] {
  const seen = new Set<string>();
  return list.filter((a: Article) => {
    const key = a.url.split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;

  // 60 requests per 60s per IP
  const limited = await rateGate(req, "news_proxy", 60, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);
    let symbol: string;
    try { symbol = vSymbol(url.searchParams.get("symbol") || ""); }
    catch (e: any) { return withCORS(json({ ok:false, stage:"validate", error:String(e?.message || e) }, 400), req); }

    const hours = Math.max(1, Math.min(Number(url.searchParams.get("hours") || 72), 240));
    const limit = Math.max(5, Math.min(Number(url.searchParams.get("limit") || 25), 50));
    const force = url.searchParams.get("force") === "true";
    const ttl = Math.max(30, Math.min(Number(url.searchParams.get("ttl") || 300), 3600)); // default 5m

    const key = `news:${symbol}:h=${hours}:n=${limit}`;
    if (!force) {
      const hit = await cacheGet<any>(key);
      if (hit.hit) return withCORS(json({ ok:true, cached:true, ...hit.value }), req);
    }

    // Provider chain: Marketaux → NewsAPI → GDELT
    const m = await fetchMarketaux(symbol, hours, limit);
    const n = (m as any).ok ? m : await fetchNewsAPI(symbol, hours, limit);
    const g = (n as any).ok ? n : await fetchGDELT(symbol, hours, limit);
    const res: any = (g as any).ok ? g : n;

    if (!res?.ok) return withCORS(json({ ok:false, stage:"providers_failed", marketaux:m, newsapi:n, gdelt:g }, 502), req);

    const arts = deDupe(res.articles as Article[]).slice(0, limit);
    const payload = { ok:true, provider: res.provider, symbol, count: arts.length, articles: arts };
    await cachePut(key, payload, ttl);
    return withCORS(json(payload), req);
  } catch (e: any) {
    return withCORS(json({ ok:false, stage:"top", error:String(e?.message || e) }, 502), req);
  }
}
