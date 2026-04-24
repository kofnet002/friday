from __future__ import annotations

import json
from collections.abc import Awaitable
from typing import Any, cast

from redis.asyncio import Redis, from_url

from app.logging import log
from app.settings import settings

_client: Redis | None = None


async def get_redis() -> Redis | None:
    """Return a shared async Redis client, or None if Redis is unreachable.

    Redis is optional in dev: if the server isn't running we log once and return
    None so callers can no-op their persistence paths without crashing.
    """
    global _client
    if _client is not None:
        return _client
    try:
        client: Redis = from_url(settings.redis_url, decode_responses=True)
        await cast(Awaitable[Any], client.ping())
    except Exception as exc:  # noqa: BLE001 - treat any connect error as "no redis"
        log.warning("redis.unavailable", url=settings.redis_url, error=str(exc))
        return None
    _client = client
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def append_transcript(session_id: str, payload: dict[str, Any]) -> None:
    """RPUSH a final transcript entry onto session:{session_id}:transcript."""
    client = await get_redis()
    if client is None:
        return
    key = f"session:{session_id}:transcript"
    await cast(Awaitable[Any], client.rpush(key, json.dumps(payload)))
