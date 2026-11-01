"""Shared helpers for the parity tests.

``mock_req`` mirrors the ``mockReq`` helper in ``tests/core.test.cjs``: it
builds a request against ``https://example.test`` with plain-dict headers.
(There, ``headers.get`` lowercases the lookup key; here, header access goes
through ``quota_guard.get_header``, which scans mappings case-insensitively —
the same net behavior.)
"""

import asyncio
from typing import Any, Optional

from quota_guard import QuotaRequest


def run(coro: Any) -> Any:
    """Drive a coroutine to completion without a pytest async plugin."""
    return asyncio.run(coro)


def mock_req(
    path: str,
    headers: Optional[dict] = None,
    method: str = "GET",
    remote_address: Optional[str] = None,
) -> QuotaRequest:
    url = path if path.startswith("http") else f"https://example.test{path}"
    return QuotaRequest(url=url, method=method, headers=dict(headers or {}), remote_address=remote_address)
