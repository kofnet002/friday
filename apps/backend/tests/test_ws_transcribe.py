"""Audio budget reporting on /ws/transcribe."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import ws_transcribe
from app.main import app
from app.services import limits
from app.settings import settings


class _FakeFlux:
    def __init__(self, **_: Any) -> None:
        self.connected = True

    async def connect(self) -> None:
        return None

    async def send(self, _audio: bytes) -> None:
        return None

    async def suspend(self) -> None:
        return None

    async def finish(self) -> None:
        return None

    async def force_end_turn(self) -> None:
        return None


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(settings, "sqlite_path", str(tmp_path / "test.db"))
    monkeypatch.setattr(settings, "turn_engine", "flux")
    monkeypatch.setattr(settings, "session_audio_minute_limit", 120)
    monkeypatch.setattr(ws_transcribe, "FluxSession", _FakeFlux)
    with TestClient(app) as c:
        yield c


def _set_used_seconds(monkeypatch: pytest.MonkeyPatch, seconds: float) -> None:
    async def used(_session_id: str) -> float:
        return seconds

    monkeypatch.setattr(limits, "get_audio_seconds", used)


def _start(client: Any) -> dict[str, Any]:
    with client.websocket_connect("/ws/transcribe?session_id=s1") as ws:
        assert ws.receive_json()["type"] == "ready"
        ws.send_json({"type": "start", "audio_format": "tagged"})
        msg = ws.receive_json()
        ws.send_json({"type": "stop"})
    return msg


def test_start_reports_audio_usage(client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_used_seconds(monkeypatch, 30 * 60)
    msg = _start(client)
    assert msg == {"type": "audio_usage", "used_minutes": 30.0, "limit_minutes": 120.0}


def test_start_over_budget_fails_loudly(client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    # A session already past its cap must say so on start, not after the
    # first second of audio has silently gone nowhere.
    _set_used_seconds(monkeypatch, 7210)
    msg = _start(client)
    assert msg["type"] == "limit_exceeded"
    assert msg["kind"] == "audio"
    assert msg["used_minutes"] > msg["limit_minutes"] == 120.0


def test_usage_endpoint_includes_audio_budget(client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_used_seconds(monkeypatch, 45 * 60)
    body = client.get("/api/sessions/s1/usage").json()
    assert body["audio_minutes_used"] == 45.0
    assert body["audio_minutes_limit"] == 120.0
