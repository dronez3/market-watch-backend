export const config = { runtime: "edge" };

// Minimal JSON helper (avoid importing _common to keep deps zero)
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

/**
 * Public comparator via /api/prob for each symbol.
 * GET /api/compare_proxy?symbols=SPY,QQQ&hours=72&horizon_days=5
 *
 * Notes:
 * - Uses SELF_BASE_URL env or falls back to your Vercel URL.
 * - Does not hit Supabase directly; it fetches /api/prob for each symbol.
 */
export default async function handler(req: Request) {
  const url = new URL(req.url);
  const symbols = (url.searchParams.get("symbols") || "SPY,QQQ")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const horizonDays = Number(url.searchParams.get("horizon_days") || 5);

  if (symbols.length === 0) {
    return json({ ok: false, error: "Provide ?symbols=SPY,QQQ" }, 400);
  }

  const base = (process.env.SELF_BASE_URL || "https://market-watch-backend.vercel.app").replace(/\/+$/, "");

  try {
    // Fetch /api/prob for each symbol in parallel
    const calls = symbols.map(async (sym) => {
      const u = `${base}/api/prob?symbol=${encodeURIComponent(sym)}&horizon_days=${encodeURIComponent(String(horizonDays))}`;
      const r = await fetch(u, { cache: "no-store" });
      const data = await r.json().catch(() => null);
      if (!data || data.ok !== true) {
        return { symbol: sym, ok: false, error: "prob endpoint failed", data };
      }
      return {
        symbol: sym,
        ok: true,
        probability_up: data.probability_up ?? null,
        momentum_7bar_pct: data.signals?.pct_change_7 ?? null,
        sentiment: data.signals?.sentiment ?? null,
        signals: {
          rsi: data.signals?.rsi ?? null,
          sma50: data.signals?.sma50 ?? null,
          sma200: data.signals?.sma200 ?? null
        },
        rationale: data.rationale ?? []
      };
    });

    const resultsRaw = await Promise.all(calls);

    // Keep only successful items for ranking; include failures verbosely
    const successes = resultsRaw.filter(r => (r as any).ok);
    const failures = resultsRaw.filter(r => !(r as any).ok);

    // Sort by probability_up desc
    const sorted = [...successes].sort((a: any, b: any) => (b.probability_up ?? 0) - (a.probability_up ?? 0));
    const byMomentum = [...successes].sort((a: any, b: any) => (b.momentum_7bar_pct ?? -1e9) - (a.momentum_7bar_pct ?? -1e9));
    const bySent = [...successes].sort((a: any, b: any) => (b.sentiment ?? -1e9) - (a.sentiment ?? -1e9));

    const summary = {
      highest_probability: sorted[0]?.symbol ?? null,
      strongest_momentum: byMomentum[0]?.symbol ?? null,
      best_sentiment: bySent[0]?.symbol ?? null
    };

    return json({
      ok: true,
      horizon_days: horizonDays,_
