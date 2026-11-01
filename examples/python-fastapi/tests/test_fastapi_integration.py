"""FastAPI/Starlette integration tests.

The first test ports, through real HTTP via Starlette's TestClient, the TS
test 'Express quota middleware attaches sanitized pagination and blocks when
quota exceeded' from ``tests/core.test.cjs``: clamp mode sanitizes
``limit=999&page=10`` to ``{page: 3, pageSize: 15, offset: 30, clamped: true}``
and the second request from the same client is rejected 429 with
``Retry-After: 30``. (The TS test pins the numbers with a fake clock; here
the real clock is used and 30s is the only possible Retry-After value for a
30s window, up to sub-second elapsed time.)
"""

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app import create_app as create_demo_app
from quota_guard import QuotaPagination, QuotaTierConfig, create_quota_guard
from quota_guard.fastapi_integration import QuotaMiddleware, PaginationParams, get_quota_pagination


def _records_app(**middleware_options):
    app = FastAPI()
    app.add_middleware(QuotaMiddleware, **middleware_options)

    @app.get("/api/records")
    async def records(pagination: QuotaPagination = Depends(get_quota_pagination)):
        return {"pagination": pagination.to_dict()}

    return app


def test_middleware_clamps_pagination_then_blocks_second_request():
    client = TestClient(
        _records_app(
            tiers={"free": QuotaTierConfig(max_requests=1, window_ms=30_000, max_page_size=15, max_page=3)},
            pagination_mode="clamp",
        )
    )
    r1 = client.get("/api/records?limit=999&page=10")
    assert r1.status_code == 200
    assert r1.json()["pagination"] == {"page": 3, "pageSize": 15, "offset": 30, "clamped": True}
    # Rate-limit headers are merged into the successful response.
    assert r1.headers["x-ratelimit-limit"] == "1"
    assert r1.headers["x-ratelimit-remaining"] == "0"

    r2 = client.get("/api/records?limit=5&page=1")
    assert r2.status_code == 429
    assert r2.headers["retry-after"] == "30"
    assert r2.headers["x-ratelimit-remaining"] == "0"
    assert r2.json()["error"] == "rate_limit_exceeded"


def test_middleware_reject_mode_returns_guard_body_and_headers():
    client = TestClient(
        _records_app(
            tiers={"anonymous": QuotaTierConfig(max_requests=10, window_ms=60_000, max_page_size=20, max_page=5)},
        )
    )
    response = client.get("/api/records?limit=500")
    assert response.status_code == 429
    body = response.json()
    assert body["error"] == "page_size_exceeded"
    assert body["retryAfterSeconds"] == 60
    assert response.headers["retry-after"] == "60"


def test_demo_app_end_to_end():
    client = TestClient(create_demo_app())
    ok = client.get("/api/records?limit=10&page=2")
    assert ok.status_code == 200
    assert ok.json()["pagination"] == {"page": 2, "pageSize": 10, "offset": 10, "clamped": False}
    assert ok.headers["x-ratelimit-limit"] == "30"  # anonymous default tier

    clamped = client.get("/api/records?limit=500", headers={"x-demo-tier": "pro"})
    assert clamped.status_code == 200  # demo app runs in clamp mode
    assert clamped.json()["pagination"]["pageSize"] == 200  # pro max page size
    assert clamped.json()["pagination"]["clamped"] is True
    assert clamped.headers["x-ratelimit-limit"] == "300"


def test_pagination_params_dependency_standalone():
    guard = create_quota_guard(
        tiers={"anonymous": QuotaTierConfig(max_requests=10, window_ms=60_000, max_page_size=20, max_page=5)}
    )
    params = PaginationParams(guard)
    app = FastAPI()

    @app.get("/api/items")
    async def items(pagination: QuotaPagination = Depends(params)):
        return {"pagination": pagination.to_dict()}

    client = TestClient(app)
    ok = client.get("/api/items?limit=10&page=2")
    assert ok.status_code == 200
    assert ok.json()["pagination"] == {"page": 2, "pageSize": 10, "offset": 10, "clamped": False}

    over = client.get("/api/items?limit=500")
    assert over.status_code == 429
    # FastAPI wraps HTTPException payloads under "detail" (documented divergence).
    assert over.json()["detail"]["error"] == "page_size_exceeded"
    assert over.headers["retry-after"] == "60"


def test_get_quota_pagination_without_middleware_is_a_wiring_error():
    app = FastAPI()

    @app.get("/api/records")
    async def records(pagination: QuotaPagination = Depends(get_quota_pagination)):
        return {"pagination": pagination.to_dict()}

    client = TestClient(app, raise_server_exceptions=False)
    assert client.get("/api/records").status_code == 500
