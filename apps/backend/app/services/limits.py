"""Per-session safety budgets.

- Token budget: summed from `usage_log` SQLite table (input + output tokens)
  across vision + answer + coding-solution calls, over a rolling window
  (`session_token_window_hours`).
- Audio-minute budget: incrementing counter in Redis,
  `session:{id}:audio_seconds`, INCRBYFLOAT'd as audio frames are
  forwarded to Deepgram.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any, cast

from app.db import session_tokens_since
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
    limit = settings.session_token_limit
    if not session_id:
        return BudgetCheck(True, None, 0.0, float(limit))
    hours = settings.session_token_window_hours
    since = time.time() - hours * 3600 if hours > 0 else 0.0
    total = await session_tokens_since(session_id, since)
    if total >= limit:
        span = f"in the last {hours:g} h" if hours > 0 else "so far"
        return BudgetCheck(
            False,
            f"Friday's own safety cap: this session used {total:,} of {limit:,} tokens {span}. "
            "This is not your AI provider's rate limit. Start a new session, or raise "
            "SESSION_TOKEN_LIMIT in Friday's .env.",
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
