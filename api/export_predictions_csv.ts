import { createClient } from '@supabase/supabase-js';
import { stringify } from 'csv-stringify/sync';

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  const { data, error } = await supabase.from('predictions_log').select('*');
  if (error) return res.status(400).json({ ok: false, error });

  const csv = stringify(data, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=predictions.csv');
  res.send(csv);
}
