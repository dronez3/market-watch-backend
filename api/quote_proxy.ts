export const config = { runtime: "edge" };

import { withCORS, preflight } from "./_cors";
import { rateGate } from "./_rate";
import { vSymbol } from "./_validate";
import { cacheGet, cachePut } from "./_cache";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

async function yahooQuote(symbol: string) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; MarketWatchBot/1.0)",
    "Accept": "application/json",
  };
  const urls = [
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`
  ];
  let lastStatus = 0, lastText = "";
  for (const u of urls) {
    const r = await fetch(u, { cache: "no-store", headers });
    lastStatus = r.status;
    if (!r.ok) { try { lastText = await r.text(); } catch {} ; continue; }
    let j: any = null;
    try { j = await r.json(); } catch {}
    const q = j?.quoteResponse?.result?.[0];
    if (!q) continue;
    return {
      ok: true,
      provider: u.includes("query1") ? "yahoo-q1" : "yahoo-q2",
      name: q.shortName ?? q.longName ?? symbol,
      symbol,
      price: q.regularMarketPrice ?? null,
      time: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
      currency: q.currency ?? null
    };
  }
  return { ok:false, stage:"yahooQuote", status:lastStatus, error:lastText || "no result" };
}

// Stooq fallbacks (as before)
async function stooqLineQuote(symbol: string) {
  const variants = [symbol, symbol + ".US", symbol.toLowerCase(), symbol.toLowerCase() + ".us"];
  for (const s of variants) {
    const u = `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&i=d`;
    const r = await fetch(u, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketWatchBot/1.0)" } });
    const text = (await r.text()).trim();
    const line = text.split("\n").slice(-1)[0] || "";
    if (!line || line.toLowerCase().startsWith("symbol,")) continue;
    const parts = line.split(",");
    if (parts.length < 7) continue;
    const close = Number((parts[5] || "").replace(",", "."));
    if (!Number.isFinite(close)) continue;
    const dt = parts[1];
    return {
      ok: true,
      provider: "stooq-line",
      name: symbol,
      symbol,
      price: close,
      time: /\d{4}-\d{2}-\d{2}/.test(dt) ? `${dt}T21:00:00Z` : null,
      currency: "USD"
    };
  }
  return { ok:false, stage:"stooqLine", error:"no variant with numeric close" };
}
async function stooqDailyQuote(symbol: string) {
  const variants = [symbol, symbol + ".US", symbol.toLowerCase(), symbol.toLowerCase() + ".us"];
  for (const s of variants) {
    const u = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;
    const r = await fetch(u, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketWatchBot/1.0)" } });
    const text = (await r.text()).trim();
    const lines = text.split("\n");
    if (lines.length < 2) continue;
    const last = lines[lines.length - 1];
    const parts = last.split(",");
    if (parts.length < 6) continue;
    const dt = parts[0];
    const close = Number((parts[4] || "").replace(",", "."));
    if (!Number.isFinite(close)) continue;
    return {
      ok: true,
      provider: "stooq-daily",
      name: symbol,
      symbol,
      price: close,
      time: /\d{4}-\d{2}-\d{2}/.test(dt) ? `${dt}T21:00:00Z` : null,
      currency: "USD"
    };
  }
  return { ok:false, stage:"stooqDaily", error:"no variant with numeric close" };
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;
  const limited = await rateGate(req, "quote_proxy", 120, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);
    let symbol: string;
    try { symbol = vSymbol(url.searchParams.get("symbol") || ""); }
    catch (e: any) { return withCORS(json({ ok:false, stage:"validate", error:String(e?.message || e) }, 400), req); }

    // TTL controls
    const force = url.searchParams.get("force") === "true";      // bypass cache
    const ttl   = Math.max(1, Math.min(Number(url.searchParams.get("ttl") || 15), 300)); // default 15s

    const key = `quote:${symbol}`;
    if (!force) {
      const hit = await cacheGet<any>(key);
      if (hit.hit) return withCORS(json({ ok:true, cached:true, ...hit.value }), req);
    }

    // Provider fetch: Yahoo -> Stooq line -> Stooq daily
    const y = await yahooQuote(symbol);
    const payload = y.ok ? y : (await stooqLineQuote(symbol)).ok ? await stooqLineQuote(symbol) : await stooqDailyQuote(symbol);
    if (!(payload as any).ok) return withCORS(json({ ok:false, stage:"both_failed", yahoo:y }, 502), req);

    // Cache & return
    await cachePut(key, payload, ttl);
    return withCORS(json(payload), req);
  } catch (e: any) {
    return withCORS(json({ ok:false, stage:"top", error:String(e?.message || e) }, 502), req);
  }
}
