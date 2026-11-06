"""Per-provider request options for an arbitrary model + reasoning effort.

Each provider spells "think harder" differently:

- Claude: ``output_config.effort`` + adaptive thinking.
- OpenAI reasoning models (gpt-5*, o-series): ``reasoning_effort``.
- Gemini 2.x: ``thinking_budget`` tokens; Gemini 3+: ``thinking_level``.
- DeepSeek: no knob (pick ``deepseek-reasoner`` to reason).

Thinking/reasoning tokens count against the output cap on every provider, so
an effort level also raises the cap — otherwise the visible answer would be
truncated by the model's own reasoning.

Because any model ID is accepted, some will reject options they don't support
(effort on an older Claude, temperature on a reasoning model, …).
``open_with_param_fallback`` retries such a 400 once with the minimal option
set rather than failing the request.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from google.genai import types as genai_types

from app.logging import log
from app.models.catalog import Effort

T = TypeVar("T")

# Output-token cap per effort level (reasoning + visible answer).
_EFFORT_MAX_TOKENS: dict[Effort, int] = {
    "low": 8_000,
    "medium": 16_000,
    "high": 32_000,
    "xhigh": 64_000,
    "max": 64_000,
}

# OpenAI tops out at xhigh.
_OPENAI_EFFORT: dict[Effort, str] = {
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
    "max": "xhigh",
}

# Gemini 2.x thinking budgets (tokens). -1 = dynamic (model decides).
_GEMINI_BUDGET: dict[Effort, int] = {
    "low": 1_024,
    "medium": 8_192,
    "high": 24_576,
    "xhigh": -1,
    "max": -1,
}

_GEMINI_LEVEL: dict[Effort, genai_types.ThinkingLevel] = {
    "low": genai_types.ThinkingLevel.LOW,
    "medium": genai_types.ThinkingLevel.MEDIUM,
    "high": genai_types.ThinkingLevel.HIGH,
    "xhigh": genai_types.ThinkingLevel.HIGH,
    "max": genai_types.ThinkingLevel.HIGH,
}

_OPENAI_REASONING_PREFIXES = ("gpt-5", "o1", "o3", "o4")
# o-series reject any non-default temperature even without an effort.
# These reject any temperature but the default (live API: gpt-5.5 / gpt-5.6 →
# 400 "Only the default (1) value is supported"), so omit it entirely.
_OPENAI_NO_TEMPERATURE_PREFIXES = ("o1", "o3", "o4", "gpt-5")


def effort_max_tokens(effort: Effort | None, max_tokens: int) -> int:
    if effort is None:
        return max_tokens
    return max(max_tokens, _EFFORT_MAX_TOKENS[effort])


def _anthropic_thinking_off(model: str) -> dict[str, str] | None:
    """How to say "don't think" to a Claude model, or None when it can't.
    Verified against the live API (Nov 2026): Sonnet 5.x rejects "disabled"
    and wants "between_tools"; Opus 5.x and Fable always think (only effort
    tunes it). Anything else takes the classic "disabled"."""
    lowered = model.lower()
    if lowered.startswith("claude-sonnet-5"):
        return {"type": "between_tools"}
    if lowered.startswith(("claude-opus-5", "claude-fable")):
        return None
    return {"type": "disabled"}


def anthropic_options(
    *, effort: Effort | None, max_tokens: int, model: str
) -> dict[str, Any]:
    if effort is None:
        # Claude 5.x thinks by default. Unasked-for thinking eats the output
        # budget (stop_reason=max_tokens, answer cut off or empty) and adds
        # first-token latency, so the default turns it off where it can.
        thinking = _anthropic_thinking_off(model)
        return {"max_tokens": max_tokens, **({"thinking": thinking} if thinking else {})}
    return {
        "max_tokens": effort_max_tokens(effort, max_tokens),
        "output_config": {"effort": effort},
        "thinking": {"type": "adaptive"},
    }


def is_openai_reasoning_model(model: str) -> bool:
    return model.lower().startswith(_OPENAI_REASONING_PREFIXES)


def openai_options(
    model: str,
    *,
    effort: Effort | None,
    max_tokens: int,
    temperature: float | None,
) -> dict[str, Any]:
    if not is_openai_reasoning_model(model):
        opts: dict[str, Any] = {"max_tokens": max_tokens}
        if temperature is not None:
            opts["temperature"] = temperature
        return opts
    if effort is None:
        opts = {"max_completion_tokens": max_tokens}
        if temperature is not None and not model.lower().startswith(
            _OPENAI_NO_TEMPERATURE_PREFIXES
        ):
            opts["temperature"] = temperature
        return opts
    # Reasoning models reject custom temperature while reasoning.
    return {
        "max_completion_tokens": effort_max_tokens(effort, max_tokens),
        "reasoning_effort": _OPENAI_EFFORT[effort],
    }


def openai_responses_options(
    model: str,
    *,
    effort: Effort | None,
    max_tokens: int,
    temperature: float | None,
) -> dict[str, Any]:
    """openai_options translated to the Responses API's parameter names."""
    opts = openai_options(model, effort=effort, max_tokens=max_tokens, temperature=temperature)
    out: dict[str, Any] = {
        "max_output_tokens": opts.get("max_completion_tokens", opts.get("max_tokens")),
    }
    if "temperature" in opts:
        out["temperature"] = opts["temperature"]
    if "reasoning_effort" in opts:
        out["reasoning"] = {"effort": opts["reasoning_effort"]}
    return out


def _is_gemini_2(model: str) -> bool:
    return model.lower().startswith(("gemini-1", "gemini-2"))


def gemini_thinking_config(model: str, effort: Effort | None) -> genai_types.ThinkingConfig:
    if effort is None:
        # Legacy default: Gemini Pro requires thinking; Flash may disable it.
        return genai_types.ThinkingConfig(thinking_budget=-1 if "pro" in model else 0)
    if _is_gemini_2(model):
        return genai_types.ThinkingConfig(thinking_budget=_GEMINI_BUDGET[effort])
    return genai_types.ThinkingConfig(thinking_level=_GEMINI_LEVEL[effort])


def is_bad_request(exc: BaseException) -> bool:
    """True for an HTTP 400 from any provider SDK (openai/anthropic expose
    `status_code`; google-genai exposes `code`)."""
    return getattr(exc, "status_code", None) == 400 or getattr(exc, "code", None) == 400


async def open_with_param_fallback(
    open_fn: Callable[[dict[str, Any]], Awaitable[T]],
    options: dict[str, Any],
    fallback: dict[str, Any],
    *,
    label: str,
) -> T:
    """Open a provider stream with `options`; if the model rejects them with a
    400, retry once with `fallback` (the minimal option set)."""
    try:
        return await open_fn(options)
    except Exception as exc:
        if options == fallback or not is_bad_request(exc):
            raise
        log.warning(
            "model.params_rejected",
            label=label,
            dropped=sorted(set(options) - set(fallback)),
            error=str(exc)[:200],
        )
        return await open_fn(fallback)
