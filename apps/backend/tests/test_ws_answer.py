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


@pytest.fixture
def captured(
    saved: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Capture stream_answer's args; stub screen storage with one current
    image (k1) and one remembered passage image (k2)."""
    from app.services.screen_memory import ScreenReference

    calls: list[dict[str, Any]] = []
    screen: dict[str, Any] = {
        "context": "Revenue chart page",
        "current": ["k1"],
        "refs": [ScreenReference(id="r1", text="passage", image_keys=["k2"], saved_at=1.0)],
        "images": {"k1": "aW1nMQ==", "k2": "aW1nMg=="},
        "labels": {"k2": "Figure 2 (line chart)"},
    }

    async def fake_stream(*a: Any, **k: Any) -> AsyncIterator[str]:
        calls.append({"args": a, **k})
        yield "ok"

    async def get_screen_context(_sid: str) -> str | None:
        return screen["context"]

    async def get_current_screen_images(_sid: str) -> list[str]:
        return list(screen["current"])

    async def get_screen_references(_sid: str) -> list[Any]:
        return list(screen["refs"])

    async def get_screen_image(_sid: str, key: str) -> str | None:
        return screen["images"].get(key)

    monkeypatch.setattr(mod, "stream_answer", fake_stream)
    monkeypatch.setattr(mod, "get_screen_context", get_screen_context)
    monkeypatch.setattr(mod, "get_current_screen_images", get_current_screen_images)
    monkeypatch.setattr(mod, "get_screen_references", get_screen_references)
    async def get_screen_image_label(_sid: str, key: str) -> str | None:
        return screen["labels"].get(key)

    monkeypatch.setattr(mod, "get_screen_image", get_screen_image)
    monkeypatch.setattr(mod, "get_screen_image_label", get_screen_image_label)
    return calls, screen


def _ask_once(**extra: Any) -> None:
    with TestClient(app).websocket_connect("/ws/answer?session_id=s1") as ws:
        _ask(ws, provider="claude", **extra)
        _drain(ws, "saved")


def test_spoken_question_sends_only_the_current_screen_image(
    captured: tuple[list[dict[str, Any]], dict[str, Any]],
) -> None:
    calls, _ = captured
    _ask_once()
    assert calls[0]["images"] == [b"img1"]
    assert calls[0]["args"][2].screen_visuals == "attached"


def test_screen_question_also_sends_remembered_images(
    captured: tuple[list[dict[str, Any]], dict[str, Any]],
) -> None:
    calls, _ = captured
    _ask_once(from_screen=True)
    assert calls[0]["images"] == [b"img1", b"img2"]
    assert calls[0]["image_labels"] == ["", "Figure 2 (line chart)"]


def test_screen_capture_off_sends_no_images(
    captured: tuple[list[dict[str, Any]], dict[str, Any]],
) -> None:
    calls, _ = captured
    _ask_once(from_screen=True, session_context={"screen_context": ""})
    assert calls[0]["images"] is None
    assert calls[0]["args"][2].screen_visuals is None


def test_no_stored_images_sends_none(
    captured: tuple[list[dict[str, Any]], dict[str, Any]],
) -> None:
    calls, screen = captured
    screen["current"] = []
    screen["refs"] = []
    _ask_once(from_screen=True)
    assert calls[0]["images"] is None
    assert calls[0]["args"][2].screen_visuals is None


def test_missing_image_bytes_are_dropped(
    captured: tuple[list[dict[str, Any]], dict[str, Any]],
) -> None:
    calls, screen = captured
    screen["images"] = {"k2": "aW1nMg=="}
    _ask_once(from_screen=True)
    assert calls[0]["images"] == [b"img2"]
    assert calls[0]["image_labels"] == ["Figure 2 (line chart)"]
