// Normalizes and validates a single ticker symbol.
// - Strips leading '^' or '.' (Yahoo/Google index formats).
// - Maps common indices to tradable ETFs so downstream endpoints work.
// - Normalizes hyphen to dot for things like BRK-B -> BRK.B.
// - Enforces a conservative character set and length.
function normalize(raw: string): string {
  let s = (raw || "").trim().toUpperCase();

  // Strip common prefixes for indices
  if (s.startsWith("^") || s.startsWith(".")) s = s.slice(1);

  // Normalize hyphen vs dot (prefer dot)
  s = s.replace(/-/g, ".");

  // Map common indices to ETFs (keeps the rest of the pipeline happy)
  const indexMap: Record<string, string> = {
    GSPC: "SPY",   // S&P 500 index -> SPY
    INX: "SPY",    // .INX -> SPY
    NDX: "QQQ",    // Nasdaq 100 -> QQQ
    IXIC: "QQQ",   // Composite -> QQQ (approx)
    DJI: "DIA",    // Dow Jones -> DIA
    RUT: "IWM"     // Russell 2000 -> IWM
  };
  if (s in indexMap) s = indexMap[s];

  return s;
}

export function vSymbol(raw: string): string {
  const s = normalize(raw);

  // Allow A–Z first char, then letters/digits/dot.
  // Keep length conservative (<=10) to avoid abuse.
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(s)) {
    throw new Error(`Bad symbol: ${raw}`);
  }
  return s;
}

export function vSymbolsList(raw: string, max = 25): string[] {
  const items = (raw || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!items.length) throw new Error("Missing symbols");
  if (items.length > max) throw new Error("Too many symbols");
  const out: string[] = [];
  for (const item of items) {
    try {
      out.push(vSymbol(item));
    } catch (e: any) {
      // Bubble up which item failed
      throw new Error(String(e?.message || `Bad symbol: ${item}`));
    }
  }
  return out;
}

export function vIntInRange(raw: any, def: number, min: number, max: number): number {
  const n = raw == null ? def : Number(raw);
  if (!Number.isFinite(n)) throw new Error("Bad number");
  const i = Math.trunc(n);
  if (i < min || i > max) throw new Error("Out of range");
  return i;
}

export function vUUID(raw: string): string {
  const s = (raw || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw new Error(`Bad UUID: ${raw}`);
  }
  return s;
}
