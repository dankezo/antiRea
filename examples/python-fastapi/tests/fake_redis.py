"""In-memory stand-in for an async Redis client, used by the store tests.

Implements just the ``eval(script, numkeys, *args)`` surface that
``RedisQuotaStore`` calls, dispatching on the ``quota-guard:<op>`` marker
comment inside each Lua script and emulating the sorted-set semantics the
scripts rely on (inclusive-score pruning, ZCARD, oldest score, ZADD with a
unique member, PEXPIRE bookkeeping). It is a test double, not a Redis
emulator: it does not parse Lua and does not model expiry timing.
"""

from typing import Any


class FakeRedis:
    def __init__(self) -> None:
        self._zsets: dict[str, dict[str, float]] = {}
        self.expiries: dict[str, float] = {}

    async def eval(self, script: str, numkeys: int, *args: Any) -> Any:
        key = args[0]
        now = float(args[1])
        window = float(args[2])
        zset = self._zsets.setdefault(key, {})
        # ZREMRANGEBYSCORE key -inf (now - window), inclusive — same prune
        # rule as the Lua scripts and the TS store (keep now - t < window).
        for member in [m for m, score in zset.items() if score <= now - window]:
            del zset[member]
        if "quota-guard:peek" in script:
            if not zset:
                return [0, -1]
            return [len(zset), min(zset.values())]
        if "quota-guard:record" in script:
            member = args[3]
            zset[member] = now
            self.expiries[key] = window
            return 1
        raise ValueError(f"FakeRedis does not know this script: {script[:60]!r}")
