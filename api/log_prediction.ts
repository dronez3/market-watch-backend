import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Only POST allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { symbol, trade_date, prob_up, expected_return, conf_low, conf_high, action_hint, outcome } = req.body;

  const { data, error } = await supabase
    .from('predictions_log')
    .insert([{ symbol, trade_date, prob_up, expected_return, conf_low, conf_high, action_hint, outcome }]);

  if (error) return res.status(400).json({ ok: false, error });
  res.json({ ok: true, data });
}
