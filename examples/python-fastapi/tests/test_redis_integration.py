"""Real-Redis integration tests for :class:`RedisQuotaStore`.

Unlike ``test_stores.py`` (which runs the store against the in-memory
``FakeRedis`` stub), these tests talk to an actual Redis server, so the two
Lua scripts in ``quota_guard/stores.py`` run under Redis's real scripting
engine — real sorted sets, real ``ZREMRANGEBYSCORE`` pruning, real
``PEXPIRE`` TTLs.

The whole module is opt-in: it is skipped unless ``REDIS_URL`` is set, e.g.

    REDIS_URL=redis://127.0.0.1:6379/15 python -m pytest

Point ``REDIS_URL`` at a *dedicated logical database* (``/15`` above): an
autouse fixture FLUSHDBs it before and after every test, so runs are
isolated and repeatable and never touch other data in DBs 0-14. CI runs
this module against a ``redis:7`` service container (see
``.github/workflows/python.yml``).

This module is test-only: ``quota_guard`` itself never imports ``redis``;
the store stays duck-typed against any client with redis-py's
``eval(script, numkeys, *args)`` shape.
"""

import asyncio
import os
import time

import pytest

REDIS_URL = os.environ.get("REDIS_URL", "")

pytestmark = pytest.mark.skipif(
    not REDIS_URL,
    reason="REDIS_URL not set; real-Redis integration tests are opt-in",
)

redis = pytest.importorskip("redis", reason="redis package not installed (.[dev] extra)")
from redis import asyncio as redis_async  # noqa: E402

from conftest import mock_req, run  # noqa: E402
from quota_guard import QuotaIdentity, QuotaTierConfig, create_quota_guard  # noqa: E402
from quota_guard.stores import RedisQuotaStore  # noqa: E402

WINDOW = 60_000


@pytest.fixture(autouse=True)
def _flush_redis_db():
    """Isolate each test in the REDIS_URL logical DB (flush before/after).

    Uses a short-lived *sync* client so the fixture never shares an event
    loop with the per-test ``asyncio.run`` scenarios. Skips (rather than
    fails) when REDIS_URL points at an unreachable server.
    """
    client = redis.Redis.from_url(REDIS_URL, socket_connect_timeout=5)
    try:
        try:
            client.ping()
        except redis.RedisError as exc:
            pytest.skip(f"REDIS_URL is set but the server is unreachable: {exc}")
        client.flushdb()
        yield
        client.flushdb()
    finally:
        client.close()


def _client() -> "redis_async.Redis":
    return redis_async.from_url(REDIS_URL, socket_connect_timeout=5)


def test_window_counting_against_real_redis():
    async def scenario():
        client = _client()
        try:
            store = RedisQuotaStore(client)
            key = "itest:counting"
            snap = await store.peek(key, 1_000, WINDOW)
            assert (snap.count, snap.oldest) == (0, None)
            for t in (1_000, 1_000, 2_000, 3_500):
                await store.record(key, t, WINDOW)
            snap = await store.peek(key, 4_000, WINDOW)
            assert (snap.count, snap.oldest) == (4, 1_000)
            # Server-side truth, not just store bookkeeping: 4 members
            # (same-ms records are distinct members thanks to the uuid
            # suffix) really live in the sorted set.
            assert await client.zcard(key) == 4
        finally:
            await client.aclose()

    run(scenario())


def test_pruning_of_expired_entries_against_real_redis():
    async def scenario():
        client = _client()
        try:
            store = RedisQuotaStore(client)
            key = "itest:pruning"
            await store.record(key, 1_000, WINDOW)
            await store.record(key, 1_000, WINDOW)
            await store.record(key, 2_000, WINDOW)
            # Peeking exactly one window past t=1000 prunes those entries
            # (store contract: now - t < window survives).
            snap = await store.peek(key, 1_000 + WINDOW, WINDOW)
            assert (snap.count, snap.oldest) == (1, 2_000)
            # The prune really happened in Redis, inside the Lua script.
            assert await client.zcard(key) == 1
            snap = await store.peek(key, 2_000 + WINDOW, WINDOW)
            assert (snap.count, snap.oldest) == (0, None)
            assert await client.zcard(key) == 0
        finally:
            await client.aclose()

    run(scenario())


def test_record_sets_key_expiry_against_real_redis():
    async def scenario():
        client = _client()
        try:
            store = RedisQuotaStore(client)
            key = "itest:ttl"
            assert await client.pttl(key) == -2  # key does not exist yet
            await store.record(key, 1_000, WINDOW)
            pttl = await client.pttl(key)
            assert 0 < pttl <= WINDOW
        finally:
            await client.aclose()

    run(scenario())


def test_entries_expire_in_real_time():
    async def scenario():
        client = _client()
        try:
            store = RedisQuotaStore(client)
            key = "itest:realtime"
            window = 1_000
            await store.record(key, time.time() * 1000, window)
            snap = await store.peek(key, time.time() * 1000, window)
            assert snap.count == 1
            await asyncio.sleep(1.2)
            snap = await store.peek(key, time.time() * 1000, window)
            assert snap.count == 0
        finally:
            await client.aclose()

    run(scenario())


def test_guard_enforcement_backed_by_real_redis():
    async def scenario():
        client = _client()
        try:
            events = []
            guard = create_quota_guard(
                store=RedisQuotaStore(client),
                tiers={
                    "free": QuotaTierConfig(
                        max_requests=3, window_ms=30_000, max_page_size=20, max_page=5
                    )
                },
                resolve_identity=lambda req: QuotaIdentity(account_id="acc-1", tier="free"),
                on_quota_exceeded=events.append,
            )
            for _ in range(3):
                result = await guard.check_request(mock_req("/api/items"))
                assert result.allowed is True
            denied = await guard.check_request(mock_req("/api/items"))
            assert denied.allowed is False
            assert denied.status == 429
            assert denied.body["error"] == "rate_limit_exceeded"
            retry_after = int(denied.headers["Retry-After"])
            assert 1 <= retry_after <= 30
            assert denied.body["retryAfterSeconds"] == retry_after
            assert denied.headers["X-RateLimit-Remaining"] == "0"
            assert len(events) == 1
            assert events[0].dimension == "account"
            assert events[0].limit == 3
        finally:
            await client.aclose()

    run(scenario())


def test_guard_identity_isolation_against_real_redis():
    async def scenario():
        client = _client()
        try:
            identities = {
                "acc-a": QuotaIdentity(account_id="acc-a", tier="free"),
                "acc-b": QuotaIdentity(account_id="acc-b", tier="free"),
            }
            guard = create_quota_guard(
                store=RedisQuotaStore(client),
                tiers={
                    "free": QuotaTierConfig(
                        max_requests=2, window_ms=30_000, max_page_size=20, max_page=5
                    )
                },
                resolve_identity=lambda req: identities[req.headers["x-account"]],
            )
            req_a = mock_req("/api/items", headers={"x-account": "acc-a"})
            req_b = mock_req("/api/items", headers={"x-account": "acc-b"})
            assert (await guard.check_request(req_a)).allowed is True
            assert (await guard.check_request(req_a)).allowed is True
            assert (await guard.check_request(req_a)).allowed is False
            # acc-a is saturated, but acc-b's window is untouched.
            assert (await guard.check_request(req_b)).allowed is True
            assert await client.zcard("account:acc-a") == 2
            assert await client.zcard("account:acc-b") == 1
        finally:
            await client.aclose()

    run(scenario())
