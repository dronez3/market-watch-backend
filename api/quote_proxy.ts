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

// Fallback: Stooq single-line CSV (latest daily quote)
// https://stooq.com/q/l/?s=aapl&i=d
async function stooqQuote(symbol: string) {
  const u = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const r = await fetch(u, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketWatchBot/1.0)" } });
  const text = await r.text();
  // CSV looks like: "symbol,datetime,open,high,low,close,volume"
  // e.g. "AAPL.US,2025-08-26,232.00,235.12,231.70,234.56,45678900"
  const line = text.trim().split("\n").pop() || "";
  const parts = line.split(",");
  if (parts.length < 7) return { ok:false, stage:"stooqQuote", status:r.status, error:"unexpected format" };
  const close = Number(parts[5]);
  if (!Number.isFinite(close)) return { ok:false, stage:"stooqQuote", status:r.status, error:"no close" };
  const dt = parts[1];
  return {
    ok: true,
    provider: "stooq",
    name: symbol,
    symbol,
    price: close,
    time: /\d{4}-\d{2}-\d{2}/.test(dt) ? `${dt}T21:00:00Z` : null,
    currency: "USD"
  };
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;

  // generous limit for quotes
  const limited = await rateGate(req, "quote_proxy", 120, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);
    let symbol: string;
    try { symbol = vSymbol(url.searchParams.get("symbol") || ""); }
    catch (e: any) { return withCORS(json({ ok:false, stage:"validate", error:String(e?.message || e) }, 400), req); }

    // Try Yahoo, then Stooq
    const y = await yahooQuote(symbol);
    if (y.ok) return withCORS(json(y), req);

    const s = await stooqQuote(symbol);
    if (s.ok) return withCORS(json(s), req);

    // Both failed
    return withCORS(json({ ok:false, stage:"both_failed", yahoo:y, stooq:s }, 502), req);
  } catch (e: any) {
    return withCORS(json({ ok:false, stage:"top", error:String(e?.message || e) }, 502), req);
  }
}
