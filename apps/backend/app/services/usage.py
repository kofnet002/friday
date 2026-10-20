"""Approximate cost tracking for LLM calls.

Prices here are rough public-list figures circa 2026; adjust if your billing
report shows otherwise. Output-token counts are frequently unknown on
streaming calls — we pass ``None`` and just record input usage in that case.
"""

from __future__ import annotations

import json

from app.db import log_usage
from app.logging import log
from app.settings import settings

# USD per 1M tokens. Rough approximations; refine as needed.
# PRICING: dict[str, tuple[float, float]] = {
#     "gemini-2.5-flash": (0.075, 0.30),
#     "gemini-2.5-pro": (1.25, 10.0),
#     "gpt-4o": (2.50, 10.0),
#     "gpt-4o-mini": (0.15, 0.60),
# }

PRICING: dict[str, tuple[float, float]] = {
    "gemini-2.5-flash": (0.075, 0.30),
    "gemini-2.5-flash-lite": (0.0375, 0.15),
    "gemini-2.5-pro": (1.25, 5.00),
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "deepseek-chat": (0.14, 0.28),
    "deepseek-reasoner": (0.55, 2.19),
    # Claude (Anthropic). Opus 4.8 list price; add sonnet/haiku rows here if
    # you point ANTHROPIC_MODEL at a cheaper tier.
    "claude-opus-4-8": (5.00, 25.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
}

# Rough fixed overhead (tokens) for the answer system prompt + session
# context (resume / job framing). The streamed answer call's true input is
# system + context + question + thread; only the latter parts are cheap to
# measure exactly, so this constant covers the rest. Keeps the cost pill
# from wildly under-counting answer spend.
ANSWER_PROMPT_OVERHEAD_TOKENS = 2500

# Vision token approximation: Gemini charges per-image by tile count. A single
# full-display screenshot at <=1920px maps to roughly 1000-1500 tokens.
VISION_IMAGE_TOKENS = 1500


# Uncatalogued Claude IDs (e.g. a newer generation) are priced at their tier's
# list price above. Approximate — set MODEL_PRICING for exact figures.
_FAMILY_PRICING: tuple[tuple[str, str], ...] = (
    ("claude-opus-", "claude-opus-4-8"),
    ("claude-sonnet-", "claude-sonnet-4-6"),
    ("claude-haiku-", "claude-haiku-4-5"),
)


def _env_pricing() -> dict[str, tuple[float, float]]:
    """MODEL_PRICING env override: JSON {"model": [in_per_1m, out_per_1m]}.
    Malformed entries are skipped (logged) rather than breaking accounting."""
    raw = settings.model_pricing.strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("usage.model_pricing_invalid", error="not valid JSON")
        return {}
    if not isinstance(data, dict):
        return {}
    out: dict[str, tuple[float, float]] = {}
    for model, rates in data.items():
        if (
            isinstance(rates, list)
            and len(rates) == 2
            and all(isinstance(r, int | float) for r in rates)
        ):
            out[str(model)] = (float(rates[0]), float(rates[1]))
    return out


# Marks a model label that ran on the Claude subscription (not metered per
# token) so it's never priced, even though its ID matches a Claude tier.
SUBSCRIPTION_SUFFIX = " (subscription)"


def _price_for(model: str) -> tuple[float, float] | None:
    if model.endswith(SUBSCRIPTION_SUFFIX):
        return None
    override = _env_pricing().get(model)
    if override:
        return override
    price = PRICING.get(model)
    if price:
        return price
    for prefix, reference in _FAMILY_PRICING:
        if model.startswith(prefix):
            return PRICING[reference]
    return None


def _cost(model: str, input_tokens: int, output_tokens: int | None) -> float | None:
    price = _price_for(model)
    if not price:
        return None
    in_rate, out_rate = price
    total = input_tokens / 1_000_000 * in_rate
    if output_tokens is not None:
        total += output_tokens / 1_000_000 * out_rate
    return round(total, 6)


async def record_vision_call(
    *,
    session_id: str,
    model: str,
    output_tokens: int | None = None,
    prompt_text_tokens: int = 0,
    provider: str = "gemini",
) -> None:
    input_tokens = VISION_IMAGE_TOKENS + prompt_text_tokens
    cost = _cost(model, input_tokens, output_tokens)
    await log_usage(
        session_id=session_id,
        kind="vision_extract",
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )
    log.info(
        "usage.vision",
        session_id=session_id,
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )


async def record_solution_call(
    *,
    session_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int | None = None,
) -> None:
    cost = _cost(model, input_tokens, output_tokens)
    await log_usage(
        session_id=session_id,
        kind="coding_solution",
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )
    log.info(
        "usage.solution",
        session_id=session_id,
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )


async def record_qd_call(
    *,
    session_id: str,
    provider: str,
    model: str,
    kind: str,
    input_tokens: int,
    output_tokens: int | None = None,
) -> None:
    """Log a question-detection or follow-up classifier call.

    `kind` is "question_detection" or "follow_up" — distinct so usage
    summaries can break them apart. Both are typically tiny (few hundred
    tokens) but the detector now fires more often than the answer stream,
    so unrecorded they'd silently grow into a real cost wedge.
    """
    cost = _cost(model, input_tokens, output_tokens)
    await log_usage(
        session_id=session_id,
        kind=kind,
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )
    log.info(
        "usage.qd",
        session_id=session_id,
        provider=provider,
        model=model,
        kind=kind,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )


async def record_answer_call(
    *,
    session_id: str,
    provider: str,
    model: str,
    input_tokens: int,
    output_tokens: int | None = None,
) -> None:
    """Log a copilot answer-stream call. Previously /ws/answer recorded
    nothing — the cost pill saw vision + coding spend but every streamed
    answer was free as far as it knew, which understated a live session's
    cost by the largest single component."""
    cost = _cost(model, input_tokens, output_tokens)
    await log_usage(
        session_id=session_id,
        kind="answer",
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )
    log.info(
        "usage.answer",
        session_id=session_id,
        provider=provider,
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )
