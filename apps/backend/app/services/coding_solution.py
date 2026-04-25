from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any, Literal

from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI

from app.prompts.coding_solution import (
    CodingSolutionContext,
    SOLUTION_GEMINI_MODEL,
    SOLUTION_MAX_OUTPUT_TOKENS,
    SOLUTION_OPENAI_MODEL,
    SOLUTION_TEMPERATURE,
    coding_solution_system_prompt,
    coding_solution_user_prompt,
)
from app.settings import settings

Provider = Literal["gemini", "openai"]


def resolved_model(provider: Provider) -> str:
    return SOLUTION_GEMINI_MODEL if provider == "gemini" else SOLUTION_OPENAI_MODEL


async def stream_solution(
    provider: Provider,
    problem: dict[str, Any],
    language: str,
    extra_instructions: str | None = None,
) -> AsyncIterator[str]:
    ctx = CodingSolutionContext(language=language, extra_instructions=extra_instructions)
    system = coding_solution_system_prompt(ctx)
    user = coding_solution_user_prompt(problem)
    if provider == "gemini":
        async for tok in _stream_gemini(system, user):
            yield tok
    else:
        async for tok in _stream_openai(system, user):
            yield tok


async def _stream_gemini(system: str, user: str) -> AsyncIterator[str]:
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    stream = await client.aio.models.generate_content_stream(
        model=SOLUTION_GEMINI_MODEL,
        contents=user,
        config=genai_types.GenerateContentConfig(
            system_instruction=system,
            temperature=SOLUTION_TEMPERATURE,
            max_output_tokens=SOLUTION_MAX_OUTPUT_TOKENS,
            # Disable Gemini 2.5 thinking — its thinking tokens consume the
            # output budget and were truncating the visible code mid-function.
            thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
        ),
    )
    async for chunk in stream:
        text = getattr(chunk, "text", None)
        if text:
            yield text


async def _stream_openai(system: str, user: str) -> AsyncIterator[str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    stream = await client.chat.completions.create(
        model=SOLUTION_OPENAI_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        stream=True,
        temperature=SOLUTION_TEMPERATURE,
        max_tokens=SOLUTION_MAX_OUTPUT_TOKENS,
    )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content
