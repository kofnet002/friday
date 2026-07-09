"""Shared test fixtures.

Autouse fixtures here keep tests deterministic and side-effect-free:

- `_isolate_qd_redis`: replaces the question-detection Redis helpers
  (`set_qd_fallback`, `get_qd_fallback`, `set_last_answer`, `get_last_answer`)
  with an in-memory dict for every test. Without this, a test that
  triggers fallback would write real keys to whatever Redis the
  developer has running locally; subsequent tests would then see the
  stale state. Individual tests can still override these mocks per-test
  if they want to assert specific call sequences.
"""

from __future__ import annotations

from typing import Any

import pytest

from app import redis_client as rc
from app.services import question_detection as qd_mod


@pytest.fixture(autouse=True)
def _isolate_qd_redis(monkeypatch: pytest.MonkeyPatch) -> None:
    """Per-test in-memory backing for QD Redis helpers."""
    fallback_state: dict[str, str | None] = {}
    last_answer_state: dict[str, dict[str, str]] = {}

    async def set_qd_fallback(session_id: str, model: str | None) -> None:
        if model is None:
            fallback_state.pop(session_id, None)
        else:
            fallback_state[session_id] = model

    async def get_qd_fallback(session_id: str) -> str | None:
        return fallback_state.get(session_id)

    async def set_last_answer(session_id: str, q: str, a: str) -> None:
        last_answer_state[session_id] = {"q": q, "a": a}

    async def get_last_answer(session_id: str) -> dict[str, str] | None:
        return last_answer_state.get(session_id)

    # Patch the redis_client module (where the helpers live) AND the
    # question_detection module (where they were re-imported as locals).
    # Both bindings must point at the mock or partial isolation gives a
    # mix of real + mocked behavior.
    for target_mod in (rc, qd_mod):
        if hasattr(target_mod, "set_qd_fallback"):
            monkeypatch.setattr(target_mod, "set_qd_fallback", set_qd_fallback)
        if hasattr(target_mod, "get_qd_fallback"):
            monkeypatch.setattr(target_mod, "get_qd_fallback", get_qd_fallback)
        if hasattr(target_mod, "set_last_answer"):
            monkeypatch.setattr(target_mod, "set_last_answer", set_last_answer)
        if hasattr(target_mod, "get_last_answer"):
            monkeypatch.setattr(target_mod, "get_last_answer", get_last_answer)

    # Belt-and-suspenders: if anything else in QD asks for a Redis client,
    # hand back None so the underlying append_transcript / etc. no-op
    # rather than hitting a real Redis.
    async def no_redis() -> Any:
        return None

    monkeypatch.setattr(rc, "get_redis", no_redis)
