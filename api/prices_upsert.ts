import { jsonResponse, requireBearer } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

type Bar = {
  symbol: string; // e.g., "AAPL"
  ts: string;     // ISO date-time
  open?: number; high?: number; low?: number; close?: number;
  volume?: number;
};

function toISO(x: string) {
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function sma(vals: number[], win: number, idx: number) {
  if (idx + 1 < win) return null;
  let s = 0;
  for (let i = idx - win + 1; i <= idx; i++) s += vals[i];
  return s / win;
}
function rsi14(closes: number[], idx: number) {
  if (idx < 14) return null;
  let gains = 0, losses = 0;
  for (let i = idx - 14 + 1; i <= idx; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function atr14(highs: number[], lows: number[], closes: number[], idx: number) {
  if (idx < 14) return null;
  const trs: number[] = [];
  for (let i = idx - 14 + 1; i <= idx; i++) {
    const prevClose = closes[i - 1] ?? closes[i];
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prevClose),
      Math.abs(lows[i] - prevClose)
    );
    trs.push(tr);
  }
  const sum = trs.reduce((a, b) => a + b, 0);
  return sum / trs.length;
}

export default async function handler(req: Request) {
  const auth = requireBearer(req);
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.err }, auth.status);

  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Use POST" }, 405);

  let body: { bars: Bar[] } | null = null;
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: "Invalid JSON" }, 400); }

  const bars = body?.bars || [];
  if (!Array.isArray(bars) || bars.length === 0) {
    return jsonResponse({ ok: false, error: "Provide { bars: Bar[] }" }, 400);
  }

  // normalize
  const rows = [];
  const affected = new Set<string>();
  for (const b of bars) {
    const iso = toISO(b.ts);
    if (!b.symbol || !iso) continue;
    const sym = b.symbol.toUpperCase();
    affected.add(sym);
    rows.push({
      symbol: sym,
      ts: iso,
      open: b.open ?? null,
      high: b.high ?? null,
      low: b.low ?? null,
      close: b.close ?? null,
      volume: b.volume ?? null
    });
  }
  if (rows.length === 0) return jsonResponse({ ok: false, error: "No valid bars" }, 400);

  const supabase = getServiceClient();

  // 1) Upsert raw bars
  {
    const { error } = await supabase.from("prices").upsert(rows, { onConflict: "symbol,ts" });
    if (error) return jsonResponse({ ok: false, stage: "prices_upsert", error: error.message }, 500);
  }

  // 2) Recompute daily_agg for each affected symbol (last ~220d)
  let totalDays = 0;
  for (const symbol of Array.from(affected)) {
    const since = new Date(Date.now() - 220 * 86400_000).toISOString();

    const { data: barsAsc, error: selErr } = await supabase
      .from("prices")
      .select("ts, high, low, close, volume")
      .eq("symbol", symbol)
      .gte("ts", since)
      .order("ts", { ascending: true });

    if (selErr) continue;
    if (!barsAsc || barsAsc.length === 0) continue;

    type DayRow = { date: string; high: number; low: number; close: number; volume: number };
    const dayMap = new Map<string, DayRow>();
    for (const b of barsAsc) {
      const d = new Date(b.ts as string).toISOString().slice(0, 10);
      const hi = Number(b.high ?? 0);
      const lo = Number(b.low ?? 0);
      const cl = Number(b.close ?? 0);
      const vol = Number(b.volume ?? 0);
      const ex = dayMap.get(d);
      if (!ex) {
        dayMap.set(d, { date: d, high: hi, low: lo || hi, close: cl, volume: vol });
      } else {
        ex.high = Math.max(ex.high, hi);
        ex.low = ex.low === 0 ? lo : Math.min(ex.low, lo || ex.low);
        ex.close = cl;
        ex.volume += vol;
      }
    }
    const daysArr = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    totalDays += daysArr.length;

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

    const { error: aggErr } = await supabase
      .from("daily_agg")
      .upsert(upsertRows, { onConflict: "symbol,date" });

    if (aggErr) return jsonResponse({ ok: false, stage: "daily_agg_upsert", error: aggErr.message }, 500);
  }

  return jsonResponse({ ok: true, inserted_bars: rows.length, symbols_updated: Array.from(affected), daily_agg_days_processed: totalDays });
}
