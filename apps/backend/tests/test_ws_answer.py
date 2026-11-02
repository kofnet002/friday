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
