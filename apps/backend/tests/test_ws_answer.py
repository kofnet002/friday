from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import ws_answer as mod
from app.main import app


class _Budget:
    ok = True


@pytest.fixture
def saved(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Stub the model + storage; returns the rows append_qa received."""
    rows: list[dict[str, Any]] = []

    async def fake_stream(*_a: Any, **_k: Any) -> AsyncIterator[str]:
        for tok in ("Hello", " there"):
            await asyncio.sleep(0.01)
            yield tok

    async def append_qa(**kw: Any) -> int:
        rows.append(kw)
        return len(rows)

    async def none(*_a: Any, **_k: Any) -> None:
        return None

    async def budget(*_a: Any) -> _Budget:
        return _Budget()

    monkeypatch.setattr(mod, "stream_answer", fake_stream)
    monkeypatch.setattr(mod, "append_qa", append_qa)
    monkeypatch.setattr(mod, "check_token_budget", budget)
    monkeypatch.setattr(mod, "get_session", none)
    monkeypatch.setattr(mod, "recent_transcript_text", none)
    monkeypatch.setattr(mod, "set_last_answer", none)
    monkeypatch.setattr(mod, "record_answer_call", none)
    monkeypatch.setattr(mod, "SPECULATIVE_COMMIT_TIMEOUT_S", 0.3)
    return rows


def _ask(ws: Any, **extra: Any) -> None:
    ws.send_json(
        {
            "type": "question",
            "messages": [{"role": "user", "content": "raw turn text"}],
            "provider": "gemini",
            **extra,
        }
    )


def _drain(ws: Any, until: str) -> list[dict[str, Any]]:
    events = []
    while True:
        e = ws.receive_json()
        events.append(e)
        if e["type"] == until:
            return events


def test_request_id_echoed_on_every_event(saved: list[dict[str, Any]]) -> None:
    with TestClient(app).websocket_connect("/ws/answer?session_id=s1") as ws:
        _ask(ws, request_id="r1")
        events = _drain(ws, "saved")
    assert {e["type"] for e in events} >= {"started", "token", "done", "saved"}
    assert all(e.get("request_id") == "r1" for e in events)


def test_speculative_answer_saved_only_on_commit_with_final_wording(
    saved: list[dict[str, Any]],
) -> None:
    with TestClient(app).websocket_connect("/ws/answer?session_id=s1") as ws:
        _ask(ws, request_id="r1", candidate_id="c1", speculative=True)
        _drain(ws, "done")
        ws.send_json({"type": "commit", "candidate_id": "c1", "question": "Clean question?"})
        _drain(ws, "saved")
    assert [r["question"] for r in saved] == ["Clean question?"]


def test_uncommitted_speculative_answer_is_dropped(saved: list[dict[str, Any]]) -> None:
    with TestClient(app).websocket_connect("/ws/answer?session_id=s1") as ws:
        _ask(ws, request_id="r1", candidate_id="c1", speculative=True)
        _drain(ws, "done")
        # No commit: past the (shortened) timeout nothing is persisted.
        ws.send_json({"type": "ping"})
        assert ws.receive_json()["type"] == "pong"
        asyncio.run(asyncio.sleep(0.5))
    assert saved == []


def test_superseded_stream_events_carry_old_request_id(saved: list[dict[str, Any]]) -> None:
    with TestClient(app).websocket_connect("/ws/answer?session_id=s1") as ws:
        _ask(ws, request_id="old")
        assert ws.receive_json()["type"] == "started"
        _ask(ws, request_id="new")  # supersedes "old" mid-stream
        events = _drain(ws, "saved")
    cancelled = [e for e in events if e["type"] == "cancelled"]
    assert cancelled and all(e["request_id"] == "old" for e in cancelled)
    assert [e["request_id"] for e in events if e["type"] == "done"] == ["new"]
