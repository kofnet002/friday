from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Literal

from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI

from app.prompts.coding_modes import (
    CodingMode,
    CodingModeContext,
    debug_system_prompt,
    debug_user_prompt,
    explain_system_prompt,
    explain_user_prompt,
    tests_system_prompt,
    tests_user_prompt,
)
from app.prompts.coding_solution import (
    CodingSolutionContext,
    SOLUTION_DEEPSEEK_MODEL,
    SOLUTION_GEMINI_MODEL,
    SOLUTION_MAX_OUTPUT_TOKENS,
    SOLUTION_OPENAI_MODEL,
    SOLUTION_TEMPERATURE,
    coding_solution_system_prompt,
    coding_solution_user_prompt,
)
from app.services._fallback import stream_with_fallback
from app.services._retry import retry_stream
from app.settings import settings

Provider = Literal["gemini", "openai", "deepseek"]

# Coding shares the same fallback ordering as answer (primary → other two).
_CODING_FALLBACK_ORDER: dict[Provider, list[Provider]] = {
    "gemini": ["gemini", "openai", "deepseek"],
    "openai": ["openai", "gemini", "deepseek"],
    "deepseek": ["deepseek", "gemini", "openai"],
}


def _coding_provider_chain(primary: Provider) -> list[Provider]:
    available: set[str] = set()
    if settings.gemini_api_key:
        available.add("gemini")
    if settings.openai_api_key:
        available.add("openai")
    if settings.deepseek_api_key:
        available.add("deepseek")
    chain = [p for p in _CODING_FALLBACK_ORDER[primary] if p in available]
    return chain or [primary]


def _build_prompts_for_mode(
    mode: CodingMode,
    *,
    problem: dict[str, Any] | None,
    code: str | None,
    error: str | None,
    hint: str | None,
    language: str,
    extra_instructions: str | None,
    prior_solution: str | None = None,
    feedback: str | None = None,
) -> tuple[str, str]:
    """Pick the system + user prompt pair for a coding mode. Raises on
    missing required inputs so the caller surfaces a clean error to the
    client rather than the model hallucinating from empty fields.

    `prior_solution` + `feedback` are only used by solve mode — they flip
    the prompt into refine framing (the system prompt's "REFINING A PRIOR
    SOLUTION" section). The other modes ignore them."""
    if mode == "solve":
        if not problem or not problem.get("problem_statement"):
            raise ValueError("solve mode requires problem.problem_statement")
        ctx = CodingSolutionContext(language=language, extra_instructions=extra_instructions)
        return (
            coding_solution_system_prompt(ctx),
            coding_solution_user_prompt(
                problem,
                prior_solution=prior_solution,
                feedback=feedback,
            ),
        )

    mode_ctx = CodingModeContext(language=language, extra_instructions=extra_instructions)
    if mode == "explain":
        if not (code and code.strip()):
            raise ValueError("explain mode requires code")
        return explain_system_prompt(mode_ctx), explain_user_prompt(code, hint)
    if mode == "debug":
        if not (code and code.strip()):
            raise ValueError("debug mode requires code")
        if not (error and error.strip()):
            raise ValueError("debug mode requires error")
        return debug_system_prompt(mode_ctx), debug_user_prompt(code, error, hint)
    if mode == "tests":
        if not problem or not problem.get("problem_statement"):
            raise ValueError("tests mode requires problem.problem_statement")
        return tests_system_prompt(mode_ctx), tests_user_prompt(problem)
    raise ValueError(f"unknown coding mode: {mode!r}")


def resolved_model(provider: Provider) -> str:
    if provider == "gemini":
        return SOLUTION_GEMINI_MODEL
    if provider == "deepseek":
        return SOLUTION_DEEPSEEK_MODEL
    return SOLUTION_OPENAI_MODEL


async def stream_solution(
    provider: Provider,
    problem: dict[str, Any],
    language: str,
    extra_instructions: str | None = None,
) -> AsyncIterator[str]:
    # Backwards-compat thin wrapper around stream_coding. Existing callers
    # that only do problem→solution don't need to know about modes.
    async for tok in stream_coding(
        provider=provider,
        mode="solve",
        problem=problem,
        language=language,
        extra_instructions=extra_instructions,
    ):
        yield tok


async def stream_coding(
    *,
    provider: Provider,
    mode: CodingMode,
    language: str,
    problem: dict[str, Any] | None = None,
    code: str | None = None,
    error: str | None = None,
    hint: str | None = None,
    extra_instructions: str | None = None,
    prior_solution: str | None = None,
    feedback: str | None = None,
    on_fallback: Callable[[Provider, Provider, str], Awaitable[None]] | None = None,
) -> AsyncIterator[str]:
    """Unified streamer for all four coding panel modes (solve/explain/
    debug/tests). The system+user prompts come from _build_prompts_for_mode;
    the provider dispatch and retry logic are shared.

    Falls back to the next provider in the chain when the primary fails
    before emitting any tokens; on_fallback fires per switch so the WS can
    notify the client.

    `prior_solution` + `feedback` flip solve mode into refine framing — the
    user reports a failing test or compilation error and we regenerate with
    that context so the candidate doesn't have to retype the problem.
    """
    system, user = _build_prompts_for_mode(
        mode,
        problem=problem,
        code=code,
        error=error,
        hint=hint,
        language=language,
        extra_instructions=extra_instructions,
        prior_solution=prior_solution,
        feedback=feedback,
    )

    def make_factory(p: Provider) -> AsyncIterator[str]:
        if p == "gemini":
            base = lambda: _stream_gemini(system, user)  # noqa: E731
        elif p == "deepseek":
            base = lambda: _stream_deepseek(system, user)  # noqa: E731
        else:
            base = lambda: _stream_openai(system, user)  # noqa: E731
        return retry_stream(base, label=f"coding.{mode}.{p}")

    chain = _coding_provider_chain(provider)
    async for tok in stream_with_fallback(
        providers=chain,
        factory=make_factory,
        on_fallback=on_fallback,
        label=f"coding.{mode}",
    ):
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


async def _stream_deepseek(system: str, user: str) -> AsyncIterator[str]:
    if not settings.deepseek_api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set")
    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )
    stream = await client.chat.completions.create(
        model=SOLUTION_DEEPSEEK_MODEL,
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
