"""Model lab routes: pinned model, no cache, no silent provider fallback."""

from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator
from typing import Any

import pytest

from app.api import lab
from app.api.lab import LabAnswerRequest, LabExtractRequest
from app.models.coding import ExtractedProblem

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def problem() -> ExtractedProblem:
    return ExtractedProblem(
        title="Escalation",
        is_coding_problem=False,
        is_screen_question=True,
        question="Write the customer reply.",
        confidence=0.9,
    )


@pytest.fixture
def extractors(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str | None, int]]:
    calls: list[tuple[str, str | None, int]] = []

    def fake(name: str) -> Any:
        async def run(images: list[bytes], plan: Any, *args: Any, model: str | None = None) -> Any:
            calls.append((name, model, len(images)))
            return problem(), None, model or ""

        return run

    monkeypatch.setattr(lab, "_extract_openai", fake("openai"))
    monkeypatch.setattr(lab, "_extract_claude", fake("claude"))
    monkeypatch.setattr(lab, "_extract_gemini", fake("gemini"))
    return calls


@pytest.mark.parametrize(
    ("model", "expected"),
    [("gpt-5.6", "openai"), ("claude-sonnet-5-5", "claude"), ("gemini-2.5-pro", "gemini")],
)
async def test_extract_runs_the_pinned_model(
    extractors: list[tuple[str, str | None, int]], model: str, expected: str
) -> None:
    result = await lab.lab_extract(
        LabExtractRequest(images_base64=[b64(PNG), b64(PNG)], model=model)
    )
    assert extractors == [(expected, model, 2)]
    assert result["problem"]["question"] == "Write the customer reply."


@pytest.mark.parametrize("model", ["deepseek-chat", "not a model!"])
async def test_extract_rejects_models_that_cannot_read_images(
    extractors: list[tuple[str, str | None, int]], model: str
) -> None:
    with pytest.raises(lab.HTTPException) as exc:
        await lab.lab_extract(LabExtractRequest(images_base64=[b64(PNG)], model=model))
    assert exc.value.status_code == 400
    assert extractors == []


async def test_extract_reports_provider_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("no credits remaining")

    monkeypatch.setattr(lab, "_extract_openai", boom)
    with pytest.raises(lab.HTTPException) as exc:
        await lab.lab_extract(LabExtractRequest(images_base64=[b64(PNG)], model="gpt-5.6"))
    assert exc.value.status_code == 502
    assert "no credits remaining" in str(exc.value.detail)


async def collect(events: AsyncIterator[dict[str, str]]) -> list[tuple[str, Any]]:
    return [(e["event"], json.loads(e["data"])) async for e in events]


async def test_answer_streams_tokens_then_timing_and_cost(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}

    async def fake_stream(provider: str, question: str, _ctx: Any, **kw: Any) -> Any:
        seen.update(provider=provider, question=question, **kw)
        yield "Hello "
        yield "there"
        kw["on_usage"](1000, 200)

    monkeypatch.setattr(lab, "stream_answer", fake_stream)
    selection = lab._resolve("claude-opus-5-5")
    events = await collect(lab._answer_events(selection, "Why 500?", "high"))

    assert [e for e, _ in events] == ["token", "token", "done"]
    assert "".join(d["text"] for e, d in events if e == "token") == "Hello there"
    done = events[-1][1]
    assert done["first_token_ms"] is not None
    assert done["usage"]["input"] == 1000 and done["usage"]["output"] == 200
    assert done["usage"]["cost"] > 0
    assert seen["provider"] == "claude" and seen["model"] == "claude-opus-5-5"
    assert seen["effort"] == "high"
    # The lab must never be answered by a different provider than the one picked.
    assert seen.get("on_fallback") is None


async def test_answer_failure_is_an_error_event(monkeypatch: pytest.MonkeyPatch) -> None:
    async def failing(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError("You have no credits remaining")
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(lab, "stream_answer", failing)
    events = await collect(lab._answer_events(lab._resolve("gpt-5.6"), "q", None))
    assert events == [("error", {"message": "You have no credits remaining"})]


async def test_answer_rejects_unknown_model() -> None:
    with pytest.raises(lab.HTTPException) as exc:
        await lab.lab_answer(LabAnswerRequest(question="q", model="bad model"))
    assert exc.value.status_code == 400
