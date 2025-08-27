import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Alias for 4B probability endpoint.
 * GET /api/prob?symbol=AAPL&horizon_days=5
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
  const horizonDays = Number(url.searchParams.get("horizon_days") || 5);
  if (!symbol) return jsonResponse({ ok: false, error: "Provide ?symbol=XXX" }, 400);

  const supabase = getAnonClient();
  const rationale: string[] = [];
  let p = 0.5;

  // Latest technicals
  const { data: latestArr, error: daErr } = await supabase
    .from("daily_agg")
    .select("date, close, rsi, sma50, sma200")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(1);
  if (daErr) return jsonResponse({ ok: false, stage: "daily_agg_latest", error: daErr.message }, 500);
  const latest = latestArr && latestArr.length ? latestArr[0] as any : null;

  // 7-bar momentum
  const { data: last7, error: mErr } = await supabase
    .from("daily_agg")
    .select("date, close")
    .eq("symbol", symbol)
    .order("date", { ascending: false })
    .limit(7);
  if (mErr) return jsonResponse({ ok: false, stage: "daily_agg_7", error: mErr.message }, 500);

  let pctChange7: number | null = null;
  if (last7 && last7.length >= 2) {
    const newest = Number((last7[0] as any).close ?? NaN);
    const oldest = Number((last7[last7.length - 1] as any).close ?? NaN);
    if (isFinite(newest) && isFinite(oldest) && oldest !== 0) {
      pctChange7 = (newest - oldest) / oldest; // e.g., 0.043 = +4.3%
    }
  }

  // Latest sentiment within ~72h
  const now = new Date();
  const start = new Date(now.getTime() - 72 * 3600 * 1000).toISOString();
  const { data: ss, error: sErr } = await supabase
    .from("sentiment_scores")
    .select("score, window_end")
    .eq("symbol", symbol)
    .gte("window_start", start)
    .lte("window_end", now.toISOString())
    .order("window_end", { ascending: false })
    .limit(1);
  if (sErr) return jsonResponse({ ok: false, stage: "sentiment", error: sErr.message }, 500);
  const sentiment = ss && ss.length ? (ss[0] as any).score as number : null;

  // --- Combine signals into probability ---

  // RSI tilt
  if (latest && typeof latest.rsi === "number") {
    if (latest.rsi < 30) { p += 0.10; rationale.push("RSI oversold (<30)"); }
    else if (latest.rsi > 70) { p -= 0.10; rationale.push("RSI overbought (>70)"); }
    else { rationale.push("RSI neutral"); }
  } else {
    rationale.push("RSI missing");
  }

  // Trend tilt (SMA50 vs SMA200)
  if (latest && typeof latest.sma50 === "number" && typeof latest.sma200 === "number") {
    if (latest.sma50 > latest.sma200) { p += 0.07; rationale.push("Uptrend (SMA50>SMA200)"); }
    else if (latest.sma50 < latest.sma200) { p -= 0.07; rationale.push("Downtrend (SMA50<SMA200)"); }
    else { rationale.push("Trend neutral (SMA50≈SMA200)"); }
  } else {
    rationale.push("Trend MAs missing");
  }

  // Sentiment tilt (scaled & clamped)
  if (typeof sentiment === "number") {
    const tilt = Math.max(-0.08, Math.min(0.08, sentiment * 0.30));
    p += tilt;
    rationale.push(tilt >= 0 ? "Positive sentiment tilt" : "Negative sentiment tilt");
  } else {
    rationale.push("No recent sentiment");
  }

  // 7-bar momentum tilt (scaled & clamped)
  if (pctChange7 != null) {
    const tilt = Math.max(-0.06, Math.min(0.06, pctChange7 * 0.50));
    p += tilt;
    rationale.push(`7-bar momentum ${pctChange7 >= 0 ? "positive" : "negative"} (${(pctChange7 * 100).toFixed(1)}%)`);
  } else {
    rationale.push("Momentum unavailable (need ~7 daily rows)");
  }

  // Clamp to [0.05, 0.95]
  p = Math.max(0.05, Math.min(0.95, p));

  return jsonResponse({
    ok: true,
    symbol,
    horizon_days: horizonDays,
    probability_up: Number(p.toFixed(2)),
    signals: {
      rsi: latest ? (latest as any).rsi ?? null : null,
      sma50: latest ? (latest as any).sma50 ?? null : null,
      sma200: latest ? (latest as any).sma200 ?? null : null,
      sentiment: sentiment ?? null,
      pct_change_7: pctChange7 != null ? Number((pctChange7 * 100).toFixed(2)) : null
    },
    rationale
  });
}
