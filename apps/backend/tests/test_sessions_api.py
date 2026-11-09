"""Sessions overview and fork."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import sessions as sessions_api
from app.db import append_qa, log_usage
from app.main import app
from app.settings import settings


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(settings, "sqlite_path", str(tmp_path / "test.db"))
    monkeypatch.setattr(settings, "session_audio_minute_limit", 120)

    async def audio(ids: list[str]) -> dict[str, float]:
        return {sid: 30.0 for sid in ids if sid == "busy"}

    monkeypatch.setattr(sessions_api, "audio_minutes_by_session", audio)
    with TestClient(app) as c:
        yield c


def _create(client: Any, session_id: str, **fields: Any) -> None:
    res = client.post("/api/sessions", json={"session_id": session_id, **fields})
    assert res.status_code == 200


def test_overview_reports_usage_per_session(client: Any) -> None:
    _create(client, "quiet", job_title="Backend")
    _create(client, "busy", job_title="Staff Engineer", company="Acme")

    async def activity() -> None:
        await append_qa(session_id="busy", question="q", answer="a", provider="claude")
        await log_usage(
            session_id="busy",
            kind="answer",
            provider="claude",
            model="m",
            input_tokens=10,
            output_tokens=5,
        )

    asyncio.run(activity())
    body = client.get("/api/sessions/overview").json()
    assert body["audio_minutes_limit"] == 120.0
    by_id = {s["session_id"]: s for s in body["sessions"]}
    assert by_id["busy"]["qa_count"] == 1
    assert by_id["busy"]["audio_minutes_used"] == 30.0
    assert by_id["quiet"]["qa_count"] == 0
    assert by_id["quiet"]["audio_minutes_used"] == 0.0
    # Most recently active first.
    assert body["sessions"][0]["session_id"] == "busy"
    assert "resume_text" not in by_id["busy"]


def test_fork_keeps_setup_and_projects(client: Any) -> None:
    _create(client, "old", job_title="Staff Engineer", company="Acme", interview_type="mixed")
    project = client.post("/api/projects", json={"name": "Friday"}).json()["project"]
    client.put("/api/sessions/old/projects", json={"project_ids": [project["id"]]})

    new_id = client.post("/api/sessions/old/fork").json()["session_id"]
    assert new_id != "old"
    detail = client.get(f"/api/sessions/{new_id}").json()["session"]
    assert detail["job_title"] == "Staff Engineer" and detail["company"] == "Acme"
    attached = client.get(f"/api/sessions/{new_id}/projects").json()["projects"]
    assert [p["id"] for p in attached] == [project["id"]]


def test_fork_unknown_session_is_404(client: Any) -> None:
    assert client.post("/api/sessions/nope/fork").status_code == 404
