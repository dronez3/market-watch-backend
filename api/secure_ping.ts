import { jsonResponse, requireBearer } from "./_common";

export const config = { runtime: "edge" };

export default async function handler(req: Request) {
  const auth = requireBearer(req);
  if (!auth.ok) return jsonResponse({ ok: false, error: auth.err }, auth.status);
  return jsonResponse({ ok: true, route: "secure_ping", msg: "Authorized" });
}
