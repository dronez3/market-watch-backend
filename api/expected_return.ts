import { jsonResponse } from "./_common";
import { getAnonClient } from "./_supabase";

export const config = { runtime: "edge" };

/**
 * Estimate expected return over N trading days from recent returns.
 *
 * GET /api/expected_return?symbol=AAPL&horizon_days=7&lookback_days=90
 *
 * Method:
 * - Pull last lookback_days closes from daily_agg
 * - Compute daily log-returns r_t = ln(C_t / C_{t-1})
 * - Drift mu = mean(r_t), vol sigma = stdev(r_t)
 * - Expected log-return over H days: H*mu
 * - Convert to arithmetic: exp(H*mu) - 1
 * - 68% interval: exp(H*mu ± sqrt(H)*sigma) - 1
 */
export default async function handler(req: Request) {
  try {
    const url = new URL(req.url);
    const symbol = (url.searchParams.get("symbol") || "").toUpperCase();
    const horizonDays = Math.max(1, Math.min(30, Number(url.searchParams.get("horizon_days") || 7)));
    const lookbackDays = Math.max(20, Math.min(250, Number(url.searchParams.get("lookback_days") || 90)));

    if (!symbol) return jsonResponse({ ok:false, error:"Missing ?symbol=XXX" }, 400);

    const supabase = getAnonClient();
    const { data, error } = await supabase
      .from("daily_agg")
      .select("date, close")
      .eq("symbol", symbol)
      .order("date", { ascending: false })
      .limit(lookbackDays + 1);

    if (error) return jsonResponse({ ok:false, stage:"select", error: error.message }, 500);

    const rows = (data || []) as any[];
    if (rows.length < 2) {
      return jsonResponse({ ok:true, symbol, enough_data:false, note:"Need at least 2 daily rows" });
    }

    // chronological order
    rows.reverse();

    // compute log returns
    const rets: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      const c0 = Number(rows[i-1]?.close ?? NaN);
      const c1 = Number(rows[i]?.close ?? NaN);
      if (isFinite(c0) && isFinite(c1) && c0 > 0) {
        rets.push(Math.log(c1 / c0));
      }
    }

    if (rets.length < 10) {
      return jsonResponse({ ok:true, symbol, enough_data:false, note:"Need ~10 returns; add more history." });
    }

    // stats
    const mean = rets.reduce((a,b)=>a+b,0) / rets.length;
    const variance = rets.reduce((a,b)=>a + Math.pow(b - mean, 2), 0) / Math.max(1, (rets.length - 1));
    const sigma = Math.sqrt(Math.max(variance, 0));

    const H = horizonDays;
    const expectedLog = H * mean;
    const expected = Math.exp(expectedLog) - 1;

    // 68% conf interval in log space -> arithmetic
    const band = Math.sqrt(H) * sigma;
    const low = Math.exp(expectedLog - band) - 1;
    const high = Math.exp(expectedLog + band) - 1;

    // simple confidence score (0..1)
    const conf = Math.max(0, Math.min(1, 1 - (Math.sqrt(H) * sigma) / 0.20));

    // 7-bar momentum (optional context)
    let momentum7: number | null = null;
    if (rows.length >= 8) {
      const cNew = Number(rows[rows.length - 1].close);
      const cOld = Number(rows[rows.length - 8].close);
      if (isFinite(cNew) && isFinite(cOld) && cOld !== 0) {
        momentum7 = (cNew - cOld) / cOld * 100; // %
      }
    }

    return jsonResponse({
      ok: true,
      symbol,
      horizon_days: H,
      lookback_days: lookbackDays,
      enough_data: true,
      expected_return_pct: Number((expected * 100).toFixed(2)),
      conf_interval_68_pct: {
        low: Number((low * 100).toFixed(2)),
        high: Number((high * 100).toFixed(2))
      },
      confidence: Number(conf.toFixed(2)),
      drift_daily_mean: Number((mean * 100).toFixed(3)),      // % per day
      vol_daily_sigma: Number((sigma * 100).toFixed(3)),      // % per day
      momentum_7bar_pct: momentum7 != null ? Number(momentum7.toFixed(2)) : null,
      rationale: [
        "Drift/vol estimated from recent log-returns",
        "Interval is 68% (~1σ) in log space",
        "Short horizons only; not investment advice"
      ]
    });
  } catch (e: any) {
    return jsonResponse({ ok:false, stage:"exception", error:String(e?.message || e) }, 500);
  }
}
