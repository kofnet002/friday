"""Stream retry helper for transient provider overload (503 / UNAVAILABLE).

Retries are only safe *before* the first token has reached the caller —
once we've streamed anything to the client, retrying would duplicate the
output. Mid-stream failures still propagate.
"""

from __future__ import annotations

import asyncio
import random
from collections.abc import AsyncIterator, Callable

from app.logging import log


def _is_transient(exc: BaseException) -> bool:
    """Heuristic match on the exception's str() so we stay provider-agnostic.

    Covers Gemini ServerError (503/UNAVAILABLE/"high demand"), OpenAI &
    DeepSeek APIStatusError 503/"service unavailable", and generic httpx
    overload responses.
    """
    s = str(exc).lower()
    return (
        "503" in s
        or "service unavailable" in s
        or '"unavailable"' in s
        or "overloaded" in s
        or "high demand" in s
    )


async def retry_stream(
    factory: Callable[[], AsyncIterator[str]],
    *,
    attempts: int = 3,
    base_delay: float = 0.4,
    label: str = "stream",
) -> AsyncIterator[str]:
    """Yield tokens from ``factory()``, retrying transient errors only
    before any token has been emitted to the caller."""
    for attempt in range(attempts):
        emitted = False
        try:
            async for token in factory():
                emitted = True
                yield token
            return
        except Exception as exc:  # noqa: BLE001
            if emitted or attempt == attempts - 1 or not _is_transient(exc):
                raise
            delay = base_delay * (2**attempt) + random.uniform(0, 0.2)
            log.warning(
                "stream.retry",
                label=label,
                attempt=attempt + 1,
                delay=round(delay, 2),
                error=str(exc)[:200],
            )
            await asyncio.sleep(delay)
