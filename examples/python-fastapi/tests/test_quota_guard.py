"""Parity tests for the quota guard core.

The first test ports, assertion for assertion, the TS test
'server quota guard enforces per-account, per-API-key, and per-IP tier quotas
with 429 Retry-After and logs events' from ``tests/core.test.cjs``. The
remaining tests pin down behaviors the TS source specifies but its suite
asserts only indirectly (header values on success, exact rejection messages,
no quota consumption on pagination rejection, clock/window sliding, tier
fallback, JS ``parseInt`` query parsing).
"""

from conftest import mock_req, run
from quota_guard import (
    DEFAULT_QUOTA_TIERS,
    QuotaGuard,
    QuotaIdentity,
    QuotaTierConfig,
    create_quota_guard,
    get_header,
)

T0 = 1_700_000_000_000


def _ts_spec_guard(events, clock):
    """The exact guard configuration used by the TS core test."""
    return create_quota_guard(
        now=clock,
        trusted_ip_header="x-real-ip",
        tiers={
            "free": QuotaTierConfig(max_requests=2, window_ms=60_000, max_page_size=20, max_page=5),
            "pro": QuotaTierConfig(max_requests=5, window_ms=60_000, max_page_size=100, max_page=50),
        },
        resolve_identity=lambda req: QuotaIdentity(
            account_id=get_header(req, "x-test-account"),
            api_key_id=get_header(req, "x-test-apikey"),
            tier=get_header(req, "x-test-tier") or "free",
        ),
        on_quota_exceeded=events.append,
    )


def test_ts_core_scenario_account_apikey_ip_quotas_and_events():
    events = []
    guard = _ts_spec_guard(events, lambda: T0)

    # 1. Account on 'free' tier allowed 2 requests, 3rd returns 429 with Retry-After
    r1 = run(guard.check_request(mock_req("/api/items?page=1&limit=10", {"x-test-account": "acc-1", "x-real-ip": "203.0.113.5"})))
    r2 = run(guard.check_request(mock_req("/api/items?page=2&limit=10", {"x-test-account": "acc-1", "x-real-ip": "203.0.113.5"})))
    r3 = run(guard.check_request(mock_req("/api/items?page=3&limit=10", {"x-test-account": "acc-1", "x-real-ip": "203.0.113.5"})))
    assert r1.allowed is True
    assert r2.allowed is True
    assert r3.allowed is False
    assert r3.status == 429
    assert r3.headers["Retry-After"] == "60"
    assert len(events) == 1
    assert events[0].kind == "rate_limit_exceeded"
    assert events[0].dimension == "account"
    assert events[0].account_id == "acc-1"

    # 2. Pro tier API key gets higher quota and page size
    pro_req = run(guard.check_request(mock_req("/api/items?page=10&limit=80", {"x-test-apikey": "key-pro-9", "x-test-tier": "pro"})))
    assert pro_req.allowed is True
    assert pro_req.pagination.page_size == 80
    assert pro_req.pagination.page == 10

    # 3. Exceeding maxPageSize or maxPage triggers 429 + Retry-After + operator log
    over_size = run(guard.check_request(mock_req("/api/items?limit=500", {"x-test-account": "acc-2", "x-test-tier": "free"})))
    assert over_size.allowed is False
    assert over_size.status == 429
    assert over_size.body["error"] == "page_size_exceeded"
    assert over_size.headers["Retry-After"] == "60"

    over_page = run(guard.check_request(mock_req("/api/items?page=99&limit=10", {"x-test-account": "acc-2", "x-test-tier": "free"})))
    assert over_page.allowed is False
    assert over_page.status == 429
    assert over_page.body["error"] == "max_page_exceeded"
    assert len(events) == 3
    assert events[1].kind == "page_size_exceeded"
    assert events[2].kind == "max_page_exceeded"


def test_allowed_response_headers_track_primary_dimension():
    events = []
    guard = _ts_spec_guard(events, lambda: T0)
    r1 = run(guard.check_request(mock_req("/api/items?limit=10", {"x-test-account": "acc-1", "x-real-ip": "203.0.113.5"})))
    assert r1.headers == {
        "X-RateLimit-Limit": "2",
        "X-RateLimit-Remaining": "1",
        "X-RateLimit-Reset": "1700000060",
    }
    r2 = run(guard.check_request(mock_req("/api/items?limit=10", {"x-test-account": "acc-1", "x-real-ip": "203.0.113.5"})))
    assert r2.headers["X-RateLimit-Remaining"] == "0"
    assert r2.headers["X-RateLimit-Reset"] == "1700000060"
    assert r2.body is None


def test_rejection_shape_and_exact_messages():
    events = []
    guard = _ts_spec_guard(events, lambda: T0)

    over_size = run(guard.check_request(mock_req("/api/items?limit=500", {"x-test-account": "acc-2"})))
    assert over_size.body == {
        "error": "page_size_exceeded",
        "message": "Requested page size exceeds the free tier maximum of 20.",
        "retryAfterSeconds": 60,
    }
    assert over_size.headers["X-RateLimit-Limit"] == "2"
    assert over_size.headers["X-RateLimit-Remaining"] == "0"
    assert "X-RateLimit-Reset" not in over_size.headers
    # Rejected pagination reports the tier maximum as the effective page size.
    assert over_size.pagination.page_size == 20

    over_page = run(guard.check_request(mock_req("/api/items?page=99", {"x-test-account": "acc-2"})))
    assert over_page.body["message"] == "Requested page exceeds the free tier maximum depth of 5."

    for _ in range(2):
        run(guard.check_request(mock_req("/api/items", {"x-test-account": "acc-3"})))
    limited = run(guard.check_request(mock_req("/api/items", {"x-test-account": "acc-3"})))
    assert limited.body["message"] == "Too many requests; slow down and retry after the indicated interval."
    assert limited.body["retryAfterSeconds"] == 60


def test_event_payload_matches_ts_shape():
    events = []
    guard = _ts_spec_guard(events, lambda: T0)
    run(guard.check_request(mock_req("/api/items?limit=500", {"x-test-account": "acc-2", "x-real-ip": "203.0.113.9"})))
    assert events[0].to_dict() == {
        "kind": "page_size_exceeded",
        "dimension": "account",
        "accountId": "acc-2",
        "ip": "203.0.113.9",
        "tier": "free",
        "limit": 20,
        "retryAfterSeconds": 60,
        "timestamp": "2023-11-14T22:13:20.000Z",
    }


def test_pagination_rejection_consumes_no_quota():
    events = []
    guard = create_quota_guard(
        now=lambda: T0,
        tiers={"free": QuotaTierConfig(max_requests=1, window_ms=60_000, max_page_size=20, max_page=5)},
        resolve_identity=lambda req: QuotaIdentity(account_id="acc-1", tier="free"),
        on_quota_exceeded=events.append,
    )
    rejected = run(guard.check_request(mock_req("/api/items?limit=500")))
    assert rejected.allowed is False
    # The single quota slot is still available afterwards...
    allowed = run(guard.check_request(mock_req("/api/items?limit=10")))
    assert allowed.allowed is True
    # ...and exactly one hit was recorded.
    limited = run(guard.check_request(mock_req("/api/items?limit=10")))
    assert limited.allowed is False
    assert limited.body["error"] == "rate_limit_exceeded"


def test_clamp_mode_sanitizes_pagination_like_ts_middleware_case():
    # Same numbers as the TS Express-middleware test, exercised at guard level.
    guard = create_quota_guard(
        tiers={"free": QuotaTierConfig(max_requests=1, window_ms=30_000, max_page_size=15, max_page=3)},
        pagination_mode="clamp",
    )
    result = run(guard.check_request(mock_req("/api/records?limit=999&page=10", remote_address="198.51.100.7")))
    assert result.allowed is True
    assert result.pagination.to_dict() == {"page": 3, "pageSize": 15, "offset": 30, "clamped": True}


def test_window_slides_and_retry_after_counts_down():
    events = []
    clock = {"t": T0}
    guard = create_quota_guard(
        now=lambda: clock["t"],
        tiers={"free": QuotaTierConfig(max_requests=1, window_ms=60_000, max_page_size=20, max_page=5)},
        resolve_identity=lambda req: QuotaIdentity(account_id="acc-1", tier="free"),
        on_quota_exceeded=events.append,
    )
    assert run(guard.check_request(mock_req("/api/items"))).allowed is True
    clock["t"] = T0 + 30_000
    denied = run(guard.check_request(mock_req("/api/items")))
    assert denied.allowed is False
    assert denied.headers["Retry-After"] == "30"
    clock["t"] = T0 + 60_000  # first hit is exactly one window old: pruned
    assert run(guard.check_request(mock_req("/api/items"))).allowed is True


def test_ip_and_apikey_dimensions_are_reported():
    events = []
    guard = create_quota_guard(
        now=lambda: T0,
        tiers={"free": QuotaTierConfig(max_requests=1, window_ms=60_000, max_page_size=20, max_page=5)},
        resolve_identity=lambda req: QuotaIdentity(
            api_key_id=get_header(req, "x-test-apikey"), tier="free"
        ),
        on_quota_exceeded=events.append,
    )
    run(guard.check_request(mock_req("/api/items", remote_address="198.51.100.7")))
    by_ip = run(guard.check_request(mock_req("/api/items", remote_address="198.51.100.7")))
    assert by_ip.allowed is False
    assert events[-1].dimension == "ip"

    run(guard.check_request(mock_req("/api/items", {"x-test-apikey": "k-1"}, remote_address="198.51.100.8")))
    by_key = run(guard.check_request(mock_req("/api/items", {"x-test-apikey": "k-1"}, remote_address="198.51.100.9")))
    assert by_key.allowed is False
    assert events[-1].dimension == "apiKey"


def test_trusted_ip_header_takes_first_forwarded_address():
    guard = _ts_spec_guard([], lambda: T0)
    result = run(guard.check_request(mock_req("/api/items", {"x-test-account": "a", "x-real-ip": "203.0.113.5, 10.0.0.1"})))
    assert result.identity.ip == "203.0.113.5"


def test_default_tiers_and_unidentified_request():
    guard = create_quota_guard(now=lambda: T0)
    assert guard.tiers == DEFAULT_QUOTA_TIERS
    result = run(guard.check_request(mock_req("/api/items")))
    assert result.allowed is True
    assert result.tier == "anonymous"
    # No dimension resolved: nothing recorded, full headroom reported.
    assert result.headers["X-RateLimit-Limit"] == "30"
    assert result.headers["X-RateLimit-Remaining"] == "30"
    assert result.pagination.to_dict() == {"page": 1, "pageSize": 20, "offset": 0, "clamped": False}


def test_unknown_tier_falls_back_to_anonymous_config_keeping_name():
    guard = create_quota_guard(
        now=lambda: T0,
        tiers={"free": QuotaTierConfig(max_requests=7, window_ms=60_000, max_page_size=50, max_page=20)},
        resolve_identity=lambda req: QuotaIdentity(account_id="a", tier="weird"),
    )
    result = run(guard.check_request(mock_req("/api/items")))
    assert result.tier == "weird"
    assert result.headers["X-RateLimit-Limit"] == "7"


def test_query_parsing_matches_js_parseint_and_param_precedence():
    guard = create_quota_guard(now=lambda: T0)  # anonymous: maxPageSize 25, default size 20

    def page_size(url):
        return run(guard.check_request(mock_req(url))).pagination.page_size

    assert page_size("/api/items?limit=10abc") == 10  # parseInt stops at first non-digit
    assert page_size("/api/items?limit=10.9") == 10
    assert page_size("/api/items?limit=abc") == 20  # unparseable -> default
    assert page_size("/api/items?pageSize=7") == 7  # pageSize used when limit absent
    assert page_size("/api/items?limit=&pageSize=7") == 20  # present-but-blank limit wins, then defaults
    assert page_size("/api/items?limit=0") == 20  # < 1 -> default
    assert page_size("/api/items?limit=3&limit=9") == 3  # first value wins


def test_offset_derives_page():
    guard = create_quota_guard(now=lambda: T0)
    result = run(guard.check_request(mock_req("/api/items?offset=30&limit=10")))
    assert result.pagination.to_dict() == {"page": 4, "pageSize": 10, "offset": 30, "clamped": False}


def test_event_sink_errors_are_swallowed_and_async_hooks_supported():
    seen = []

    async def resolver(req):
        return QuotaIdentity(account_id="acc-1", tier="free")

    async def sink(event):
        seen.append(event)
        raise RuntimeError("logging backend down")

    guard = create_quota_guard(
        now=lambda: T0,
        tiers={"free": QuotaTierConfig(max_requests=1, window_ms=60_000, max_page_size=20, max_page=5)},
        resolve_identity=resolver,
        on_quota_exceeded=sink,
    )
    assert run(guard.check_request(mock_req("/api/items"))).allowed is True
    denied = run(guard.check_request(mock_req("/api/items")))
    assert denied.allowed is False  # sink raised, request handling unaffected
    assert len(seen) == 1
