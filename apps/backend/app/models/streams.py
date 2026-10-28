"""Turn provider SDK streams into text tokens + a real usage report.

Shared by the answer and coding streamers so each provider's event shape is
parsed in one place. `on_usage(input_tokens, output_tokens)` fires once, when
the stream completes; output counts include reasoning/thinking tokens, which
is what makes high-effort runs show their true cost. A stream that ends early
(cancel, error) reports nothing and callers fall back to their estimate.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable
from typing import Any

from openai.types.chat import ChatCompletionStreamOptionsParam

UsageCallback = Callable[[int | None, int | None], None]

# Ask OpenAI-compatible APIs (OpenAI, DeepSeek) for a final usage chunk.
OPENAI_STREAM_OPTIONS: ChatCompletionStreamOptionsParam = {"include_usage": True}


def _int_or_none(value: Any) -> int | None:
    return int(value) if isinstance(value, int | float) else None


async def anthropic_text(
    stream: Any, on_usage: UsageCallback | None = None
) -> AsyncGenerator[str, None]:
    """Yield text deltas (thinking deltas are skipped). Closes the HTTP
    response on cancel/early exit so an abandoned generation stops billing."""
    input_tokens: int | None = None
    output_tokens: int | None = None
    try:
        async for event in stream:
            if event.type == "message_start":
                usage = event.message.usage
                input_tokens = sum(
                    _int_or_none(getattr(usage, field, None)) or 0
                    for field in (
                        "input_tokens",
                        "cache_read_input_tokens",
                        "cache_creation_input_tokens",
                    )
                )
            elif event.type == "message_delta":
                output_tokens = _int_or_none(event.usage.output_tokens)
            elif event.type == "content_block_delta" and event.delta.type == "text_delta":
                if event.delta.text:
                    yield event.delta.text
    finally:
        await stream.close()
    if on_usage is not None:
        on_usage(input_tokens, output_tokens)


async def openai_text(
    stream: Any, on_usage: UsageCallback | None = None
) -> AsyncGenerator[str, None]:
    """Yield content deltas. With OPENAI_STREAM_OPTIONS the last chunk carries
    usage (completion_tokens includes reasoning tokens)."""
    input_tokens: int | None = None
    output_tokens: int | None = None
    async for chunk in stream:
        usage = getattr(chunk, "usage", None)
        if usage is not None:
            input_tokens = _int_or_none(usage.prompt_tokens)
            output_tokens = _int_or_none(usage.completion_tokens)
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content
    if on_usage is not None:
        on_usage(input_tokens, output_tokens)


async def openai_responses_text(
    stream: Any, on_usage: UsageCallback | None = None
) -> AsyncGenerator[str, None]:
    """Yield output-text deltas from a Responses API stream. Web-search
    calls arrive as their own events and are skipped; usage rides on the
    final response.completed/incomplete event (output_tokens includes
    reasoning). A failed response, or one cut short before any text (a
    reasoning model that spent its whole cap thinking), raises so the
    provider chain can fall back instead of showing a blank answer."""
    input_tokens: int | None = None
    output_tokens: int | None = None
    emitted = False
    async for event in stream:
        if event.type == "response.output_text.delta":
            if event.delta:
                emitted = True
                yield event.delta
        elif event.type in ("response.completed", "response.incomplete"):
            usage = getattr(event.response, "usage", None)
            if usage is not None:
                input_tokens = _int_or_none(usage.input_tokens)
                output_tokens = _int_or_none(usage.output_tokens)
            if event.type == "response.incomplete" and not emitted:
                details = getattr(event.response, "incomplete_details", None)
                reason = getattr(details, "reason", None)
                raise RuntimeError(f"OpenAI response incomplete: {reason}")
        elif event.type == "response.failed":
            error = getattr(event.response, "error", None)
            raise RuntimeError(f"OpenAI response failed: {error}")
        elif event.type == "error":
            raise RuntimeError(f"OpenAI stream error: {getattr(event, 'message', None)}")
    if on_usage is not None:
        on_usage(input_tokens, output_tokens)


async def gemini_text(
    stream: Any, on_usage: UsageCallback | None = None
) -> AsyncGenerator[str, None]:
    """Yield chunk text. usage_metadata is cumulative, so the last one wins;
    output = visible candidates + thinking tokens."""
    usage: Any = None
    async for chunk in stream:
        usage = getattr(chunk, "usage_metadata", None) or usage
        text = getattr(chunk, "text", None)
        if text:
            yield text
    if on_usage is None:
        return
    if usage is None:
        on_usage(None, None)
        return
    candidates = _int_or_none(getattr(usage, "candidates_token_count", None))
    thoughts = _int_or_none(getattr(usage, "thoughts_token_count", None)) or 0
    on_usage(
        _int_or_none(getattr(usage, "prompt_token_count", None)),
        None if candidates is None else candidates + thoughts,
    )
