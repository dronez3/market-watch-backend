# Market Watch Backend — Public Read API

Base URL: `https://market-watch-backend.vercel.app`

This API powers GPT-style stock insights with probability, momentum, technicals, expected return, portfolio views, CSV exports, and live data proxies (with TTL caching). Health endpoints are included.

---

## Auth

Most endpoints are **public read**. Endpoints that **write** (upsert history) require a server-side secret:

- `WRITER_BEARER_TOKEN` — set in Vercel → Environment Variables.
- Pass it as a query param `token=...` when `upsert=true` on `/api/history_proxy`.

> Keep tokens private. Never expose them in client-side code.

---

## Rate limiting

We enforce per-IP sliding windows (stored in `rate_gate`):

- `quote_proxy`: 120 req / 60s / IP  
- `history_proxy`: 60 req / 60s / IP  
- CSV exports: 12 downloads / 60s / IP  
- Others: reasonable defaults

On limit, you’ll receive HTTP **429**:
```json
{ "ok": false, "error": "rate_limited", "retry_after_sec": 60 }
