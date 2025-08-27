export const config = { runtime: "edge" };

import { withCORS, preflight } from "./_cors";
import { rateGate } from "./_rate";
import { vSymbol } from "./_validate";
import { getServiceClient } from "./_supabase";

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

type Range = "5d" | "1mo" | "3mo" | "6mo" | "1y" | "2y";
type Interval = "1d" | "1wk";

function sanitizeRange(raw: string | null): Range {
  const r = (raw || "6mo") as Range;
  const ok: Range[] = ["5d","1mo","3mo","6mo","1y","2y"];
  if (!ok.includes(r)) throw new Error("Bad range");
  return r;
}
function sanitizeInterval(raw: string | null): Interval {
  const i = (raw || "1d") as Interval;
  const ok: Interval[] = ["1d","1wk"];
  if (!ok.includes(i)) throw new Error("Bad interval");
  return i;
}

async function yahooHistory(symbol: string, range: Range, interval: Interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div,splits`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`yahoo status ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error("yahoo empty");

  const ts: number[] = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const o: number[] = q.open || [];
  const h: number[] = q.high || [];
  const l: number[] = q.low || [];
  const c: number[] = q.close || [];
  const v: number[] = q.volume || [];

  const rows = ts.map((t, i) => ({
    t: new Date(t * 1000).toISOString(),
    open: o[i] ?? null,
    high: h[i] ?? null,
    low:  l[i] ?? null,
    close: c[i] ?? null,
    volume: v[i] ?? null
  })).filter(r => r.close != null);

  return { rows, meta: { range, interval, tz: res.meta?.exchangeTimezoneName ?? null, source: "yahoo" } };
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;

  // 60 req/min/IP for history
  const limited = await rateGate(req, "history_proxy", 60, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);

    let symbol: string;
    try { symbol = vSymbol(url.searchParams.get("symbol") || ""); }
    catch (e: any) { return withCORS(json({ ok:false, error:String(e?.message || e) }, 400), req); }

    let range: Range, interval: Interval;
    try {
      range = sanitizeRange(url.searchParams.get("range"));
      interval = sanitizeInterval(url.searchParams.get("interval"));
    } catch (e: any) {
      return withCORS(json({ ok:false, error:String(e?.message || e) }, 400), req);
    }

    const { rows, meta } = await yahooHistory(symbol, range, interval);

    // Optional upsert into daily_agg (only for 1d interval) when explicitly requested
    const doUpsert = url.searchParams.get("upsert") === "true" && interval === "1d";
    let upserted = 0;
    if (doUpsert) {
      const token = url.searchParams.get("token") || "";
      const expected = process.env.WRITER_BEARER_TOKEN || "";
      if (!expected) return withCORS(json({ ok:false, error:"Server missing WRITER_BEARER_TOKEN" }, 500), req);
      if (token !== expected) return withCORS(json({ ok:false, error:"Unauthorized" }, 401), req);

      // Map candles into daily_agg rows (UTC date from ISO timestamp)
      const dailyRows = rows.map(r => ({
        symbol,
        date: r.t.slice(0,10), // YYYY-MM-DD
        open:  r.open,
        high:  r.high,
        low:   r.low,
        close: r.close,
        volume: r.volume ?? null
      }));

      const supabase = getServiceClient();
      const { error } = await supabase.from("daily_agg")
        .upsert(dailyRows, { onConflict: "symbol,date" });
      if (error) return withCORS(json({ ok:false, stage:"upsert", error:error.message }, 500), req);
      upserted = dailyRows.length;
    }

    return withCORS(json({ ok:true, symbol, meta, count: rows.length, upserted, rows }), req);
  } catch (e: any) {
    return withCORS(json({ ok:false, error:String(e?.message || e) }, 502), req);
  }
}
