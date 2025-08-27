// --- Normalization helpers ---------------------------------------------------
function stripWeirdWhitespace(s: string) {
  // remove non-breaking spaces, zero-width, etc.
  return s.replace(/[\u00A0\u200B-\u200D\uFEFF]/g, " ").trim();
}

// Map common index codes -> tradable ETFs, and tidy symbol variants.
function normalize(raw: string): string {
  let s = stripWeirdWhitespace((raw || "").toUpperCase());

  // Strip Yahoo/Google prefixes for indices (^GSPC, .INX, .DJI, ^IXIC, etc.)
  if (s.startsWith("^") || s.startsWith(".")) s = s.slice(1);

  // Normalize hyphen to dot (BRK-B -> BRK.B)
  s = s.replace(/-/g, ".");

  // Common index → ETF proxies (extendable)
  const indexMap: Record<string, string> = {
    // S&P 500
    GSPC: "SPY",
    INX: "SPY",
    SPX: "SPY",
    US500: "SPY",

    // Nasdaq 100
    NDX: "QQQ",
    IXNDX: "QQQ",
    NAS100: "QQQ",
    US100: "QQQ",

    // Dow Jones
    DJI: "DIA",
    DJIA: "DIA",

    // Russell 2000
    RUT: "IWM",
    RTY: "IWM",

    // Nasdaq Composite (approx via QQQ)
    IXIC: "QQQ"
  };
  if (s in indexMap) s = indexMap[s];

  return s;
}

// --- Validators --------------------------------------------------------------
export function vSymbol(raw: string): string {
  const s = normalize(raw);

  // Allow leading letter, then letters/digits/dot. Cap length to 16 to be safe.
  if (!/^[A-Z][A-Z0-9.]{0,15}$/.test(s)) {
    throw new Error(`Bad symbol: ${raw}`);
  }
  return s;
}

export function vSymbolsList(raw: string, max = 25): string[] {
  const items = (raw || "").split(",").map(x => stripWeirdWhitespace(x)).filter(Boolean);
  if (!items.length) throw new Error("Missing symbols");
  if (items.length > max) throw new Error("Too many symbols");

  const out: string[] = [];
  for (const item of items) {
    try {
      out.push(vSymbol(item));
    } catch (e: any) {
      // Bubble up the exact bad input for clarity
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
  const s = stripWeirdWhitespace(raw || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    throw new Error(`Bad UUID: ${raw}`);
  }
  return s;
}
