"""Per-session safety budgets.

- Token budget: summed from `usage_log` SQLite table (input + output tokens)
  across vision + answer + coding-solution calls.
- Audio-minute budget: incrementing counter in Redis,
  `session:{id}:audio_seconds`, INCRBYFLOAT'd as audio frames are
  forwarded to Deepgram.
"""

from __future__ import annotations

from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any, cast

from app.db import session_usage_summary
from app.redis_client import get_redis
from app.settings import settings

AUDIO_KEY_TEMPLATE = "session:{}:audio_seconds"


def audio_key(session_id: str) -> str:
    return AUDIO_KEY_TEMPLATE.format(session_id)


@dataclass(frozen=True)
class BudgetCheck:
    ok: bool
    message: str | None
    used: float
    limit: float


async def check_token_budget(session_id: str | None) -> BudgetCheck:
    if not session_id:
        return BudgetCheck(True, None, 0.0, float(settings.session_token_limit))
    rows = await session_usage_summary(session_id)
    total = 0
    for row in rows:
        total += int(row.get("input_tokens") or 0)
        total += int(row.get("output_tokens") or 0)
    limit = settings.session_token_limit
    if total >= limit:
        return BudgetCheck(
            False,
            f"Session token limit reached ({total:,}/{limit:,}).",
            float(total),
            float(limit),
        )
    return BudgetCheck(True, None, float(total), float(limit))


async def add_audio_seconds(session_id: str, seconds: float) -> float:
    client = await get_redis()
    if client is None:
        return 0.0
    raw = await cast(
        Awaitable[Any], client.incrbyfloat(audio_key(session_id), seconds)
    )
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


async def get_audio_seconds(session_id: str) -> float:
    client = await get_redis()
    if client is None:
        return 0.0
    raw = await cast(Awaitable[Any], client.get(audio_key(session_id)))
    try:
        return float(raw) if raw else 0.0
    except (TypeError, ValueError):
        return 0.0


async def audio_minutes_by_session(session_ids: list[str]) -> dict[str, float]:
    """Audio minutes used per session, in one Redis round trip."""
    client = await get_redis()
    if client is None or not session_ids:
        return {}
    raw = await cast(Awaitable[Any], client.mget([audio_key(s) for s in session_ids]))
    out: dict[str, float] = {}
    for sid, value in zip(session_ids, raw, strict=True):
        try:
            out[sid] = float(value) / 60.0 if value else 0.0
        except (TypeError, ValueError):
            out[sid] = 0.0
    return out


async def check_audio_budget(session_id: str | None) -> BudgetCheck:
    if not session_id:
        return BudgetCheck(True, None, 0.0, float(settings.session_audio_minute_limit))
    used_s = await get_audio_seconds(session_id)
    limit_s = float(settings.session_audio_minute_limit) * 60.0
    if used_s >= limit_s:
        return BudgetCheck(
            False,
            f"Session audio limit reached ({used_s / 60:.1f}/{limit_s / 60:.0f} min).",
            used_s / 60.0,
            limit_s / 60.0,
        )
    return BudgetCheck(True, None, used_s / 60.0, limit_s / 60.0)
