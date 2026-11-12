"""Claude transport selection + the metered Anthropic API path.

Claude can run on two transports:

- **api** — the Anthropic SDK against ANTHROPIC_API_KEY (metered, per-token).
  Fastest, real token counts, native multi-turn + image input.
- **cli** — the local `claude` CLI on the Claude Code SUBSCRIPTION
  (CLAUDE_CODE_OAUTH_TOKEN). Zero marginal cost, but process-startup latency
  and single-prompt only. See services/claude_cli.py.

`claude_transport()` is the ONE place that picks between them for the
non-agent calls (answers, solves, vision, question detection, function
calling), driven by CLAUDE_TRANSPORT. The agentic tool loop is separate — it
is always the CLI and pins its own credential (services/claude_agent_auth.py).

The SDK helpers below also own the per-model request shape, so call sites
don't each re-learn which models take `effort`, think by default, or accept
server-side refusal fallbacks.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterable
from functools import lru_cache
from typing import Any, Literal

from anthropic import AsyncAnthropic
from anthropic.types.beta import BetaMessageParam

from app.logging import log
from app.settings import settings

ClaudeTransport = Literal["api", "cli"]
Effort = Literal["low", "medium", "high", "xhigh", "max"]

# Models where thinking is ON unless explicitly disabled (and on Opus 5.5 it
# can't be disabled at all). Thinking tokens count against max_tokens, so call
# sites sized for a visible answer (e.g. 128-token QD JSON) get headroom added
# here instead of silently truncating mid-thought.
_THINKING_HEADROOM = 16_000
# Pre-5 families: omitting `thinking` means no thinking, so no headroom.
_NO_DEFAULT_THINKING_PREFIXES = ("claude-opus-4", "claude-sonnet-4", "claude-haiku-4", "claude-3")
# Default-thinking models that accept `thinking: {type: "disabled"}` (at
# effort high or below). Opus 5.5 / Sonnet 5.5 / Fable reject it with a 400,
# so a `thinking=False` request on those keeps thinking at the given effort.
_THINKING_DISABLE_OK = frozenset({"claude-haiku-5-5", "claude-opus-5", "claude-sonnet-5"})
# `output_config.effort` errors on these (Sonnet 4.5 / Haiku 4.5 and older).
_NO_EFFORT_PREFIXES = ("claude-sonnet-4-5", "claude-haiku-4", "claude-3")
# Models that accept `fallbacks: "default"` (server-side re-run of a
# safety-classifier refusal on Anthropic's recommended substitute model).
_FALLBACK_MODELS = frozenset(
    {
        "claude-fable-5-2",
        "claude-opus-5-5",
        "claude-opus-5",
        "claude-fable-5-1",
        "claude-sonnet-5-5",
    }
)

# Claude models the user can pick for screen mode (solving + screen reading).
# Order is the order shown in the picker. _request_kwargs already shapes each
# request per model (thinking / effort), so any of these is safe to send.
CLAUDE_MODEL_CHOICES: tuple[str, ...] = (
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-2",
)


def normalize_claude_model(value: object) -> str | None:
    """A client-supplied model id, or None unless it is an allowed choice."""
    return value if isinstance(value, str) and value in CLAUDE_MODEL_CHOICES else None
_FALLBACK_BETA = "server-side-fallback-2026-07-01"


def claude_transport() -> ClaudeTransport | None:
    """Return the transport non-agent Claude calls should use, or None when
    no credential matches CLAUDE_TRANSPORT.

    - ``auto`` (default): API key when present, else the subscription CLI.
    - ``api``: API key only — never touch the subscription.
    - ``subscription``: CLI only — never spend metered API credit.
    """
    has_key = bool(settings.anthropic_api_key)
    has_sub = bool(settings.claude_code_oauth_token)
    mode = settings.claude_transport
    if mode == "api":
        return "api" if has_key else None
    if mode == "subscription":
        return "cli" if has_sub else None
    if has_key:
        return "api"
    if has_sub:
        return "cli"
    return None


def claude_uses_api() -> bool:
    return claude_transport() == "api"


def claude_usage_model(model: str) -> str:
    """Model label to bill usage against. Subscription runs go out as
    ``claude-code:<model>``, which deliberately has no PRICING row — a Claude
    Code session costs nothing per token, so the cost pill must not charge it
    at metered rates."""
    return model if claude_uses_api() else f"claude-code:{model}"


@lru_cache(maxsize=1)
def _client(api_key: str) -> AsyncAnthropic:
    # Keyed on the key so a settings reload in tests gets a fresh client.
    return AsyncAnthropic(api_key=api_key)


def anthropic_client() -> AsyncAnthropic:
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    return _client(settings.anthropic_api_key)


def _request_kwargs(
    *,
    system: str,
    messages: list[BetaMessageParam],
    model: str,
    max_tokens: int,
    effort: Effort | None,
    thinking: bool = True,
    cache_system: bool = False,
) -> dict[str, Any]:
    """Per-model request shape. Never sends temperature/top_p/top_k — every
    current Claude model rejects them.

    `thinking=False` turns thinking off where the model allows it — for tiny
    latency-critical classifiers (question detection) where reasoning only
    adds time.

    `cache_system=True` marks the system prompt as a prompt-cache breakpoint.
    Use it where the same (large) system prompt repeats across calls — the
    live answer prompt carries resume + project context that is identical
    for every question in a session. Below the model's minimum cacheable
    length the marker is simply ignored."""
    kwargs: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": messages}
    if system and cache_system:
        kwargs["system"] = [
            {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}
        ]
    elif system:
        kwargs["system"] = system
    if not thinking and model in _THINKING_DISABLE_OK:
        kwargs["thinking"] = {"type": "disabled"}
    elif not model.startswith(_NO_DEFAULT_THINKING_PREFIXES):
        kwargs["max_tokens"] = max_tokens + _THINKING_HEADROOM
    if effort and not model.startswith(_NO_EFFORT_PREFIXES):
        kwargs["output_config"] = {"effort": effort}
    betas: list[str] = []
    if model in _FALLBACK_MODELS:
        betas.append(_FALLBACK_BETA)
        kwargs["fallbacks"] = "default"
    kwargs["betas"] = betas
    return kwargs


def image_media_type(image_bytes: bytes) -> str:
    """Sniff the image MIME type from magic bytes. Defaults to JPEG (what the
    desktop capture emits)."""
    if image_bytes[:8].startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if image_bytes[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"


def _content(
    text: str, image: tuple[bytes, str] | list[tuple[bytes, str]] | None
) -> str | list[dict[str, Any]]:
    if image is None:
        return text
    import base64

    images = image if isinstance(image, list) else [image]
    blocks = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": base64.standard_b64encode(data).decode("ascii"),
            },
        }
        for data, media_type in images
    ]
    blocks.append({"type": "text", "text": text})
    return blocks


async def stream_claude_api(
    *,
    system: str,
    user: str,
    model: str,
    max_tokens: int,
    effort: Effort | None,
    prior: Iterable[tuple[str, str]] = (),
    image: tuple[bytes, str] | list[tuple[bytes, str]] | None = None,
    cache_system: bool = False,
    thinking: bool = True,
) -> AsyncIterator[str]:
    """Stream response text from the Anthropic API.

    `prior` is (role, content) pairs sent as real multi-turn messages ahead of
    `user`. `image` is (bytes, media_type), placed before the text. Thinking
    blocks are never yielded — `text_stream` carries only the answer.

    A refusal that survives the server-side fallback raises if nothing was
    emitted yet, so the caller's provider chain can try the next provider.
    """
    messages: list[BetaMessageParam] = [
        {"role": role, "content": content}  # type: ignore[typeddict-item]
        for role, content in prior
    ]
    messages.append({"role": "user", "content": _content(user, image)})  # type: ignore[typeddict-item]
    emitted = False
    async with anthropic_client().beta.messages.stream(
        **_request_kwargs(
            system=system,
            messages=messages,
            model=model,
            max_tokens=max_tokens,
            effort=effort,
            cache_system=cache_system,
            thinking=thinking,
        )
    ) as stream:
        async for text in stream.text_stream:
            if text:
                emitted = True
                yield text
        final = await stream.get_final_message()
    if final.stop_reason == "refusal":
        category = getattr(final.stop_details, "category", None) if final.stop_details else None
        log.warning("claude_api.refusal", model=model, category=category, emitted=emitted)
        if not emitted:
            raise RuntimeError(f"Claude refused the request (category={category})")
    elif final.stop_reason == "max_tokens":
        log.warning("claude_api.max_tokens", model=model, max_tokens=max_tokens)


async def complete_claude_api(
    *,
    system: str,
    user: str,
    model: str,
    max_tokens: int,
    effort: Effort | None,
    image: tuple[bytes, str] | list[tuple[bytes, str]] | None = None,
    thinking: bool = True,
) -> tuple[str, int, int]:
    """One-shot completion → (text, input_tokens, output_tokens).

    Streams under the hood (then takes the final message) so the thinking
    headroom on large max_tokens never trips the SDK's non-streaming timeout
    guard."""
    messages: list[BetaMessageParam] = [
        {"role": "user", "content": _content(user, image)}  # type: ignore[typeddict-item]
    ]
    async with anthropic_client().beta.messages.stream(
        **_request_kwargs(
            system=system,
            messages=messages,
            model=model,
            max_tokens=max_tokens,
            effort=effort,
            thinking=thinking,
        )
    ) as stream:
        final = await stream.get_final_message()
    if final.stop_reason == "refusal":
        category = getattr(final.stop_details, "category", None) if final.stop_details else None
        raise RuntimeError(f"Claude refused the request (category={category})")
    text = "".join(block.text for block in final.content if block.type == "text")
    usage = final.usage
    return text, int(usage.input_tokens or 0), int(usage.output_tokens or 0)


async def claude_vision(
    *,
    image_bytes: bytes | list[bytes],
    system: str,
    prompt: str,
    model: str,
    max_tokens: int,
    session_id: str | None = None,
) -> tuple[str, int | None, str]:
    """Screenshot → raw reply text on whichever transport is configured.

    Returns (text, output_tokens, model_label). The CLI path reports no token
    usage and labels the model ``claude-code:<model>`` (unpriced)."""
    transport = claude_transport()
    if transport == "cli":
        if isinstance(image_bytes, list) and len(image_bytes) > 1:
            raise RuntimeError("Claude CLI vision transport cannot merge multiple scan frames")
        from app.services.claude_cli import run_claude_cli_vision

        raw = await run_claude_cli_vision(
            image_bytes=image_bytes[0] if isinstance(image_bytes, list) else image_bytes,
            system=system,
            prompt=prompt,
            model=model,
            session_id=session_id,
        )
        return raw, None, f"claude-code:{model}"
    if transport is None:
        raise RuntimeError("no Claude credential for CLAUDE_TRANSPORT")
    text, _, output_tokens = await complete_claude_api(
        system=system,
        user=prompt,
        model=model,
        max_tokens=max_tokens,
        effort=settings.anthropic_effort,
        image=(
            [(data, image_media_type(data)) for data in image_bytes]
            if isinstance(image_bytes, list)
            else (image_bytes, image_media_type(image_bytes))
        ),
    )
    return text, output_tokens, model
