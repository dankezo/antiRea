"""FastAPI/Starlette integration for the quota guard.

Counterpart of the TS ``createExpressQuotaMiddleware``:

- :class:`QuotaMiddleware` - Starlette ``BaseHTTPMiddleware``. Runs the guard
  for every request; on success it stores the sanitized pagination on
  ``request.state.quota_pagination`` (and the full result on
  ``request.state.quota_result``), merges the rate-limit headers into the
  response and calls the next handler; on rejection it responds ``429`` with
  ``Retry-After`` and the guard's JSON error body.
- :func:`get_quota_pagination` - FastAPI dependency returning the pagination
  the middleware computed for this request.
- :class:`PaginationParams` - FastAPI dependency for routes that are NOT
  behind the middleware: it enforces pagination bounds only (no request quota
  is consumed). When the middleware did run, it simply reuses its result.

Divergences from the Express original (see README): the Express middleware
forwards guard errors via ``next(err)``; Starlette middleware has no such
channel, so an exception from the guard propagates and surfaces as a 500 via
the app's error handling. And ``PaginationParams`` raises FastAPI's
``HTTPException``, whose body is wrapped as ``{"detail": ...}`` instead of
the raw guard body the middleware returns.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse, Response

from .core import QuotaGuard, QuotaPagination, QuotaPaginationRejected, QuotaRequest, create_quota_guard


def request_to_quota_request(request: Request) -> QuotaRequest:
    """Build the guard's structural request from a Starlette request.

    The client address comes from the ASGI ``client`` scope value; identity
    resolution (account/API key/tier) remains the host app's job via the
    guard's ``resolve_identity`` callable, which receives this object and can
    reach the original request as ``req.raw``.
    """
    client = request.client
    return QuotaRequest(
        url=str(request.url),
        method=request.method,
        headers=request.headers,
        remote_address=client.host if client else None,
        raw=request,
    )


class QuotaMiddleware(BaseHTTPMiddleware):
    """Starlette middleware equivalent of ``createExpressQuotaMiddleware``.

    Pass either an existing ``guard`` or any ``QuotaGuard`` keyword arguments::

        app.add_middleware(QuotaMiddleware, tiers={...}, resolve_identity=...)
    """

    def __init__(self, app: Any, guard: Optional[QuotaGuard] = None, **guard_options: Any) -> None:
        super().__init__(app)
        self.guard = guard if guard is not None else create_quota_guard(**guard_options)

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        result = await self.guard.check_request(request_to_quota_request(request))
        if not result.allowed:
            return JSONResponse(result.body, status_code=result.status, headers=result.headers)
        request.state.quota_pagination = result.pagination
        request.state.quota_result = result
        response = await call_next(request)
        for name, value in result.headers.items():
            response.headers[name] = value
        return response


def get_quota_pagination(request: Request) -> QuotaPagination:
    """FastAPI dependency: the pagination sanitized by :class:`QuotaMiddleware`.

    Usage: ``pagination: QuotaPagination = Depends(get_quota_pagination)``.
    Raises ``RuntimeError`` when the middleware did not run for this request -
    use :class:`PaginationParams` instead for routes outside the middleware.
    """
    pagination = getattr(request.state, "quota_pagination", None)
    if pagination is None:
        raise RuntimeError(
            "quota pagination missing: install QuotaMiddleware, or use PaginationParams for this route"
        )
    return pagination


class PaginationParams:
    """FastAPI dependency enforcing pagination bounds for a single route.

    Usage::

        pagination_params = PaginationParams(guard)

        @app.get("/api/items")
        async def items(pagination: QuotaPagination = Depends(pagination_params)):
            ...

    If :class:`QuotaMiddleware` already processed the request, its sanitized
    pagination is returned unchanged. Otherwise the guard's pagination gate
    runs for this route only (reject mode raises ``HTTPException`` 429 with
    the guard body under ``detail``; clamp mode returns clamped values). No
    request quota is consumed in the standalone path.
    """

    def __init__(self, guard: QuotaGuard) -> None:
        self.guard = guard

    async def __call__(self, request: Request) -> QuotaPagination:
        existing = getattr(request.state, "quota_pagination", None)
        if existing is not None:
            return existing
        try:
            return await self.guard.evaluate_pagination(request_to_quota_request(request))
        except QuotaPaginationRejected as exc:
            result = exc.result
            raise HTTPException(status_code=result.status, detail=result.body, headers=result.headers) from exc
