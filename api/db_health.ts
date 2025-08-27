import { jsonResponse } from "./_common";
import { getServiceClient } from "./_supabase";

export const config = { runtime: "edge" };

export default async function handler() {
  try {
    const supabase = getServiceClient();

    // Simple sanity read from a table we seeded in Task 2B
    const { data, error } = await supabase
      .from("instrument_meta")
      .select("symbol, liquidity_score, beta_1y")
      .limit(1);

    if (error) {
      return jsonResponse({ ok: false, stage: "select", error: String(error.message) }, 500);
    }

    return jsonResponse({ ok: true, sample: data ?? [] });
  } catch (e: any) {
    return jsonResponse({ ok: false, stage: "init", error: String(e?.message || e) }, 500);
  }
}
