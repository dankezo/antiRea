"""Python port of antiRea's quota-guard (``src/tier2-active/quota-guard.ts``).

Framework-free core: :class:`QuotaGuard`, the tier/identity/pagination types,
and the window stores. FastAPI/Starlette integration lives in
``quota_guard.fastapi_integration`` so the core never depends on a web
framework (the same reason the TS core models its Express middleware against
a structural response type).
"""

from .core import (
    DEFAULT_QUOTA_TIERS,
    QuotaCheckResult,
    QuotaExceededEvent,
    QuotaGuard,
    QuotaIdentity,
    QuotaPagination,
    QuotaPaginationRejected,
    QuotaRequest,
    QuotaTierConfig,
    create_quota_guard,
    get_header,
)
from .stores import (
    InMemoryQuotaStore,
    QuotaWindowSnapshot,
    QuotaWindowStore,
    RedisQuotaStore,
    create_in_memory_quota_store,
)

__all__ = [
    "DEFAULT_QUOTA_TIERS",
    "InMemoryQuotaStore",
    "QuotaCheckResult",
    "QuotaExceededEvent",
    "QuotaGuard",
    "QuotaIdentity",
    "QuotaPagination",
    "QuotaPaginationRejected",
    "QuotaRequest",
    "QuotaTierConfig",
    "QuotaWindowSnapshot",
    "QuotaWindowStore",
    "RedisQuotaStore",
    "create_in_memory_quota_store",
    "create_quota_guard",
    "get_header",
]
