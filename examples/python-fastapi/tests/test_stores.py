"""Store tests: the bounded in-memory store (TS parity) and RedisQuotaStore
against the FakeRedis stub (no real Redis server involved)."""

from conftest import mock_req, run
from fake_redis import FakeRedis
from quota_guard import (
    InMemoryQuotaStore,
    QuotaIdentity,
    QuotaTierConfig,
    RedisQuotaStore,
    create_quota_guard,
)

WINDOW = 60_000


def test_in_memory_peek_record_and_oldest():
    store = InMemoryQuotaStore()
    snap = store.peek("k", 1_000, WINDOW)
    assert (snap.count, snap.oldest) == (0, None)
    store.record("k", 1_000, WINDOW)
    store.record("k", 2_000, WINDOW)
    snap = store.peek("k", 3_000, WINDOW)
    assert (snap.count, snap.oldest) == (2, 1_000)


def test_in_memory_prune_boundary_matches_ts():
    store = InMemoryQuotaStore()
    store.record("k", 1_000, WINDOW)
    # now - t < window keeps the entry; exactly one window old prunes it.
    assert store.peek("k", 1_000 + WINDOW - 1, WINDOW).count == 1
    snap = store.peek("k", 1_000 + WINDOW, WINDOW)
    assert (snap.count, snap.oldest) == (0, None)


def test_in_memory_cap_evicts_least_recently_recorded_key():
    store = InMemoryQuotaStore(100)
    assert store._cap == 100
    for i in range(100):
        store.record(f"k{i}", 1_000, WINDOW)
    store.record("k0", 1_000, WINDOW)  # re-recording makes k0 most recent
    store.record("k100", 1_000, WINDOW)  # 101st key: evict the oldest, k1
    assert store.peek("k1", 1_000, WINDOW).count == 0
    assert store.peek("k0", 1_000, WINDOW).count == 2  # both hits at t=1000 kept
    assert store.peek("k100", 1_000, WINDOW).count == 1


def test_in_memory_cap_floor_is_100():
    assert InMemoryQuotaStore(5)._cap == 100
    assert InMemoryQuotaStore(0)._cap == 10_000  # TS: Math.floor(0) || 10_000


def test_redis_store_peek_record_and_prune():
    async def scenario():
        store = RedisQuotaStore(FakeRedis())
        snap = await store.peek("ip:203.0.113.5", 1_000, WINDOW)
        assert (snap.count, snap.oldest) == (0, None)
        await store.record("ip:203.0.113.5", 1_000, WINDOW)
        await store.record("ip:203.0.113.5", 1_000, WINDOW)  # same ms: unique members, both count
        await store.record("ip:203.0.113.5", 2_000, WINDOW)
        snap = await store.peek("ip:203.0.113.5", 3_000, WINDOW)
        assert (snap.count, snap.oldest) == (3, 1_000)
        snap = await store.peek("ip:203.0.113.5", 1_000 + WINDOW, WINDOW)
        assert (snap.count, snap.oldest) == (1, 2_000)  # t=1000 entries pruned at the boundary

    run(scenario())


def test_redis_store_keys_are_independent():
    async def scenario():
        store = RedisQuotaStore(FakeRedis())
        await store.record("account:a", 1_000, WINDOW)
        assert (await store.peek("account:b", 1_000, WINDOW)).count == 0
        assert (await store.peek("account:a", 1_000, WINDOW)).count == 1

    run(scenario())


def test_guard_enforces_quota_through_redis_store():
    events = []

    async def scenario():
        guard = create_quota_guard(
            now=lambda: 1_700_000_000_000,
            store=RedisQuotaStore(FakeRedis()),
            tiers={"free": QuotaTierConfig(max_requests=2, window_ms=WINDOW, max_page_size=20, max_page=5)},
            resolve_identity=lambda req: QuotaIdentity(account_id="acc-1", tier="free"),
            on_quota_exceeded=events.append,
        )
        assert (await guard.check_request(mock_req("/api/items"))).allowed is True
        assert (await guard.check_request(mock_req("/api/items"))).allowed is True
        denied = await guard.check_request(mock_req("/api/items"))
        assert denied.allowed is False
        assert denied.headers["Retry-After"] == "60"

    run(scenario())
    assert len(events) == 1
    assert events[0].dimension == "account"
