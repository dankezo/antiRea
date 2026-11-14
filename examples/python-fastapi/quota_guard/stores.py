"""Sliding-window storage for the quota guard.

Mirrors the ``QuotaWindowStore`` contract of ``src/tier2-active/quota-guard.ts``:
implementations must prune entries older than ``window_ms`` relative to ``now``
inside both operations. ``peek``/``record`` may be plain (synchronous) or
return an awaitable; the guard awaits awaitable results.

Two implementations are provided:

- :class:`InMemoryQuotaStore` - bounded single-process store, a direct port of
  the TS ``createInMemoryQuotaStore`` (same prune rule, same insertion-order
  eviction once the distinct-key cap is exceeded).
- :class:`RedisQuotaStore` - shared store for multi-instance deployments,
  written against a duck-typed async Redis client (anything exposing an
  ``eval(script, numkeys, *args)`` coroutine compatible with redis-py's
  ``eval``). Each operation runs as a single Lua script, so prune+count and
  prune+add are atomic per operation. No ``redis`` package is imported.
"""

from __future__ import annotations

import math
import uuid
from dataclasses import dataclass
from typing import Any, Optional, Protocol, runtime_checkable


@dataclass
class QuotaWindowSnapshot:
    count: int
    #: Timestamp (ms) of the oldest request still inside the window, if any.
    oldest: Optional[float] = None


@runtime_checkable
class QuotaWindowStore(Protocol):
    """Storage contract for sliding windows (see module docstring)."""

    def peek(self, key: str, now: float, window_ms: float) -> Any:
        """Return a QuotaWindowSnapshot (or an awaitable of one)."""
        ...

    def record(self, key: str, now: float, window_ms: float) -> Any:
        """Record one hit at ``now`` (or return an awaitable of None)."""
        ...


def _coerce_cap(max_entries: Any) -> int:
    """Match the TS cap coercion: ``Math.max(100, Math.floor(n) || 10_000)``."""
    try:
        floored = math.floor(max_entries)
    except (TypeError, ValueError):
        floored = 0
    if not floored:
        floored = 10_000
    return max(100, floored)


class InMemoryQuotaStore:
    """Bounded in-memory sliding-window store (port of the TS default store).

    Expired timestamps are pruned on every access and the key set is capped:
    when a ``record`` pushes the store past the cap, the least recently
    recorded keys are evicted first (insertion order, as with the TS ``Map``).
    """

    def __init__(self, max_entries: int = 10_000) -> None:
        self._cap = _coerce_cap(max_entries)
        self._windows: dict[str, list[float]] = {}

    def _prune(self, key: str, now: float, window_ms: float) -> list[float]:
        entries = self._windows.get(key)
        if not entries:
            return []
        fresh = [t for t in entries if now - t < window_ms]
        if not fresh:
            del self._windows[key]
        elif len(fresh) != len(entries):
            self._windows[key] = fresh
        return fresh

    def peek(self, key: str, now: float, window_ms: float) -> QuotaWindowSnapshot:
        fresh = self._prune(key, now, window_ms)
        return QuotaWindowSnapshot(count=len(fresh), oldest=min(fresh) if fresh else None)

    def record(self, key: str, now: float, window_ms: float) -> None:
        fresh = self._prune(key, now, window_ms)
        fresh.append(now)
        # Re-insert so the key becomes the most recently recorded one.
        self._windows.pop(key, None)
        self._windows[key] = fresh
        while len(self._windows) > self._cap:
            oldest_key = next(iter(self._windows))
            del self._windows[oldest_key]


def create_in_memory_quota_store(max_entries: int = 10_000) -> InMemoryQuotaStore:
    """Factory mirroring the TS ``createInMemoryQuotaStore``."""
    return InMemoryQuotaStore(max_entries)


# Lua scripts for RedisQuotaStore. Each carries a ``quota-guard:<op>`` marker
# comment so test doubles can dispatch on the operation. Pruning uses an
# inclusive max score of ``now - window``: the TS prune keeps entries with
# ``now - t < window_ms``, i.e. drops ``t <= now - window_ms`` - exactly what
# ZREMRANGEBYSCORE with an inclusive upper bound removes.
_PEEK_SCRIPT = """
-- quota-guard:peek
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count == 0 then
  return {0, -1}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {count, tonumber(oldest[2])}
"""

_RECORD_SCRIPT = """
-- quota-guard:record
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return 1
"""


class RedisQuotaStore:
    """Sliding-window store backed by a Redis sorted set per dimension key.

    ``client`` is duck-typed: any object with an async
    ``eval(script, numkeys, key, *args)`` method shaped like redis-py's
    (for example ``redis.asyncio.Redis``). No redis library is imported here,
    so the dependency stays optional for the host application.

    Divergences from the in-memory store (also listed in the README):
    members must be unique per hit, so each record uses a
    ``"<now>:<uuid4hex>"`` member (the TS in-memory store simply appends the
    timestamp, duplicates included); keys are expired with ``PEXPIRE`` instead
    of being deleted when emptied by a prune; and there is no ``max_entries``
    key cap - memory is the Redis server's concern.
    """

    def __init__(self, client: Any) -> None:
        self._client = client

    async def peek(self, key: str, now: float, window_ms: float) -> QuotaWindowSnapshot:
        result = await self._client.eval(_PEEK_SCRIPT, 1, key, now, window_ms)
        count = int(result[0])
        raw_oldest = result[1] if len(result) > 1 else None
        oldest: Optional[float] = None
        if raw_oldest is not None and float(raw_oldest) >= 0:
            oldest = float(raw_oldest)
        return QuotaWindowSnapshot(count=count, oldest=oldest)

    async def record(self, key: str, now: float, window_ms: float) -> None:
        member = f"{now}:{uuid.uuid4().hex}"
        await self._client.eval(_RECORD_SCRIPT, 1, key, now, window_ms, member)
