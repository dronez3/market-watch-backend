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
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
  ];

  let lastStatus = 0;
  let lastText = "";
  for (const u of urls) {
    const r = await fetch(u, { cache: "no-store", headers });
    lastStatus = r.status;
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) { try { lastText = await r.text(); } catch {} ; continue; }
    const j = ct.includes("application/json") ? await r.json() : null;
    const q = j?.quoteResponse?.result?.[0];
    if (q) {
      return {
        ok: true,
        symbol,
        price: q.regularMarketPrice ?? null,
        time: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
        currency: q.currency ?? null,
        name: q.shortName ?? q.longName ?? symbol,
        source: u.includes("query1") ? "yahoo-q1" : "yahoo-q2"
      };
    }
  }
  return { ok: false, stage: "yahooQuote", status: lastStatus, error: lastText || "no result" };
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;

  // 120 req/min/IP for quotes
  const limited = await rateGate(req, "quote_proxy", 120, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);
    let symbol: string;
    try { symbol = vSymbol(url.searchParams.get("symbol") || ""); }
    catch (e: any) { return withCORS(json({ ok:false, stage:"validate", error:String(e?.message || e) }, 400), req); }

    const res = await yahooQuote(symbol);
    if (!res.ok) return withCORS(json(res, 502), req);

    return withCORS(json(res), req);
  } catch (e: any) {
    return withCORS(json({ ok:false, stage:"top", error:String(e?.message || e) }, 502), req);
  }
}
