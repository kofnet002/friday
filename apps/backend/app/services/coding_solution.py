from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any, Literal

from anthropic import AsyncAnthropic
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
    REFINE_ANTHROPIC_MODEL,
    REFINE_DEEPSEEK_MODEL,
    REFINE_GEMINI_MODEL,
    REFINE_MAX_OUTPUT_TOKENS,
    REFINE_OPENAI_MODEL,
    SOLUTION_ANTHROPIC_MODEL,
    SOLUTION_DEEPSEEK_MODEL,
    SOLUTION_GEMINI_MODEL,
    SOLUTION_MAX_OUTPUT_TOKENS,
    SOLUTION_OPENAI_MODEL,
    SOLUTION_TEMPERATURE,
    coding_solution_system_prompt,
    coding_solution_user_prompt,
)
from app.services import _breaker
from app.services._fallback import stream_with_fallback
from app.services._retry import retry_stream
from app.settings import settings

Provider = Literal["gemini", "openai", "deepseek", "claude"]

# Coding shares the same fallback ordering as answer (primary → the rest).
_CODING_FALLBACK_ORDER: dict[Provider, list[Provider]] = {
    "gemini": ["gemini", "openai", "deepseek", "claude"],
    "openai": ["openai", "gemini", "deepseek", "claude"],
    "deepseek": ["deepseek", "gemini", "openai", "claude"],
    "claude": ["claude", "gemini", "openai", "deepseek"],
}


def _coding_provider_chain(primary: Provider) -> list[Provider]:
    available: set[str] = set()
    if settings.gemini_api_key:
        available.add("gemini")
    if settings.openai_api_key:
        available.add("openai")
    if settings.deepseek_api_key:
        available.add("deepseek")
    # Claude is in the INSTANT-solve chain only with an API key (fast SDK
    # path). The subscription CLI is NOT — it does extended reasoning that
    # takes minutes on hard problems, unusable for a live auto-solve (it would
    # just burn the timeout then fall back). Subscription Claude is reached via
    # the Agent instead (manual button, or auto-escalation when a fast solve
    # fails self-verify). See docs/agentic-coding.md.
    if settings.anthropic_api_key:
        available.add("claude")
    chain = [p for p in _CODING_FALLBACK_ORDER[primary] if p in available]
    # Skip providers whose quota breaker is open (e.g. Gemini free tier
    # exhausted) — otherwise every solve pays a guaranteed-429 round trip.
    chain = _breaker.filter_chain(chain)
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


def resolved_model(provider: Provider, *, deep: bool = False) -> str:
    """Return the model name the streamers will actually call. `deep=True`
    selects the reasoning / Pro tier per provider — used for refine calls
    where the failure signals we need more capability than the default
    Flash / 4o / chat tier. OpenAI deep is currently the same gpt-4o
    (reasoning models require paid-tier access we don't assume); see
    _stream_openai for the rationale."""
    if provider == "gemini":
        return REFINE_GEMINI_MODEL if deep else SOLUTION_GEMINI_MODEL
    if provider == "deepseek":
        return REFINE_DEEPSEEK_MODEL if deep else SOLUTION_DEEPSEEK_MODEL
    if provider == "claude":
        return REFINE_ANTHROPIC_MODEL if deep else SOLUTION_ANTHROPIC_MODEL
    return SOLUTION_OPENAI_MODEL


def _is_refine(prior_solution: str | None, feedback: str | None) -> bool:
    """A coding call is a refine when EITHER input is non-empty. Both
    arrive together in practice — UI sends prior_solution alongside
    feedback — but the WS handler only sets them for solve mode so it's
    safe to treat the union as the trigger."""
    return bool((prior_solution and prior_solution.strip()) or (feedback and feedback.strip()))


def should_use_deep(
    mode: CodingMode,
    problem: dict[str, Any] | None,
    prior_solution: str | None,
    feedback: str | None,
) -> bool:
    """Decide whether a coding call should use the reasoning tier (Gemini
    Pro + thinking, deepseek-reasoner).

    True when, for a solve-mode call:
      - it's a refine (prior_solution / feedback present), OR
      - the vision extractor tagged the problem `difficulty: "hard"`.

    The difficulty field was already extracted but unused for routing —
    a hard problem silently went to the cheap Flash tier and tended to
    fail. Routing hard solves straight to the reasoning tier removes the
    need for the user to manually switch providers. Non-solve modes
    (explain / debug / tests) never auto-deep — they're lighter and carry
    no difficulty signal."""
    if mode != "solve":
        return False
    if _is_refine(prior_solution, feedback):
        return True
    if isinstance(problem, dict):
        difficulty = str(problem.get("difficulty") or "").strip().lower()
        if difficulty == "hard":
            return True
    return False


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
    # Reasoning tier kicks in for refines AND for fresh solves of problems
    # the extractor tagged "hard" — see should_use_deep. Without this, a
    # hard problem's first solve goes to cheap Flash and tends to fail.
    deep = should_use_deep(mode, problem, prior_solution, feedback)

    def make_factory(p: Provider) -> AsyncIterator[str]:
        if p == "gemini":
            base = lambda: _stream_gemini(system, user, deep=deep)  # noqa: E731
        elif p == "deepseek":
            base = lambda: _stream_deepseek(system, user, deep=deep)  # noqa: E731
        elif p == "claude":
            base = lambda: _stream_anthropic(system, user, deep=deep)  # noqa: E731
        else:
            base = lambda: _stream_openai(system, user, deep=deep)  # noqa: E731
        return retry_stream(base, label=f"coding.{mode}.{p}{'.deep' if deep else ''}")

    chain = _coding_provider_chain(provider)
    async for tok in stream_with_fallback(
        providers=chain,
        factory=make_factory,
        on_fallback=on_fallback,
        label=f"coding.{mode}",
    ):
        yield tok


async def _stream_gemini(system: str, user: str, *, deep: bool = False) -> AsyncIterator[str]:
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    # Deep refine: switch to Pro and let thinking run (-1 = auto budget).
    # Pro's reasoning is what actually unlocks LeetCode-Hard diagnoses;
    # without it we just resample Flash's original bug.
    if deep:
        model = REFINE_GEMINI_MODEL
        max_tokens = REFINE_MAX_OUTPUT_TOKENS
        thinking = genai_types.ThinkingConfig(thinking_budget=-1)
    else:
        model = SOLUTION_GEMINI_MODEL
        max_tokens = SOLUTION_MAX_OUTPUT_TOKENS
        # Disable Gemini 2.5 thinking on the default solve path — its
        # thinking tokens consume the output budget and were truncating
        # the visible code mid-function. We pay for thinking only when
        # refining, where the budget bump (REFINE_MAX_OUTPUT_TOKENS)
        # accommodates both reasoning + code.
        thinking = genai_types.ThinkingConfig(thinking_budget=0)
    stream = await client.aio.models.generate_content_stream(
        model=model,
        contents=user,
        config=genai_types.GenerateContentConfig(
            system_instruction=system,
            temperature=SOLUTION_TEMPERATURE,
            max_output_tokens=max_tokens,
            thinking_config=thinking,
        ),
    )
    async for chunk in stream:
        text = getattr(chunk, "text", None)
        if text:
            yield text


async def _stream_openai(system: str, user: str, *, deep: bool = False) -> AsyncIterator[str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    # OpenAI deep refine used to switch to o1-mini / o3-mini for actual
    # reasoning. Reverted because reasoning models require a paid-tier
    # OpenAI account and the user didn't have balance. Deep on OpenAI is
    # now just gpt-4o with a bumped token budget — same model as solve.
    # This is a real ceiling for OpenAI users on LeetCode Hard; switch to
    # the Gemini provider (Pro + thinking) when refining hard problems.
    max_tokens = REFINE_MAX_OUTPUT_TOKENS if deep else SOLUTION_MAX_OUTPUT_TOKENS
    stream = await client.chat.completions.create(
        model=SOLUTION_OPENAI_MODEL,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        stream=True,
        temperature=SOLUTION_TEMPERATURE,
        max_tokens=max_tokens,
    )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content


async def _stream_deepseek(system: str, user: str, *, deep: bool = False) -> AsyncIterator[str]:
    if not settings.deepseek_api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set")
    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )
    # deepseek-reasoner returns reasoning tokens in `delta.reasoning_content`
    # (separate from `delta.content`). We don't surface them — the model's
    # final answer is in `.content` which is what the prompt's output
    # structure rules apply to. Just bumping the model + max_tokens is
    # enough to get the reasoning benefit on refine.
    model = REFINE_DEEPSEEK_MODEL if deep else SOLUTION_DEEPSEEK_MODEL
    max_tokens = REFINE_MAX_OUTPUT_TOKENS if deep else SOLUTION_MAX_OUTPUT_TOKENS
    stream = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        stream=True,
        temperature=SOLUTION_TEMPERATURE,
        max_tokens=max_tokens,
    )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content


async def _stream_anthropic(system: str, user: str, *, deep: bool = False) -> AsyncIterator[str]:
    model = REFINE_ANTHROPIC_MODEL if deep else SOLUTION_ANTHROPIC_MODEL
    # Subscription path: no API key but a Claude Code OAuth token is set. Drive
    # the local `claude` CLI (single-shot, no tools) so the user's Claude
    # selection runs on their subscription instead of silently falling back to
    # gemini/openai. See services/claude_cli.py.
    if not settings.anthropic_api_key and settings.claude_code_oauth_token:
        from app.services.claude_cli import stream_claude_cli_text

        async for text in stream_claude_cli_text(prompt=user, system=system, model=model):
            if text:
                yield text
        return

    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    # Opus 4.8 is used for both solve and refine — the deep flag only bumps
    # the output budget so a refine has room for the diagnosis + rewritten
    # code. No temperature/top_p (the Opus 4.x family rejects them) and no
    # explicit thinking config: omitting `thinking` keeps first-token latency
    # low while still getting Opus-tier code quality. `stream.text_stream`
    # yields only the response text, never internal reasoning.
    max_tokens = REFINE_MAX_OUTPUT_TOKENS if deep else SOLUTION_MAX_OUTPUT_TOKENS
    async with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    ) as stream:
        async for text in stream.text_stream:
            if text:
                yield text
