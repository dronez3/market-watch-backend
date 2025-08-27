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
    else if (latest.sma50 < latest.sma200) { p -= 0.07; rationale.push("Downtrend (SMA50<SMA
