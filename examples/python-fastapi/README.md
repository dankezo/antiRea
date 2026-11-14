# quota-guard for Python / FastAPI

A semantic port of antiRea's server-side quota guard
([`src/tier2-active/quota-guard.ts`](../../src/tier2-active/quota-guard.ts))
to Python, with Starlette/FastAPI integration. It enforces per-account,
per-API-key and per-IP **sliding-window request quotas** plus **pagination
bounds** (`limit`/`pageSize` and `page`/`offset`), configured per plan tier
(`anonymous` / `free` / `pro` / `enterprise` by default).

This is the P0-1 item of the 2.2.0 upgrade plan: the TS module ships with an
Express middleware; this example gives Python/FastAPI hosts the same control
with the same behavior, pinned by parity tests ported from
`tests/core.test.cjs`.

## Threat model and honest scope

Read [`docs/LIMITATIONS.md`](../../docs/LIMITATIONS.md) first; everything
there applies here unchanged.

- The guard is an **abuse-cost control for your own API**. It raises the cost
  of bulk extraction through your API surface; it does not make a site
  unclonable and does not stop a determined client.
- An IP address or API key alone is **never proof of intent**. Identity
  (`account_id` / `api_key_id` / `tier`) must come from your authenticated
  server session via `resolve_identity` - never from unverified client
  headers. The demo app reads `x-demo-*` headers **only** as a stand-in so
  the example is easy to exercise; doing that in production would defeat the
  control.
- A client that bypasses your API entirely (direct HTTP scraping of public
  pages, a real browser) is outside this control's reach, exactly as with
  the TS version.

## How it maps to the TS module

| TypeScript (`quota-guard.ts`) | Python (this example) |
|---|---|
| `createQuotaGuard(options)` | `QuotaGuard(...)` / `create_quota_guard(...)` in `quota_guard/core.py` |
| `createExpressQuotaMiddleware(options)` | `QuotaMiddleware` (Starlette `BaseHTTPMiddleware`) in `quota_guard/fastapi_integration.py` |
| `req.quotaPagination` attached by the middleware | `request.state.quota_pagination`, read via `Depends(get_quota_pagination)` |
| - (pagination as a route-level concern) | `PaginationParams` dependency: pagination bounds for routes not behind the middleware (consumes no request quota) |
| `QuotaWindowStore` (`peek`/`record`, sync or Promise) | `QuotaWindowStore` protocol in `quota_guard/stores.py` (sync or awaitable) |
| `createInMemoryQuotaStore(maxEntries)` | `InMemoryQuotaStore(max_entries)` / `create_in_memory_quota_store(...)` |
| Redis sorted-set store (described in the TS docstring) | `RedisQuotaStore` - duck-typed async client, one Lua script per operation |
| `DEFAULT_QUOTA_TIERS` | `DEFAULT_QUOTA_TIERS` (identical values) |
| `onQuotaExceeded` event | `on_quota_exceeded` callback (sync or async; its errors are swallowed) |
| `resolveIdentity` | `resolve_identity` (sync or async) receiving a `QuotaRequest` |

Behavior kept identical, and pinned by the parity tests:

- Check order: **pagination bounds first** (a rejected page/size request
  consumes no quota), then the sliding window across dimensions in
  **account > apiKey > ip** order; the first exceeded dimension is reported.
- On rejection: status `429`, headers `Retry-After`, `X-RateLimit-Limit`,
  `X-RateLimit-Remaining: 0` (no `X-RateLimit-Reset`), body
  `{"error", "message", "retryAfterSeconds"}` with the same message strings.
- On success: `X-RateLimit-Limit` / `X-RateLimit-Remaining` /
  `X-RateLimit-Reset` computed from the primary dimension's pre-record
  snapshot, exactly as in TS.
- `Retry-After` for pagination rejections is the tier window in seconds
  (ceil, minimum 1); for rate-limit rejections it is derived from the oldest
  hit still inside the window.
- Pagination parsing emulates JS `parseInt(..., 10)`: `"10abc"` → 10,
  `"10.9"` → 10, blank/unparseable → the tier-capped default (20);
  `limit` beats `pageSize` whenever present (even blank); first repeated
  parameter wins; `offset` derives `page` using the effective page size.
- `pagination_mode="clamp"` caps values and flags `clamped: true` instead of
  rejecting; the TS middleware case `{page: 3, pageSize: 15, offset: 30,
  clamped: true}` is reproduced by the tests both at guard level and over
  HTTP through the middleware.
- Tier fallback: unknown tier name → `anonymous` tier config → first
  configured tier; the requested tier name is still reported.
- In-memory store: same prune rule (`now - t < window_ms` survives), same
  insertion-order eviction once the distinct-key cap (min 100, default
  10,000) is exceeded.

## Layout

```
quota_guard/
  core.py                 # QuotaGuard, tiers, identity, pagination, results
  stores.py               # QuotaWindowStore protocol, InMemory + Redis stores
  fastapi_integration.py  # QuotaMiddleware, get_quota_pagination, PaginationParams
app.py                    # runnable demo (uvicorn app:app)
tests/                    # pytest parity + store + integration tests
pyproject.toml            # package metadata and test configuration
```

## Usage

Framework-free core (works with any host that can build a `QuotaRequest`):

```python
from quota_guard import QuotaIdentity, QuotaTierConfig, create_quota_guard, get_header

guard = create_quota_guard(
    tiers={"free": QuotaTierConfig(max_requests=60, window_ms=60_000, max_page_size=50, max_page=20)},
    resolve_identity=lambda req: QuotaIdentity(
        account_id=get_header(req, "x-account-id"),  # demo only: use your session in production
        tier="free",
    ),
    on_quota_exceeded=lambda event: print(event.to_dict()),
)

result = await guard.check_request(req)   # QuotaRequest(url=..., headers=..., remote_address=...)
if not result.allowed:
    return JSONResponse(result.body, status_code=result.status, headers=result.headers)
page_size = result.pagination.page_size   # sanitized values for your data layer
offset = result.pagination.offset
```

FastAPI with the middleware (pagination attached per request):

```python
from fastapi import Depends, FastAPI
from quota_guard import QuotaPagination
from quota_guard.fastapi_integration import QuotaMiddleware, get_quota_pagination

app = FastAPI()
app.add_middleware(QuotaMiddleware, pagination_mode="clamp", resolve_identity=my_resolver)

@app.get("/api/records")
async def records(pagination: QuotaPagination = Depends(get_quota_pagination)):
    ...
```

Multi-instance deployments: share the window across processes with
`RedisQuotaStore`, given any async redis client exposing redis-py's
`eval(script, numkeys, *args)` shape - no redis package is imported by the
`quota_guard` package itself (redis-py appears only in the `[dev]` extra,
for the real-Redis integration tests):

```python
from quota_guard import create_quota_guard
from quota_guard.stores import RedisQuotaStore

guard = create_quota_guard(store=RedisQuotaStore(redis_client))
```

## Running

```bash
cd examples/python-fastapi
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"        # or: pip install fastapi pytest httpx
python -m pytest               # parity + store + HTTP tests (Redis suite skips)
REDIS_URL=redis://127.0.0.1:6379/15 python -m pytest   # + real-Redis integration tests
uvicorn app:app --port 8000    # demo app (uvicorn installed separately)
```

## Divergences from the TS module

Python and the frameworks force a few differences; everything else is kept
behavior-identical.

1. **Naming**: Python API is snake_case (`max_requests`, `check_request`,
   `page_size`). The wire surface is unchanged: header names/values, JSON
   body keys (`error`/`message`/`retryAfterSeconds`), the event dict from
   `QuotaExceededEvent.to_dict()`, and `QuotaPagination.to_dict()`
   (`page`/`pageSize`/`offset`/`clamped`).
2. **Middleware error path**: Express forwards guard errors via `next(err)`;
   Starlette's `BaseHTTPMiddleware` has no equivalent, so a guard exception
   propagates and surfaces as a 500 through the app's error handling.
3. **`PaginationParams` body shape**: the standalone dependency raises
   FastAPI's `HTTPException`, so rejections arrive as
   `{"detail": {...guard body...}}` with the same status and headers,
   instead of the raw guard body the middleware returns.
4. **Redis store details**: sorted-set members must be unique per hit, so
   each record uses a `"<now>:<uuid4hex>"` member (the in-memory stores
   append raw timestamps, duplicates included); keys are kept alive with
   `PEXPIRE` rather than deleted when a prune empties them; and there is no
   `max_entries` key cap - Redis memory management is the operator's.
5. **Header containers**: mapping headers are scanned case-insensitively
   (the TS plain-object path); non-mapping header objects are queried via
   their own `get()` (the TS Fetch-`Headers` path).
6. **Store capacity and unresolved identity (TS hardened after the port)**:
   the TS in-memory quota store now fails closed at its key cap (only
   expired windows are evicted; a new window is refused and the guard
   rejects with `store_capacity_exceeded`), and a request with no resolvable
   account/API key/IP is counted against a shared `unknown` bucket unless
   `allowUnresolvedIdentity` is set. This Python port still uses
   insertion-order eviction at the cap and still skips quota checks for
   fully unresolvable requests; both behaviors predate the TS hardening and
   are tracked divergences, not parity.

## Limitations and what the tests do NOT cover

- **peek → record is not one atomic operation** in either implementation
  (the TS store contract has the same shape): under heavy concurrency a few
  extra requests can slip between the check and the record. Each Redis
  operation is internally atomic (single Lua script), and the in-memory
  store is exact within one process, but the pair is not a transaction.
- The in-memory store is **per-process**: multiple workers each enforce
  their own window. Use `RedisQuotaStore` when more than one process serves
  traffic.
- The unit tests run the Redis store against an **in-memory fake** that
  emulates the sorted-set semantics of the two Lua scripts. A separate
  **real-Redis integration suite** (`tests/test_redis_integration.py`) does
  run the store against an actual server - the real Lua scripting engine,
  real pruning, real `PEXPIRE` TTLs, plus guard enforcement and
  per-identity isolation backed by Redis - and runs in CI
  (`.github/workflows/python.yml`) against a `redis:7` service container.
  It is opt-in locally: the module skips unless `REDIS_URL` is set (point
  it at a dedicated logical DB; the suite FLUSHDBs it). Still **not**
  covered: Redis failure modes (disconnects, timeouts, failover),
  Cluster/Sentinel topologies, and persistence behavior - the guard lets
  store exceptions propagate, as does the TS version.
- Tests do **not** cover: real concurrency/load behavior or race windows;
  multiple Uvicorn workers; a FastAPI/Starlette version matrix (developed
  against FastAPI 0.162 / Starlette 1.10); automated TS↔Python differential
  fuzzing (parity is pinned by the ported scenarios, not by random inputs);
  or any browser/REA observation claim - this is a server-side control, and
  per the repo rules no Playwright result would be REA data anyway.
- `uvicorn` is not a dependency of this example; the demo's import is
  tested, its live serving is not part of the test suite.
