"""Server-side quota and pagination guard (P0 control) — Python port.

A semantic port of ``src/tier2-active/quota-guard.ts``. It enforces
per-account, per-API-key and per-IP sliding-window request quotas plus
per-query record (``limit``/``pageSize``) and page-depth (``page``/``offset``)
bounds, configured per plan tier. This is an abuse-cost control for YOUR OWN
API: it cannot stop a determined client, and an IP address or API key alone
is never proof of intent. Identity must come from your authenticated server
session (see ``resolve_identity``), never from unverified client claims.

The default store is a single-process in-memory window. In a horizontally
scaled deployment, supply a shared ``store`` (for example
:class:`quota_guard.stores.RedisQuotaStore`) so every instance enforces the
same window.

Naming follows Python convention (snake_case); the wire surface is identical
to the TS module: header names/values, the rejection JSON body keys
(``error``/``message``/``retryAfterSeconds``) and the pagination dict shape
(``page``/``pageSize``/``offset``/``clamped``, via ``QuotaPagination.to_dict``).
"""

from __future__ import annotations

import inspect
import math
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Literal, Mapping, Optional, Union
from urllib.parse import parse_qsl, urlsplit

from .stores import InMemoryQuotaStore, QuotaWindowSnapshot, QuotaWindowStore

__all__ = [
    "DEFAULT_QUOTA_TIERS",
    "QuotaCheckResult",
    "QuotaExceededEvent",
    "QuotaGuard",
    "QuotaIdentity",
    "QuotaPagination",
    "QuotaPaginationRejected",
    "QuotaRequest",
    "QuotaTierConfig",
    "create_quota_guard",
    "get_header",
]

QuotaDimension = Literal["account", "apiKey", "ip"]
QuotaExceededKind = Literal["rate_limit_exceeded", "page_size_exceeded", "max_page_exceeded"]


@dataclass(frozen=True)
class QuotaTierConfig:
    """Per-tier limits (TS ``QuotaTierConfig``)."""

    #: Maximum requests allowed inside ``window_ms`` per dimension.
    max_requests: int
    #: Sliding-window length in milliseconds.
    window_ms: int
    #: Maximum records a single query may request (``limit`` / ``pageSize``).
    max_page_size: int
    #: Maximum page depth a single query may reach (``page``, or derived from ``offset``).
    max_page: int


@dataclass
class QuotaIdentity:
    """Authenticated identity for a request (TS ``QuotaIdentity``)."""

    #: Authenticated account id, resolved by server-side auth. Never trust a raw client header.
    account_id: Optional[str] = None
    #: Authenticated API-key id, resolved by server-side auth.
    api_key_id: Optional[str] = None
    #: Plan tier name; must match a key of the configured ``tiers``.
    tier: Optional[str] = None
    #: Optional IP override when the host app already resolved the client address.
    ip: Optional[str] = None


@dataclass
class QuotaExceededEvent:
    """Structured operator event emitted on every rejection (TS ``QuotaExceededEvent``)."""

    kind: QuotaExceededKind
    #: The quota dimension that rejected the request (first exceeded, account > apiKey > ip).
    dimension: QuotaDimension
    tier: str
    #: The configured limit that was hit (requests, page size or page depth, per ``kind``).
    limit: int
    #: Seconds the client was told to wait (``Retry-After``).
    retry_after_seconds: int
    #: ISO-8601 timestamp from the guard clock, in the TS ``Date.toISOString()`` shape.
    timestamp: str
    account_id: Optional[str] = None
    api_key_id: Optional[str] = None
    ip: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        """TS-shaped dict; optional identity fields appear only when set."""
        out: dict[str, Any] = {"kind": self.kind, "dimension": self.dimension}
        if self.account_id is not None:
            out["accountId"] = self.account_id
        if self.api_key_id is not None:
            out["apiKeyId"] = self.api_key_id
        if self.ip is not None:
            out["ip"] = self.ip
        out["tier"] = self.tier
        out["limit"] = self.limit
        out["retryAfterSeconds"] = self.retry_after_seconds
        out["timestamp"] = self.timestamp
        return out


@dataclass
class QuotaPagination:
    """Sanitized pagination for the data layer (TS ``QuotaPagination``)."""

    page: int
    page_size: int
    offset: int
    clamped: bool

    def to_dict(self) -> dict[str, Any]:
        """TS-shaped dict (``pageSize`` camelCase, as on the wire / in TS results)."""
        return {
            "page": self.page,
            "pageSize": self.page_size,
            "offset": self.offset,
            "clamped": self.clamped,
        }


@dataclass
class QuotaCheckResult:
    """Outcome of ``QuotaGuard.check_request`` (TS ``QuotaCheckResult``)."""

    allowed: bool
    #: HTTP status to return: 200 when allowed, 429 when rejected.
    status: int
    #: Response headers to merge into the host response.
    headers: dict[str, str]
    #: Sanitized pagination (clamped in ``clamp`` mode, validated in ``reject`` mode).
    pagination: QuotaPagination
    tier: str
    identity: QuotaIdentity
    #: JSON body for rejections; ``None`` when allowed.
    body: Optional[dict[str, Any]] = None


@dataclass
class QuotaRequest:
    """Minimal structural request shape consumed by the guard.

    Build it from whatever your framework gives you: ``url`` (path or absolute
    URL, query string included), ``headers`` (a mapping, or any object with a
    ``get(name)`` method — Starlette/FastAPI headers work either way), and
    whichever client-address fields you have. ``raw`` carries the original
    framework request when the FastAPI/Starlette integration builds this
    object, so ``resolve_identity`` callables can reach app-specific state
    (for example ``req.raw.state.user`` populated by auth middleware).
    """

    url: str
    method: str = "GET"
    headers: Any = None
    ip: Optional[str] = None
    remote_address: Optional[str] = None
    socket_remote_address: Optional[str] = None
    connection_remote_address: Optional[str] = None
    raw: Any = None


class QuotaPaginationRejected(Exception):
    """Raised by ``QuotaGuard.evaluate_pagination`` for out-of-bounds pagination.

    Carries the full :class:`QuotaCheckResult` the guard would have returned,
    so framework integrations can translate it into their own error type.
    """

    def __init__(self, result: QuotaCheckResult) -> None:
        super().__init__(result.body["error"] if result.body else "pagination_exceeded")
        self.result = result


DEFAULT_QUOTA_TIERS: dict[str, QuotaTierConfig] = {
    "anonymous": QuotaTierConfig(max_requests=30, window_ms=60_000, max_page_size=25, max_page=5),
    "free": QuotaTierConfig(max_requests=60, window_ms=60_000, max_page_size=50, max_page=20),
    "pro": QuotaTierConfig(max_requests=300, window_ms=60_000, max_page_size=200, max_page=100),
    "enterprise": QuotaTierConfig(max_requests=3_000, window_ms=60_000, max_page_size=1_000, max_page=1_000),
}


def get_header(req: QuotaRequest, name: str) -> Optional[str]:
    """Case-insensitive header lookup over mapping or ``.get``-style headers.

    Mirrors the TS ``getHeader``: mapping headers are scanned
    case-insensitively (first match wins, first element for multi-values);
    non-mapping headers are queried through their own ``get`` method, exactly
    like Fetch ``Headers`` in the TS version.
    """
    headers = req.headers
    if headers is None:
        return None
    if isinstance(headers, Mapping):
        wanted = name.lower()
        for key, value in headers.items():
            if str(key).lower() == wanted:
                if isinstance(value, (list, tuple)):
                    return value[0] if value else None
                return value
        return None
    get = getattr(headers, "get", None)
    if callable(get):
        return get(name)
    return None


def _resolve_ip(
    req: QuotaRequest,
    identity: QuotaIdentity,
    trusted_ip_header: Optional[str],
) -> Optional[str]:
    # Mirrors the TS resolveIp, including its mixed nullish/truthy semantics:
    # identity.ip and the trusted header use truthiness; the request fields
    # fall through only on None (JS `??`).
    if identity.ip:
        return identity.ip
    if trusted_ip_header:
        from_header = get_header(req, trusted_ip_header)
        if from_header:
            first = from_header.split(",")[0].strip()
            return first or None
    for candidate in (req.ip, req.remote_address, req.socket_remote_address, req.connection_remote_address):
        if candidate is not None:
            return candidate
    return None


_INT_PREFIX = re.compile(r"^[+-]?\d+")


def _parse_positive_int(raw: Optional[str]) -> Optional[int]:
    """Emulate JS ``parseInt(raw, 10)`` as used by the TS ``parsePositiveInt``.

    Leading whitespace is skipped, an optional sign is allowed, and parsing
    stops at the first non-digit (``"10abc"`` -> 10, ``"10.9"`` -> 10). Blank
    or unparseable input yields ``None`` (the TS ``undefined``).
    """
    if raw is None or raw.strip() == "":
        return None
    match = _INT_PREFIX.match(raw.lstrip())
    if not match:
        return None
    try:
        return int(match.group(0), 10)
    except ValueError:
        return None


def _query_params(url: str) -> dict[str, str]:
    """First-value-wins query params, mirroring ``URLSearchParams.get``.

    An unparseable URL yields no params, like the TS try/catch around
    ``new URL(...)``.
    """
    try:
        query = urlsplit(url).query
    except ValueError:
        return {}
    params: dict[str, str] = {}
    for key, value in parse_qsl(query, keep_blank_values=True):
        if key not in params:
            params[key] = value
    return params


@dataclass
class _ParsedPagination:
    pagination: QuotaPagination
    size_exceeded: bool  # only ever True in reject mode
    page_exceeded: bool  # only ever True in reject mode


def _parse_pagination(
    params: Mapping[str, str],
    tier: QuotaTierConfig,
    mode: str,
    default_page_size: int,
) -> _ParsedPagination:
    clamped = False

    raw_limit = params.get("limit")
    raw_size = _parse_positive_int(raw_limit if raw_limit is not None else params.get("pageSize"))
    page_size = raw_size if (raw_size is not None and raw_size >= 1) else min(default_page_size, tier.max_page_size)
    size_exceeded = page_size > tier.max_page_size
    if size_exceeded and mode == "clamp":
        page_size = tier.max_page_size
        clamped = True

    raw_page = _parse_positive_int(params.get("page"))
    raw_offset = _parse_positive_int(params.get("offset"))
    if raw_page is not None and raw_page >= 1:
        page = raw_page
    elif raw_offset is not None and raw_offset >= 0:
        page = math.floor(raw_offset / page_size) + 1
    else:
        page = 1
    page_exceeded = page > tier.max_page
    if page_exceeded and mode == "clamp":
        page = tier.max_page
        clamped = True

    return _ParsedPagination(
        pagination=QuotaPagination(page=page, page_size=page_size, offset=(page - 1) * page_size, clamped=clamped),
        size_exceeded=size_exceeded and mode == "reject",
        page_exceeded=page_exceeded and mode == "reject",
    )


def _iso_from_ms(now_ms: float) -> str:
    """Format like JS ``new Date(now).toISOString()`` (millisecond precision, ``Z``)."""
    dt = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _coerce_default_page_size(value: Any) -> int:
    """Match ``Math.max(1, Math.floor(n ?? 20) || 20)``."""
    if value is None:
        return 20
    try:
        floored = math.floor(value)
    except (TypeError, ValueError):
        floored = 0
    if not floored:
        floored = 20
    return max(1, floored)


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


@dataclass
class _Context:
    identity: QuotaIdentity
    ip: Optional[str]
    tier_name: str
    tier: QuotaTierConfig
    dimensions: list[tuple[QuotaDimension, str]]
    primary_dimension: Optional[QuotaDimension]
    base_identity: QuotaIdentity


ResolveIdentity = Callable[[QuotaRequest], Union[Optional[QuotaIdentity], Awaitable[Optional[QuotaIdentity]]]]
OnQuotaExceeded = Callable[[QuotaExceededEvent], Union[None, Awaitable[None]]]


class QuotaGuard:
    """Sliding-window quota + pagination guard (port of ``createQuotaGuard``).

    Parameters mirror ``QuotaGuardOptions`` in the TS source:
    ``tiers``, ``default_tier``, ``trusted_ip_header``, ``resolve_identity``,
    ``on_quota_exceeded``, ``pagination_mode`` (``"reject"`` or ``"clamp"``),
    ``default_page_size``, ``store``, ``max_entries`` and ``now`` (a clock
    returning milliseconds since the epoch, mainly for tests).
    """

    def __init__(
        self,
        *,
        tiers: Optional[Mapping[str, QuotaTierConfig]] = None,
        default_tier: Optional[str] = None,
        trusted_ip_header: Optional[str] = None,
        resolve_identity: Optional[ResolveIdentity] = None,
        on_quota_exceeded: Optional[OnQuotaExceeded] = None,
        pagination_mode: str = "reject",
        default_page_size: Optional[float] = None,
        store: Optional[QuotaWindowStore] = None,
        max_entries: Optional[int] = None,
        now: Optional[Callable[[], float]] = None,
    ) -> None:
        self.tiers: dict[str, QuotaTierConfig] = dict(tiers) if tiers is not None else dict(DEFAULT_QUOTA_TIERS)
        self._default_tier = default_tier
        self._trusted_ip_header = trusted_ip_header
        self._resolve_identity = resolve_identity
        self._on_quota_exceeded = on_quota_exceeded
        self._mode = pagination_mode or "reject"
        self._default_page_size = _coerce_default_page_size(default_page_size)
        self._store: QuotaWindowStore = (
            store if store is not None else InMemoryQuotaStore(10_000 if max_entries is None else max_entries)
        )
        self._clock: Callable[[], float] = now if now is not None else (lambda: int(time.time() * 1000))

    # -- internal helpers ---------------------------------------------------

    def _tier_config(self, name: str) -> QuotaTierConfig:
        direct = self.tiers.get(name)
        if direct is not None:
            return direct
        anonymous = self.tiers.get("anonymous")
        if anonymous is not None:
            return anonymous
        for first in self.tiers.values():
            return first
        return DEFAULT_QUOTA_TIERS["anonymous"]

    async def _emit(self, event: QuotaExceededEvent) -> None:
        if self._on_quota_exceeded is None:
            return
        try:
            await _maybe_await(self._on_quota_exceeded(event))
        except Exception:
            # Operator logging must never break request handling.
            pass

    async def _resolve_context(self, req: QuotaRequest) -> _Context:
        identity: QuotaIdentity = QuotaIdentity()
        if self._resolve_identity is not None:
            resolved = await _maybe_await(self._resolve_identity(req))
            if resolved is not None:
                identity = resolved
        ip = _resolve_ip(req, identity, self._trusted_ip_header)
        tier_name = identity.tier if identity.tier is not None else (self._default_tier or "anonymous")
        tier = self._tier_config(tier_name)

        dimensions: list[tuple[QuotaDimension, str]] = []
        if identity.account_id:
            dimensions.append(("account", f"account:{identity.account_id}"))
        if identity.api_key_id:
            dimensions.append(("apiKey", f"apikey:{identity.api_key_id}"))
        if ip:
            dimensions.append(("ip", f"ip:{ip}"))

        base_identity = QuotaIdentity(
            account_id=identity.account_id or None,
            api_key_id=identity.api_key_id or None,
            tier=tier_name,
            ip=ip,
        )
        return _Context(
            identity=identity,
            ip=ip,
            tier_name=tier_name,
            tier=tier,
            dimensions=dimensions,
            primary_dimension=dimensions[0][0] if dimensions else None,
            base_identity=base_identity,
        )

    async def _reject(
        self,
        ctx: _Context,
        kind: QuotaExceededKind,
        dimension: QuotaDimension,
        limit: int,
        retry_after_seconds: int,
        pagination: QuotaPagination,
        now: float,
    ) -> QuotaCheckResult:
        await self._emit(
            QuotaExceededEvent(
                kind=kind,
                dimension=dimension,
                account_id=ctx.identity.account_id or None,
                api_key_id=ctx.identity.api_key_id or None,
                ip=ctx.ip,
                tier=ctx.tier_name,
                limit=limit,
                retry_after_seconds=retry_after_seconds,
                timestamp=_iso_from_ms(now),
            )
        )
        tier = ctx.tier
        if kind == "rate_limit_exceeded":
            message = "Too many requests; slow down and retry after the indicated interval."
        elif kind == "page_size_exceeded":
            message = f"Requested page size exceeds the {ctx.tier_name} tier maximum of {tier.max_page_size}."
        else:
            message = f"Requested page exceeds the {ctx.tier_name} tier maximum depth of {tier.max_page}."
        return QuotaCheckResult(
            allowed=False,
            status=429,
            headers={
                "Retry-After": str(retry_after_seconds),
                "X-RateLimit-Limit": str(tier.max_requests),
                "X-RateLimit-Remaining": "0",
            },
            body={"error": kind, "message": message, "retryAfterSeconds": retry_after_seconds},
            pagination=pagination,
            tier=ctx.tier_name,
            identity=ctx.base_identity,
        )

    async def _pagination_gate(
        self, ctx: _Context, url: str, now: float
    ) -> tuple[QuotaPagination, Optional[QuotaCheckResult]]:
        """Pagination bounds check (step 1 of ``check_request``).

        Returns the sanitized pagination and, in reject mode when a bound is
        exceeded, the rejection result. Consumes no request quota.
        """
        parsed = _parse_pagination(_query_params(url), ctx.tier, self._mode, self._default_page_size)
        window_retry_after = max(1, math.ceil(ctx.tier.window_ms / 1000))
        dimension = ctx.primary_dimension or "ip"
        if parsed.size_exceeded:
            page = parsed.pagination.page
            override = QuotaPagination(
                page=page,
                page_size=ctx.tier.max_page_size,
                offset=(page - 1) * ctx.tier.max_page_size,
                clamped=parsed.pagination.clamped,
            )
            result = await self._reject(
                ctx, "page_size_exceeded", dimension, ctx.tier.max_page_size, window_retry_after, override, now
            )
            return parsed.pagination, result
        if parsed.page_exceeded:
            result = await self._reject(
                ctx, "max_page_exceeded", dimension, ctx.tier.max_page, window_retry_after, parsed.pagination, now
            )
            return parsed.pagination, result
        return parsed.pagination, None

    # -- public API ----------------------------------------------------------

    async def evaluate_pagination(self, req: QuotaRequest) -> QuotaPagination:
        """Pagination-bounds evaluation only (no request quota is consumed).

        Returns the sanitized pagination, or raises
        :class:`QuotaPaginationRejected` in reject mode. Used by the FastAPI
        ``PaginationParams`` dependency for
        routes that are not behind the quota middleware.
        """
        ctx = await self._resolve_context(req)
        pagination, rejection = await self._pagination_gate(ctx, req.url, self._clock())
        if rejection is not None:
            raise QuotaPaginationRejected(rejection)
        return pagination

    async def check_request(self, req: QuotaRequest) -> QuotaCheckResult:
        """Full guard check: pagination bounds, then sliding-window quotas."""
        now = self._clock()
        ctx = await self._resolve_context(req)
        tier = ctx.tier

        # 1. Pagination bounds first: an out-of-bounds query is rejected (or
        #    was already clamped) before it may consume any request quota.
        pagination, rejection = await self._pagination_gate(ctx, req.url, now)
        if rejection is not None:
            return rejection

        # 2. Sliding-window rate check across every resolved dimension. The
        #    first exceeded dimension (account > apiKey > ip) is reported.
        snapshots: dict[str, QuotaWindowSnapshot] = {}
        for dimension, key in ctx.dimensions:
            snapshot = await _maybe_await(self._store.peek(key, now, tier.window_ms))
            snapshots[key] = snapshot
            if snapshot.count >= tier.max_requests:
                oldest = snapshot.oldest if snapshot.oldest is not None else now
                retry_after_seconds = max(1, math.ceil((oldest + tier.window_ms - now) / 1000))
                return await self._reject(
                    ctx, "rate_limit_exceeded", dimension, tier.max_requests, retry_after_seconds, pagination, now
                )

        # 3. Allowed: record one hit per dimension and report the primary
        #    dimension's remaining headroom as rate-limit metadata.
        for _dimension, key in ctx.dimensions:
            await _maybe_await(self._store.record(key, now, tier.window_ms))
        primary_key = ctx.dimensions[0][1] if ctx.dimensions else None
        primary_snapshot = snapshots.get(primary_key) if primary_key else None
        counted = (primary_snapshot.count if primary_snapshot else 0) + (1 if primary_key else 0)
        remaining = max(0, tier.max_requests - counted)
        if primary_snapshot is not None and primary_snapshot.oldest:
            reset_epoch_seconds = math.ceil((primary_snapshot.oldest + tier.window_ms) / 1000)
        else:
            reset_epoch_seconds = math.ceil((now + tier.window_ms) / 1000)
        return QuotaCheckResult(
            allowed=True,
            status=200,
            headers={
                "X-RateLimit-Limit": str(tier.max_requests),
                "X-RateLimit-Remaining": str(remaining),
                "X-RateLimit-Reset": str(reset_epoch_seconds),
            },
            pagination=pagination,
            tier=ctx.tier_name,
            identity=ctx.base_identity,
        )


def create_quota_guard(**options: Any) -> QuotaGuard:
    """Factory mirroring the TS ``createQuotaGuard``; kwargs go to :class:`QuotaGuard`."""
    return QuotaGuard(**options)
