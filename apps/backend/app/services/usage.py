"""Approximate cost tracking for LLM calls.

Prices here are rough public-list figures circa 2026; adjust if your billing
report shows otherwise. Output-token counts are frequently unknown on
streaming calls — we pass ``None`` and just record input usage in that case.
"""

from __future__ import annotations

from app.db import log_usage
from app.logging import log

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


def _cost(model: str, input_tokens: int, output_tokens: int | None) -> float | None:
    price = PRICING.get(model)
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
