import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export function getServiceClient() {
  if (!url || !serviceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  // Edge-friendly client; no session persisted
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
    global: { headers: { "x-application-name": "market-watch-backend" } }
  });
}
