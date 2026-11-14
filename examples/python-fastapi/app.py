"""Demo FastAPI application wiring the quota guard end to end.

Run it with::

    pip install fastapi uvicorn
    uvicorn app:app --port 8000

Then, for example::

    # anonymous tier: 30 requests/minute, page size <= 25, page <= 5
    curl 'http://localhost:8000/api/records?limit=10&page=2'
    curl 'http://localhost:8000/api/records?limit=500'        # 429 page_size_exceeded

DEMO-ONLY identity resolution: ``demo_resolve_identity`` reads the account,
API key and tier from ``x-demo-*`` headers so the example is easy to poke at
with curl. A production app must NEVER do this - identity has to come from
your own server-side session/auth middleware (that is the whole point of the
``resolve_identity`` contract, in both the TS and Python versions). Here the
headers stand in for whatever your auth layer would put on the request.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import Depends, FastAPI

from quota_guard import QuotaIdentity, QuotaPagination, QuotaRequest, get_header
from quota_guard.fastapi_integration import QuotaMiddleware, get_quota_pagination


def demo_resolve_identity(req: QuotaRequest) -> Optional[QuotaIdentity]:
    return QuotaIdentity(
        account_id=get_header(req, "x-demo-account"),
        api_key_id=get_header(req, "x-demo-apikey"),
        tier=get_header(req, "x-demo-tier"),
    )


def create_app() -> FastAPI:
    app = FastAPI(title="antiRea quota-guard - FastAPI example")
    app.add_middleware(
        QuotaMiddleware,
        pagination_mode="clamp",
        resolve_identity=demo_resolve_identity,
    )

    @app.get("/api/records")
    async def records(pagination: QuotaPagination = Depends(get_quota_pagination)) -> dict[str, Any]:
        # A real handler would pass pagination.page_size / pagination.offset
        # to its data layer; the demo just echoes the sanitized values.
        return {"items": [], "pagination": pagination.to_dict()}

    return app


app = create_app()
