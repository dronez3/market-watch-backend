import { getServiceClient } from "./_supabase";

type CacheHit<T=any> = { hit: true; value: T };
type CacheMiss = { hit: false };

export async function cacheGet<T=any>(key: string): Promise<CacheHit<T> | CacheMiss> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("live_cache")
    .select("v, ts, ttl_sec")
    .eq("k", key)
    .maybeSingle();

  if (error || !data) return { hit: false };

  const ts = new Date(data.ts).getTime();
  const ttl = Number(data.ttl_sec) * 1000;
  const fresh = Date.now() < (ts + ttl);
  if (!fresh) return { hit: false };

  return { hit: true, value: data.v as T };
}

export async function cachePut<T=any>(key: string, value: T, ttlSec: number) {
  const supabase = getServiceClient();
  await supabase.from("live_cache").upsert({
    k: key,
    v: value as any,
    ts: new Date().toISOString(),
    ttl_sec: Math.max(1, Math.min(ttlSec, 86400)) // clamp 1s..1d
  });
}
