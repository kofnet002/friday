"""Provider streamers against a mocked HTTP transport: verifies the real SDKs
serialize model/effort options as the APIs expect, that thinking never leaks
into the answer, and that a rejected option set is retried without it."""

import json
from typing import Any

import httpx
import pytest
from anthropic import AsyncAnthropic, AsyncStream
from openai import AsyncOpenAI

from app.services import answer, coding_solution
from app.settings import settings


def _sse(events: list[tuple[str | None, dict[str, Any]]]) -> bytes:
    lines = []
    for name, data in events:
        if name:
            lines.append(f"event: {name}")
        lines.append(f"data: {json.dumps(data)}")
        lines.append("")
    return ("\n".join(lines) + "\n").encode()


_ANTHROPIC_EVENTS = [
    (
        "message_start",
        {
            "type": "message_start",
            "message": {
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": "claude-opus-5-5",
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1},
            },
        },
    ),
    (
        "content_block_start",
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "thinking", "thinking": "", "signature": ""},
        },
    ),
    (
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "thinking_delta", "thinking": "secret reasoning"},
        },
    ),
    ("content_block_stop", {"type": "content_block_stop", "index": 0}),
    (
        "content_block_start",
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
    ),
    (
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 1,
            "delta": {"type": "text_delta", "text": "Hello"},
        },
    ),
    (
        "content_block_delta",
        {
            "type": "content_block_delta",
            "index": 1,
            "delta": {"type": "text_delta", "text": " world"},
        },
    ),
    ("content_block_stop", {"type": "content_block_stop", "index": 1}),
    (
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": "end_turn", "stop_sequence": None},
            "usage": {"output_tokens": 5},
        },
    ),
    ("message_stop", {"type": "message_stop"}),
]


def _openai_chunk(content: str) -> dict[str, Any]:
    return {
        "id": "c1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-5.5",
        "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}],
    }


class _Recorder:
    def __init__(self, reject_when: str | None = None, body: bytes = b"") -> None:
        self.requests: list[dict[str, Any]] = []
        self.reject_when = reject_when
        self.body = body

    def handler(self, request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        self.requests.append(payload)
        if self.reject_when and self.reject_when in payload:
            return httpx.Response(
                400,
                json={
                    "type": "error",
                    "error": {"type": "invalid_request_error", "message": "unsupported"},
                },
            )
        return httpx.Response(200, content=self.body, headers={"content-type": "text/event-stream"})


def _patch_anthropic(monkeypatch: pytest.MonkeyPatch, module: Any, rec: _Recorder) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    client = AsyncAnthropic(
        api_key="test-key",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(rec.handler)),
    )
    monkeypatch.setattr(module, "AsyncAnthropic", lambda **_: client)


def _patch_openai(monkeypatch: pytest.MonkeyPatch, module: Any, rec: _Recorder) -> None:
    monkeypatch.setattr(settings, "openai_api_key", "test-key")
    client = AsyncOpenAI(
        api_key="test-key",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(rec.handler)),
    )
    monkeypatch.setattr(module, "AsyncOpenAI", lambda **_: client)


async def _collect(stream: Any) -> str:
    return "".join([tok async for tok in stream])


async def test_answer_claude_sends_effort_and_skips_thinking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder(body=_sse(_ANTHROPIC_EVENTS))
    _patch_anthropic(monkeypatch, answer, rec)

    text = await _collect(
        answer._stream_anthropic("sys", "q", (), model="claude-opus-5-5", effort="high")
    )

    assert text == "Hello world"
    sent = rec.requests[0]
    assert sent["model"] == "claude-opus-5-5"
    assert sent["output_config"] == {"effort": "high"}
    assert sent["thinking"] == {"type": "adaptive"}
    assert sent["stream"] is True
    assert "temperature" not in sent


async def test_coding_claude_retries_without_effort_when_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")
    rec = _Recorder(reject_when="output_config", body=_sse(_ANTHROPIC_EVENTS))
    _patch_anthropic(monkeypatch, coding_solution, rec)

    text = await _collect(
        coding_solution._stream_anthropic("sys", "u", model="claude-old-model", effort="max")
    )

    assert text == "Hello world"
    assert len(rec.requests) == 2
    assert "output_config" not in rec.requests[1]
    assert "thinking" not in rec.requests[1]


async def test_answer_openai_reasoning_model_sends_reasoning_effort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    body = _sse([(None, _openai_chunk("Hi")), (None, _openai_chunk("!"))]) + b"data: [DONE]\n\n"
    rec = _Recorder(body=body)
    _patch_openai(monkeypatch, answer, rec)

    text = await _collect(answer._stream_openai("sys", "q", (), model="gpt-5.5", effort="high"))

    assert text == "Hi!"
    sent = rec.requests[0]
    assert sent["model"] == "gpt-5.5"
    assert sent["reasoning_effort"] == "high"
    assert "temperature" not in sent
    assert sent["max_completion_tokens"] > answer.ANSWER_MAX_TOKENS


async def test_coding_openai_uses_selected_model(monkeypatch: pytest.MonkeyPatch) -> None:
    body = _sse([(None, _openai_chunk("x"))]) + b"data: [DONE]\n\n"
    rec = _Recorder(body=body)
    _patch_openai(monkeypatch, coding_solution, rec)

    await _collect(coding_solution._stream_openai("sys", "u", model="gpt-5.6"))

    assert rec.requests[0]["model"] == "gpt-5.6"
    assert "max_completion_tokens" in rec.requests[0]


def test_resolved_model_prefers_explicit_selection() -> None:
    assert coding_solution.resolved_model("claude", deep=True, model="claude-opus-5-5") == (
        "claude-opus-5-5"
    )
    assert coding_solution.resolved_model("gemini", deep=True) == "gemini-2.5-pro"


def test_default_solve_model_still_escalates_to_deep_tier() -> None:
    # The UI always sends its selected model; the provider's default solve
    # model must not pin hard solves / refines to the cheap tier.
    assert coding_solution.resolved_model("gemini", deep=True, model="gemini-2.5-flash") == (
        "gemini-2.5-pro"
    )
    assert coding_solution.resolved_model("gemini", deep=False, model="gemini-2.5-flash") == (
        "gemini-2.5-flash"
    )


async def test_claude_stream_is_closed_when_consumer_stops_early(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder(body=_sse(_ANTHROPIC_EVENTS))
    _patch_anthropic(monkeypatch, answer, rec)
    closed: list[bool] = []
    original_close = AsyncStream.close

    async def tracking_close(self: AsyncStream[Any]) -> None:
        closed.append(True)
        await original_close(self)

    monkeypatch.setattr(AsyncStream, "close", tracking_close)

    gen = answer._stream_anthropic("sys", "q", (), model="claude-opus-5-5", effort="high")
    assert await gen.__anext__() == "Hello"
    await gen.aclose()

    assert closed


async def test_claude_reports_real_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder(body=_sse(_ANTHROPIC_EVENTS))
    _patch_anthropic(monkeypatch, answer, rec)
    seen: list[tuple[int | None, int | None]] = []

    await _collect(
        answer._stream_anthropic(
            "sys",
            "q",
            (),
            model="claude-opus-5-5",
            on_usage=lambda i, o: seen.append((i, o)),
        )
    )

    # message_start input_tokens + message_delta output_tokens (incl. thinking)
    assert seen == [(1, 5)]


async def test_openai_requests_and_reports_usage(monkeypatch: pytest.MonkeyPatch) -> None:
    usage_chunk = {
        "id": "c1",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "gpt-5.5",
        "choices": [],
        "usage": {"prompt_tokens": 40, "completion_tokens": 900, "total_tokens": 940},
    }
    body = _sse([(None, _openai_chunk("x")), (None, usage_chunk)]) + b"data: [DONE]\n\n"
    rec = _Recorder(body=body)
    _patch_openai(monkeypatch, coding_solution, rec)
    seen: list[tuple[int | None, int | None]] = []

    await _collect(
        coding_solution._stream_openai(
            "sys", "u", model="gpt-5.5", on_usage=lambda i, o: seen.append((i, o))
        )
    )

    assert rec.requests[0]["stream_options"] == {"include_usage": True}
    assert seen == [(40, 900)]


class _FakeGeminiChunk:
    def __init__(self, text: str, usage: Any = None) -> None:
        self.text = text
        self.usage_metadata = usage


class _FakeGeminiUsage:
    prompt_token_count = 30
    candidates_token_count = 100
    thoughts_token_count = 400


async def test_gemini_reports_usage_including_thinking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "gemini_api_key", "test-key")

    async def fake_stream(**_: Any) -> Any:
        async def gen() -> Any:
            yield _FakeGeminiChunk("a")
            yield _FakeGeminiChunk("b", _FakeGeminiUsage())

        return gen()

    class _Models:
        generate_content_stream = staticmethod(fake_stream)

    class _Aio:
        models = _Models()

    class _Client:
        aio = _Aio()

    monkeypatch.setattr(answer.genai, "Client", lambda **_: _Client())
    seen: list[tuple[int | None, int | None]] = []

    text = await _collect(
        answer._stream_gemini("sys", "u", on_usage=lambda i, o: seen.append((i, o)))
    )

    assert text == "ab"
    assert seen == [(30, 500)]


async def test_stream_answer_surfaces_usage_from_selected_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rec = _Recorder(body=_sse(_ANTHROPIC_EVENTS))
    _patch_anthropic(monkeypatch, answer, rec)
    monkeypatch.setattr(answer, "_provider_chain", lambda primary: [primary])
    seen: list[tuple[int | None, int | None]] = []
    ctx = answer.AnswerContext(
        resume_text=None,
        extra_instructions=None,
        job_title=None,
        company=None,
        language="en",
        recent_transcript=None,
        prior_turns=(),
    )

    await _collect(
        answer.stream_answer(
            "claude",
            "q",
            ctx,
            model="claude-opus-5-5",
            on_usage=lambda i, o: seen.append((i, o)),
        )
    )

    assert seen == [(1, 5)]
