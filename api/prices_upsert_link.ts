import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

function sma(vals: number[], win: number, idx: number) {
  if (idx + 1 < win) return null;
  let s = 0; for (let i = idx - win + 1; i <= idx; i++) s += vals[i];
  return s / win;
}
function rsi14(closes: number[], idx: number) {
  if (idx < 14) return null;
  let gains = 0, losses = 0;
  for (let i = idx - 14 + 1; i <= idx; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const avgGain = gains / 14, avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss; return 100 - 100 / (1 + rs);
}
function atr14(highs: number[], lows: number[], closes: number[], idx: number) {
  if (idx < 14) return null;
  const trs: number[] = [];
  for (let i = idx - 14 + 1; i <= idx; i++) {
    const pc = closes[i - 1] ?? closes[i];
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - pc), Math.abs(lows[i] - pc)));
  }
  const sum = trs.reduce((a, b) => a + b, 0); return sum / trs.length;
}

/**
 * TEMP direct-link for inserting ONE bar + auto daily_agg recompute (last ~220d).
 * Example:
 * /api/prices_upsert_link?token=TOKEN&symbol=AAPL&ts=2025-08-26T14:30:00Z&open=220&high=221&low=219&close=220.5&volume=1000000
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN || "";
  if (!expected) return jsonResponse({ ok: false, error: "Server missing ACTIONS_BEARER_TOKEN" }, 500);
  if (token !== expected) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);

  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const ts = url.searchParams.get("ts") || "";
  if (!symbol || !ts) return jsonResponse({ ok: false, error: "Missing required params: symbol, ts" }, 400);

  const row = {
    symbol,
    ts: new Date(ts).toISOString(),
    open: url.searchParams.get("open") ? Number(url.searchParams.get("open")) : null,
    high: url.searchParams.get("high") ? Number(url.searchParams.get("high")) : null,
    low: url.searchParams.get("low") ? Number(url.searchParams.get("low")) : null,
    close: url.searchParams.get("close") ? Number(url.searchParams.get("close")) : null,
    volume: url.searchParams.get("volume") ? Number(url.searchParams.get("volume")) : null
  };

  const supabase = getServiceClient();

  // 1) Upsert the single bar
  {
    const { error } = await supabase.from("prices").upsert([row], { onConflict: "symbol,ts" });
    if (error) return jsonResponse({ ok: false, stage: "prices_upsert", error: error.message }, 500);
  }

  // 2) Recompute daily_agg for this symbol (last ~220d)
  const since = new Date(Date.now() - 220 * 86400_000).toISOString();
  const { data: bars, error: selErr } = await supabase
    .from("prices")
    .select("ts, high, low, close, volume")
    .eq("symbol", symbol)
    .gte("ts", since)
    .order("ts", { ascending: true });

  if (selErr) return jsonResponse({ ok: false, stage: "select_prices", error: selErr.message }, 500);
  if (!bars || bars.length === 0) return jsonResponse({ ok: true, inserted: 1, daily_agg_days_processed: 0 });

  type DayRow = { date: string; high: number; low: number; close: number; volume: number };
  const dayMap = new Map<string, DayRow>();
  for (const b of bars) {
    const d = new Date(b.ts as string).toISOString().slice(0, 10);
    const hi = Number(b.high ?? 0), lo = Number(b.low ?? 0), cl = Number(b.close ?? 0), vol = Number(b.volume ?? 0);
    const ex = dayMap.get(d);
    if (!ex) dayMap.set(d, { date: d, high: hi, low: lo || hi, close: cl, volume: vol });
    else { ex.high = Math.max(ex.high, hi); ex.low = ex.low === 0 ? lo : Math.min(ex.low, lo || ex.low); ex.close = cl; ex.volume += vol; }
  }
  const daysArr = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const closes = daysArr.map(d => d.close);
  const highs = daysArr.map(d => d.high);
  const lows = daysArr.map(d => d.low);

  const upsertRows = daysArr.map((d, i) => ({
    symbol,
    date: d.date,
    close: d.close,
    volume: d.volume,
    rsi: rsi14(closes, i),
    macd: null as number | null,
    macd_signal: null as number | null,
    sma50: sma(closes, 50, i),
    sma200: sma(closes, 200, i),
    atr: atr14(highs, lows, closes, i)
  }));

  const { error: aggErr } = await supabase.from("daily_agg").upsert(upsertRows, { onConflict: "symbol,date" });
  if (aggErr) return jsonResponse({ ok: false, stage: "daily_agg_upsert", error: aggErr.message }, 500);

  return jsonResponse({ ok: true, inserted: 1, daily_agg_days_processed: daysArr.length, latest_sample: upsertRows[upsertRows.length - 1] });
}
