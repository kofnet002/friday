"""/ws/answer echoes the client's request_id on every stream message so the
client can drop stragglers from a stream it already cancelled."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import ws_answer
from app.main import app


@pytest.fixture
def fake_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    async def stream_answer(*_args: Any, **_kwargs: Any) -> AsyncIterator[str]:
        yield "Hello"
        yield " there"

    monkeypatch.setattr(ws_answer, "stream_answer", stream_answer)


def _read_until_done(ws: Any) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    while True:
        msg = ws.receive_json()
        messages.append(msg)
        if msg["type"] in {"done", "error", "cancelled", "limit_exceeded"}:
            return messages


def test_every_stream_message_echoes_request_id(fake_stream: None) -> None:
    with TestClient(app).websocket_connect("/ws/answer") as ws:
        ws.send_json(
            {
                "type": "question",
                "request_id": "req-1",
                "messages": [{"role": "user", "content": "Why Friday?"}],
                "provider": "claude",
            }
        )
        messages = _read_until_done(ws)

    assert [m["type"] for m in messages] == ["started", "token", "token", "done"]
    assert {m.get("request_id") for m in messages} == {"req-1"}


def test_error_messages_echo_request_id(fake_stream: None) -> None:
    with TestClient(app).websocket_connect("/ws/answer") as ws:
        ws.send_json(
            {"type": "question", "request_id": "req-2", "messages": [], "provider": "claude"}
        )
        msg = ws.receive_json()

    assert msg == {"type": "error", "message": "empty question", "request_id": "req-2"}


def test_omitted_request_id_keeps_legacy_shape(fake_stream: None) -> None:
    with TestClient(app).websocket_connect("/ws/answer") as ws:
        ws.send_json({"type": "question", "question": "Hi?", "provider": "claude"})
        messages = _read_until_done(ws)

    assert all("request_id" not in m for m in messages)


def test_answer_sees_what_is_on_screen(monkeypatch: pytest.MonkeyPatch) -> None:
    """Interviewer shows buggy code and asks out loud: the answer model must be
    given the code vision last read off the screen."""
    seen: dict[str, Any] = {}

    async def stream_answer(_p: str, _q: str, context: Any, **_k: Any) -> AsyncIterator[str]:
        seen["screen"] = context.screen_context
        yield "ok"

    async def fake_screen(sid: str) -> str | None:
        return f"code for {sid}"

    monkeypatch.setattr(ws_answer, "stream_answer", stream_answer)
    monkeypatch.setattr(ws_answer, "get_screen_context", fake_screen)
    with TestClient(app).websocket_connect("/ws/answer?session_id=sess-9") as ws:
        ws.send_json({"type": "question", "question": "What's wrong here?", "provider": "claude"})
        _read_until_done(ws)

    assert seen["screen"] == "code for sess-9"
