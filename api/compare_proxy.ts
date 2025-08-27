export const config = { runtime: "edge" };

// Minimal JSON helper (no external imports)
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

/**
 * Public comparator via local /api/prob for each symbol.
 * GET /api/compare_proxy?symbols=SPY,QQQ&horizon_days=5
 *
 * Notes:
 * - Uses the request's own origin (no env needed).
 * - Calls /api/prob sequentially with hard guards to avoid crashing on bad responses.
 */
export default async function handler(req: Request) {
  try {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`; // always your deployed domain
    const symbols = (url.searchParams.get("symbols") || "SPY,QQQ")
      .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    const horizonDays = Number(url.searchParams.get("horizon_days") || 5);

    if (symbols.length === 0) {
      return json({ ok: false, error: "Provide ?symbols=SPY,QQQ" }, 400);
    }

    const resultsRaw: any[] = [];
    // Sequential (more robust for debugging); can switch to parallel later.
    for (const sym of symbols) {
      const u = `${origin}/api/prob?symbol=${encodeURIComponent(sym)}&horizon_days=${encodeURIComponent(String(horizonDays))}`;
      try {
        const r = await fetch(u, { cache: "no-store" });
        const ct = r.headers.get("content-type") || "";
        let data: any = null;
        if (ct.includes("application/json")) {
          try { data = await r.json(); } catch { data = null; }
        }
        if (!r.ok || !data || data.ok !== true) {
          resultsRaw.push({ symbol: sym, ok: false, status: r.status, note: "prob endpoint failed", url: u, data });
          continue;
        }
        resultsRaw.push({
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
        });
      } catch (e: any) {
        resultsRaw.push({ symbol: sym, ok: false, error: String(e?.message || e), url: u });
      }
    }

    const successes = resultsRaw.filter(r => r.ok);
    const failures  = resultsRaw.filter(r => !r.ok);

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
      horizon_days: horizonDays,
      count: successes.length,
      summary,
      results: sorted,
      failures // if any symbols failed, you’ll see details here instead of a crash
    });
  } catch (e: any) {
    return json({ ok: false, stage: "top_level", error: String(e?.message || e) }, 500);
  }
}
