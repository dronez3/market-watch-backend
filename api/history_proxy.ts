export const config = { runtime: "edge" };

import { withCORS, preflight } from "./_cors";
import { rateGate } from "./_rate";
import { vSymbol } from "./_validate";
import { getServiceClient } from "./_supabase";
import { cacheGet, cachePut } from "./_cache";

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
function daysForRange(r: Range): number {
  return r === "5d" ? 5 : r === "1mo" ? 31 : r === "3mo" ? 93 : r === "6mo" ? 186 : r === "1y" ? 365 : 730;
}

async function yahooHistory(symbol: string, range: Range, interval: Interval) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; MarketWatchBot/1.0)",
    "Accept": "application/json",
  };
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div,splits`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div,splits`,
  ];
  let lastStatus = 0, lastText = "";
  for (const u of urls) {
    const r = await fetch(u, { cache: "no-store", headers });
    lastStatus = r.status;
    if (!r.ok) { try { lastText = await r.text(); } catch {} ; continue; }
    let j: any = null;
    try { j = await r.json(); } catch {}
    const res = j?.chart?.result?.[0];
    if (!res) continue;

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

    return { ok:true, provider: u.includes("query1") ? "yahoo-q1" : "yahoo-q2", rows };
  }
  return { ok:false, stage:"yahooHistory", status:lastStatus, error:lastText || "no result" };
}

async function stooqHistory(symbol: string, range: Range) {
  const u = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}&i=d`;
  const r = await fetch(u, { cache: "no-store", headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketWatchBot/1.0)" } });
  const text = await r.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) return { ok:false, stage:"stooqHistory", status:r.status, error:"no data" };

  const cutoff = new Date(Date.now() - daysForRange(range) * 86400 * 1000);
  const rows: any[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [date, open, high, low, close, volume] = lines[i].split(",");
    const d = new Date(date + "T00:00:00Z");
    if (!(d instanceof Date) || isNaN(d.getTime())) continue;
    if (d < cutoff) continue;
    const c = Number(close);
    if (!Number.isFinite(c)) continue;
    rows.push({
      t: d.toISOString(),
      open: Number(open) || null,
      high: Number(high) || null,
      low:  Number(low) || null,
      close: c,
      volume: Number(volume) || null
    });
  }
  return { ok:true, provider:"stooq", rows };
}

export default async function handler(req: Request) {
  const pf = preflight(req); if (pf) return pf;
  const limited = await rateGate(req, "history_proxy", 60, 60);
  if (limited) return withCORS(limited, req);

  try {
    const url = new URL(req.url);

    let symbol: string;
    try { symbol = vSymbol(url.searchParams.get("symbol") || ""); }
    catch (e: any) { return withCORS(json({ ok:false, stage:"validate", error:String(e?.message || e) }, 400), req); }

    let range: Range, interval: Interval;
    try {
      range = sanitizeRange(url.searchParams.get("range"));
      interval = sanitizeInterval(url.searchParams.get("interval"));
    } catch (e: any) {
      return withCORS(json({ ok:false, stage:"validate", error:String(e?.message || e) }, 400), req);
    }

    // TTL controls
    const force = url.searchParams.get("force") === "true"; // bypass cache
    const ttl   = Math.max(60, Math.min(Number(url.searchParams.get("ttl") || (interval === "1wk" ? 3600 : 6 * 3600)), 7 * 24 * 3600)); // default 6h (1wk→1h)

    const key = `hist:${symbol}:r=${range}:i=${interval}`;
    if (!force) {
      const hit = await cacheGet<any>(key);
      if (hit.hit) {
        return withCORS(json({ ok:true, cached:true, symbol, provider: hit.value.provider, count: hit.value.rows.length, rows: hit.value.rows }), req);
      }
    }

    // Fetch fresh
    let result = await yahooHistory(symbol, range, interval);
    if (!result.ok) {
      if (interval !== "1d") {
        return withCORS(json({ ok:false, stage:"both_failed", yahoo:result, error:"fallback requires interval=1d" }, 502), req);
      }
      const s = await stooqHistory(symbol, range);
      if (!s.ok) return withCORS(json({ ok:false, stage:"both_failed", yahoo:result, stooq:s }, 502), req);
      result = s;
    }

    // Optional DB upsert (daily only)
    let upserted = 0;
    const doUpsert = url.searchParams.get("upsert") === "true" && interval === "1d";
    if (doUpsert) {
      const token = url.searchParams.get("token") || "";
      const expected = process.env.WRITER_BEARER_TOKEN || "";
      if (!expected) return withCORS(json({ ok:false, stage:"auth", error:"Server missing WRITER_BEARER_TOKEN" }, 500), req);
      if (token !== expected) return withCORS(json({ ok:false, stage:"auth", error:"Unauthorized" }, 401), req);

      const supabase = getServiceClient();
      const dailyRows = (result as any).rows.map((r: any) => ({
        symbol,
        date: r.t.slice(0,10),
        open:  r.open,
        high:  r.high,
        low:   r.low,
        close: r.close,
        volume: r.volume ?? null
      }));
      const { error } = await supabase.from("daily_agg").upsert(dailyRows, { onConflict: "symbol,date" });
      if (error) return withCORS(json({ ok:false, stage:"upsert", error:error.message }, 500), req);
      upserted = dailyRows.length;
    }

    // Cache & return
    await cachePut(key, result, ttl);
    return withCORS(json({ ok:true, symbol, provider: (result as any).provider, count: (result as any).rows.length, upserted, rows: (result as any).rows }), req);
  } catch (e: any) {
    return withCORS(json({ ok:false, stage:"top", error:String(e?.message || e) }, 502), req);
  }
}
