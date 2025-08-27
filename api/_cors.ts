export function withCORS(resp: Response, req: Request) {
  const origin = req.headers.get("origin") || "";
  // Allow-list your site; add more origins if you embed elsewhere
  const allowed = new Set([
    "https://market-watch-backend.vercel.app"
  ]);
  const allowOrigin = allowed.has(origin) ? origin : "https://market-watch-backend.vercel.app";

  const h = new Headers(resp.headers);
  h.set("access-control-allow-origin", allowOrigin);
  h.set("access-control-allow-methods", "GET,OPTIONS");
  h.set("access-control-allow-headers", "content-type,authorization");
  h.set("vary", "origin");

  return new Response(resp.body, { status: resp.status, headers: h });
}

export function preflight(req: Request) {
  if (req.method === "OPTIONS") {
    return withCORS(new Response(null, { status: 204 }), req);
  }
  return null;
}
