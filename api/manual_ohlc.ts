import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Only POST allowed' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { symbol, trade_date, open, high, low, close, volume } = req.body;

  const { data, error } = await supabase
    .from('ohlc_manual')
    .insert([{ symbol, trade_date, open, high, low, close, volume }]);

  if (error) return res.status(400).json({ ok: false, error });
  res.json({ ok: true, data });
}
