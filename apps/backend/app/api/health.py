"""Health probes.

`/health` answers "is the process up?" cheaply.
`/health/deep` actually exercises Redis + SQLite and reports presence of
each provider key without making outbound calls (so it's free to invoke).
"""

from __future__ import annotations

from collections.abc import Awaitable
from typing import Any, cast

import aiosqlite
from fastapi import APIRouter, Response

from app.db import _db_path
from app.redis_client import get_redis
from app.settings import settings

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/deep")
async def health_deep(response: Response) -> dict[str, Any]:
    checks: dict[str, str] = {}

    # Redis ping.
    try:
        redis = await get_redis()
        if redis is None:
            checks["redis"] = "down"
        else:
            await cast(Awaitable[Any], redis.ping())
            checks["redis"] = "ok"
    except Exception:  # noqa: BLE001
        checks["redis"] = "down"

    # SQLite is local + tiny; just open + SELECT 1.
    try:
        async with aiosqlite.connect(_db_path()) as db:
            await db.execute("SELECT 1")
        checks["sqlite"] = "ok"
    except Exception:  # noqa: BLE001
        checks["sqlite"] = "down"

    checks["deepgram_key"] = "present" if settings.deepgram_api_key else "missing"
    checks["gemini_key"] = "present" if settings.gemini_api_key else "missing"
    checks["openai_key"] = "present" if settings.openai_api_key else "missing"
    checks["deepseek_key"] = "present" if settings.deepseek_api_key else "missing"

    degraded = (
        checks["redis"] == "down"
        or checks["sqlite"] == "down"
        or "missing" in (checks["deepgram_key"], checks["gemini_key"], checks["openai_key"])
    )
    if degraded:
        response.status_code = 503

    return {
        "status": "degraded" if degraded else "ok",
        "checks": checks,
    }
