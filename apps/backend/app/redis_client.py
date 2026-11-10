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


async def recent_transcript_entries(
    session_id: str, window_seconds: float
) -> list[dict[str, Any]]:
    """Return the final-transcript entries from the last `window_seconds`.

    Each entry is the raw dict originally RPUSH'd by ws_transcribe — `text`,
    `timestamp`, `is_final`, `confidence`. Oldest first.
    """
    import time as _time

    client = await get_redis()
    if client is None:
        return []
    key = f"session:{session_id}:transcript"
    items = await cast(Awaitable[list[str]], client.lrange(key, 0, -1))
    cutoff = _time.time() - window_seconds
    out: list[dict[str, Any]] = []
    for raw in items:
        try:
            entry = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if entry.get("timestamp", 0) >= cutoff and entry.get("text"):
            out.append(entry)
    return out


async def recent_transcript_text(session_id: str, window_seconds: float) -> str:
    """Concatenate the text of finals from the last `window_seconds`.

    With mic capture the window holds both voices, so lines are prefixed
    with who spoke (`Interviewer:` / `Candidate:`); rows without a source
    (single-stream sessions) stay plain."""
    entries = await recent_transcript_entries(session_id, window_seconds)
    if not any(e.get("source") for e in entries):
        return " ".join(str(e["text"]) for e in entries).strip()
    labels = {"interviewer": "Interviewer", "candidate": "Candidate"}
    lines = [
        f"{labels[str(e['source'])]}: {e['text']}" if e.get("source") in labels else str(e["text"])
        for e in entries
    ]
    return "\n".join(lines).strip()


# ─── question-detection cross-WS state ──────────────────────────────────────

# Survive WS reconnects: persist fallback state and the most recent answer
# (used as context by the follow-up classifier). Both TTL'd to ~2h to clear
# automatically when a session ends.
QD_STATE_TTL_S = 60 * 60 * 2


async def set_screen_context(session_id: str, content: str) -> None:
    """Store extracted screen text transiently for the current interview session."""
    client = await get_redis()
    if client is None:
        return
    await cast(Awaitable[Any], client.set(
        f"session:{session_id}:screen_context", content[:20_000], ex=QD_STATE_TTL_S
    ))


async def get_screen_context(session_id: str) -> str | None:
    client = await get_redis()
    if client is None:
        return None
    raw = await cast(Awaitable[str | None], client.get(f"session:{session_id}:screen_context"))
    return raw if isinstance(raw, str) and raw else None


async def set_qd_fallback(session_id: str, model: str | None) -> None:
    """Persist (or clear) the active fallback model for this session.

    Called when the detector flips into fallback (write model) or when the
    user picks a new model via set_qd_model (write None / DEL). Survives
    WS reconnects so a transient network blip doesn't cost a wasted
    Gemini retry.
    """
    client = await get_redis()
    if client is None:
        return
    key = f"session:{session_id}:qd_fallback"
    if model is None:
        await cast(Awaitable[Any], client.delete(key))
        return
    await cast(Awaitable[Any], client.set(key, model, ex=QD_STATE_TTL_S))


async def get_qd_fallback(session_id: str) -> str | None:
    client = await get_redis()
    if client is None:
        return None
    key = f"session:{session_id}:qd_fallback"
    raw = await cast(Awaitable[str | None], client.get(key))
    return raw if isinstance(raw, str) and raw else None


async def set_last_answer(session_id: str, question: str, answer: str) -> None:
    """Cache the latest Q+A for follow-up classification. The detector
    reads this so it can show the classifier the prior *answer*, not just
    the prior *question* (the old behavior, which biased the classifier
    toward false follow-ups)."""
    client = await get_redis()
    if client is None:
        return
    key = f"session:{session_id}:qd_last_qa"
    payload = json.dumps({"q": question, "a": answer})
    await cast(Awaitable[Any], client.set(key, payload, ex=QD_STATE_TTL_S))


async def get_last_answer(session_id: str) -> dict[str, str] | None:
    """Return {"q": ..., "a": ...} or None if not set / Redis down."""
    client = await get_redis()
    if client is None:
        return None
    key = f"session:{session_id}:qd_last_qa"
    raw = await cast(Awaitable[str | None], client.get(key))
    if not isinstance(raw, str) or not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    return {"q": str(parsed.get("q") or ""), "a": str(parsed.get("a") or "")}


# ─── coding mode ────────────────────────────────────────────────────────────

CODING_PROBLEM_TTL_S = 60 * 60


async def set_current_problem(session_id: str, problem_json: str) -> None:
    client = await get_redis()
    if client is None:
        return
    key = f"session:{session_id}:current_problem"
    await cast(Awaitable[Any], client.set(key, problem_json, ex=CODING_PROBLEM_TTL_S))


async def add_seen_problem_fingerprint(session_id: str, fingerprint: str) -> bool:
    """Record that we've already surfaced this problem fingerprint this session.
    Returns True if this was a NEW fingerprint (first time), False if already seen.
    """
    client = await get_redis()
    if client is None:
        return True
    key = f"session:{session_id}:seen_problems"
    added = await cast(Awaitable[int], client.sadd(key, fingerprint))
    await cast(Awaitable[Any], client.expire(key, CODING_PROBLEM_TTL_S))
    return bool(added)


async def store_solution(session_id: str, problem_fingerprint: str, solution: str) -> None:
    client = await get_redis()
    if client is None:
        return
    key = f"session:{session_id}:solutions:{problem_fingerprint}"
    await cast(Awaitable[Any], client.set(key, solution, ex=CODING_PROBLEM_TTL_S))
