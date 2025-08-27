export function vSymbol(raw: string): string {
  const s = (raw || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)) throw new Error("Bad symbol");
  return s;
}

export function vSymbolsList(raw: string, max = 25): string[] {
  const items = (raw || "").split(",").map(x => x.trim()).filter(Boolean);
  if (!items.length) throw new Error("Missing symbols");
  if (items.length > max) throw new Error("Too many symbols");
  return items.map(vSymbol);
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
    throw new Error("Bad UUID");
  }
  return s;
}
