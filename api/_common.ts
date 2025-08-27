export function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export function requireBearer(req: Request) {
  const hdr = req.headers.get("authorization") || "";
  const expected = process.env.ACTIONS_BEARER_TOKEN;
  if (!expected) {
    return { ok: false, status: 500, err: "Server missing ACTIONS_BEARER_TOKEN" };
  }
  const token = hdr.toLowerCase().startsWith("bearer ") ? hdr.slice(7) : "";
  if (token !== expected) {
    return { ok: false, status: 401, err: "Unauthorized" };
  }
  return { ok: true };
}
