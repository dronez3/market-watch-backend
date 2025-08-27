import { jsonResponse } from "./_common";

export const config = { runtime: "edge" };

export default async function handler() {
  return jsonResponse({ ok: true, service: "market-watch-backend", route: "ping" });
}
