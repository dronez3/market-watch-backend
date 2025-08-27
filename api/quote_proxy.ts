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
  const u = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`yahoo status ${r.status}`);
  const j = await r.json();
  const q = j?.quoteResponse?.result?.[0];
  if (!q) throw new Error("yahoo empty");
  return {
    price: q.regularMarketPrice ?? null,
    time: q.regularMarketTime ? new Date(q.regularMarketTime * 1000).toISOString() : null,
    currency: q.currency ?? null,
    name: q.shortName ?? q.longName ?? symbol,
    source: "yahoo"
  };
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;

  // 120 req/min/IP for quotes
  const limited = await rateGate(req, "quote_proxy", 120, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);
    let symbol: string;
    try {
      symbol = vSymbol(url.searchParams.get("symbol") || "");
    } catch (e: any) {
      return withCORS(json({ ok:false, error:String(e?.message || e) }, 400), req);
    }

    const q = await yahooQuote(symbol);

    return withCORS(json({ ok:true, symbol, ...q }), req);
  } catch (e: any) {
    return withCORS(json({ ok:false, error:String(e?.message || e) }, 502), req);
  }
}
