// api/_errors.ts
export function jsonOK(data: any = {}, status = 200) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

export function jsonErr(stage: string, error: any, status = 500) {
  const reqId = (globalThis as any).crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const message = typeof error === "string" ? error : (error?.message ?? String(error));
  return new Response(JSON.stringify({ ok: false, stage, error: message, req_id: reqId }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
