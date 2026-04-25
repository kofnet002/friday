"""Approximate cost tracking for LLM calls.

Prices here are rough public-list figures circa 2026; adjust if your billing
report shows otherwise. Output-token counts are frequently unknown on
streaming calls — we pass ``None`` and just record input usage in that case.
"""

from __future__ import annotations

from app.db import log_usage
from app.logging import log

# USD per 1M tokens. Rough approximations; refine as needed.
PRICING: dict[str, tuple[float, float]] = {
    "gemini-2.5-flash": (0.075, 0.30),
    "gemini-2.5-pro": (1.25, 10.0),
    "gpt-5": (2.50, 10.0),
    "gpt-4o-mini": (0.15, 0.60),
}

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
) -> None:
    input_tokens = VISION_IMAGE_TOKENS + prompt_text_tokens
    cost = _cost(model, input_tokens, output_tokens)
    await log_usage(
        session_id=session_id,
        kind="vision_extract",
        provider="gemini",
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost,
    )
    log.info(
        "usage.vision",
        session_id=session_id,
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
