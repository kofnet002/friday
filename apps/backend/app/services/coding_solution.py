from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from typing import Any

from anthropic import AsyncAnthropic
from anthropic.types import MessageParam
from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from app.models.catalog import Effort, Provider
from app.models.params import (
    anthropic_options,
    effort_max_tokens,
    gemini_thinking_config,
    open_with_param_fallback,
    openai_options,
)
from app.models.streams import (
    OPENAI_STREAM_OPTIONS,
    UsageCallback,
    anthropic_text,
    gemini_text,
    openai_text,
)
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
    CodingSolutionContext,
    coding_solution_system_prompt,
    coding_solution_user_prompt,
)
from app.services import _breaker
from app.services._fallback import stream_with_fallback
from app.services._retry import retry_stream
from app.settings import settings


def _gemini_thinking_budget(model: str) -> int:
    budget = gemini_thinking_config(model, None).thinking_budget
    return budget if budget is not None else 0

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


_SOLUTION_MODELS: dict[Provider, str] = {
    "gemini": SOLUTION_GEMINI_MODEL,
    "openai": SOLUTION_OPENAI_MODEL,
    "deepseek": SOLUTION_DEEPSEEK_MODEL,
    "claude": SOLUTION_ANTHROPIC_MODEL,
}


def resolved_model(provider: Provider, *, deep: bool = False, model: str | None = None) -> str:
    """Return the model name the streamers will actually call. An explicitly
    selected `model` always wins (the user chose it for solve AND refine).
    Otherwise `deep=True`
    selects the reasoning / Pro tier per provider — used for refine calls
    where the failure signals we need more capability than the default
    Flash / 4o / chat tier. OpenAI deep is currently the same gpt-4o
    (reasoning models require paid-tier access we don't assume); see
    _stream_openai for the rationale."""
    # The UI always sends its selection, so the provider's default solve
    # model is treated as "no pick" — hard solves still escalate to deep.
    if model and not (deep and model == _SOLUTION_MODELS.get(provider)):
        return model
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
    model: str | None = None,
    effort: Effort | None = None,
    on_fallback: Callable[[Provider, Provider, str], Awaitable[None]] | None = None,
    on_usage: UsageCallback | None = None,
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
        # The selected model + effort apply only to the selected provider;
        # fallback providers run their own solve/refine tier.
        m = resolved_model(p, deep=deep, model=model if p == provider else None)
        e = effort if p == provider else None
        if p == "gemini":
            base = lambda: _stream_gemini(  # noqa: E731
                system, user, model=m, deep=deep, effort=e, on_usage=on_usage
            )
        elif p == "deepseek":
            base = lambda: _stream_deepseek(  # noqa: E731
                system, user, model=m, deep=deep, on_usage=on_usage
            )
        elif p == "claude":
            base = lambda: _stream_anthropic(  # noqa: E731
                system, user, model=m, deep=deep, effort=e, on_usage=on_usage
            )
        else:
            base = lambda: _stream_openai(  # noqa: E731
                system, user, model=m, deep=deep, effort=e, on_usage=on_usage
            )
        return retry_stream(base, label=f"coding.{mode}.{p}{'.deep' if deep else ''}")

    chain = _coding_provider_chain(provider)
    # The chain head can differ from what the user selected (no API key for
    # it, or its quota breaker is open). Without this callback the WS layer
    # keeps crediting usage — and showing a pill — for a provider that never
    # ran (field incident: Gemini served the solve, usage row said
    # claude-opus-4-8 with a fabricated dollar cost).
    if on_fallback is not None and chain and chain[0] != provider:
        await on_fallback(provider, chain[0], "selected provider unavailable")
    async for tok in stream_with_fallback(
        providers=chain,
        factory=make_factory,
        on_fallback=on_fallback,
        label=f"coding.{mode}",
    ):
        yield tok


def _max_tokens(deep: bool) -> int:
    return REFINE_MAX_OUTPUT_TOKENS if deep else SOLUTION_MAX_OUTPUT_TOKENS


async def _stream_gemini(
    system: str,
    user: str,
    *,
    model: str,
    deep: bool = False,
    effort: Effort | None = None,
    on_usage: UsageCallback | None = None,
) -> AsyncIterator[str]:
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    # Thinking: an explicit effort wins. Otherwise deep refines let thinking
    # run (-1 = auto budget) — Pro's reasoning is what unlocks LeetCode-Hard
    # diagnoses — while the default solve disables it on Flash, where thinking
    # tokens consumed the output budget and truncated code mid-function.
    if effort is not None:
        thinking = gemini_thinking_config(model, effort)
    elif deep:
        thinking = genai_types.ThinkingConfig(thinking_budget=-1)
    else:
        thinking = gemini_thinking_config(model, None)

    def config(t: genai_types.ThinkingConfig | None) -> genai_types.GenerateContentConfig:
        return genai_types.GenerateContentConfig(
            system_instruction=system,
            temperature=SOLUTION_TEMPERATURE,
            max_output_tokens=effort_max_tokens(effort, _max_tokens(deep)),
            thinking_config=t,
        )

    async def open_stream(opts: dict[str, Any]) -> AsyncIterator[Any]:
        return await client.aio.models.generate_content_stream(
            model=model, contents=user, config=opts["config"]
        )

    stream = await open_with_param_fallback(
        open_stream,
        {"config": config(thinking)},
        # Fallback keeps the legacy thinking config (budget 0 on Flash) —
        # dropping it would re-enable dynamic thinking and truncate code.
        {"config": config(gemini_thinking_config(model, None))},
        label="coding.gemini",
    )
    async for text in gemini_text(stream, on_usage):
        yield text


async def _stream_openai(
    system: str,
    user: str,
    *,
    model: str,
    deep: bool = False,
    effort: Effort | None = None,
    on_usage: UsageCallback | None = None,
) -> AsyncIterator[str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    # Without a selected model, deep on OpenAI is gpt-4o with a bumped token
    # budget (reasoning models need a paid tier we don't assume). Pick a
    # reasoning model (gpt-5*, o3…) + effort in the panel to actually reason.
    messages: list[ChatCompletionMessageParam] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]

    async def open_stream(opts: dict[str, Any]) -> Any:
        return await client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True,
            stream_options=OPENAI_STREAM_OPTIONS,
            **opts,
        )

    stream = await open_with_param_fallback(
        open_stream,
        openai_options(
            model, effort=effort, max_tokens=_max_tokens(deep), temperature=SOLUTION_TEMPERATURE
        ),
        openai_options(model, effort=None, max_tokens=_max_tokens(deep), temperature=None),
        label="coding.openai",
    )
    async for text in openai_text(stream, on_usage):
        yield text


async def _stream_deepseek(
    system: str,
    user: str,
    *,
    model: str,
    deep: bool = False,
    on_usage: UsageCallback | None = None,
) -> AsyncIterator[str]:
    if not settings.deepseek_api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set")
    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )
    # deepseek-reasoner returns reasoning tokens in `delta.reasoning_content`
    # (separate from `delta.content`). We don't surface them — the model's
    # final answer is in `.content` which is what the prompt's output
    # structure rules apply to. DeepSeek has no effort knob; the model choice
    # (chat vs reasoner) is the reasoning switch.
    stream = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        stream=True,
        stream_options=OPENAI_STREAM_OPTIONS,
        temperature=SOLUTION_TEMPERATURE,
        max_tokens=_max_tokens(deep),
    )
    async for text in openai_text(stream, on_usage):
        yield text


async def _stream_anthropic(
    system: str,
    user: str,
    *,
    model: str,
    deep: bool = False,
    effort: Effort | None = None,
    on_usage: UsageCallback | None = None,
) -> AsyncIterator[str]:
    # Subscription path: no API key but a Claude Code OAuth token is set. Drive
    # the local `claude` CLI (single-shot, no tools) so the user's Claude
    # selection runs on their subscription instead of silently falling back to
    # gemini/openai. See services/claude_cli.py.
    if not settings.anthropic_api_key and settings.claude_code_oauth_token:
        from app.services.claude_cli import stream_claude_cli_text

        async for text in stream_claude_cli_text(
            prompt=user, system=system, model=model, effort=effort
        ):
            if text:
                yield text
        return

    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    # The deep flag only bumps the output budget so a refine has room for the
    # diagnosis + rewritten code. No temperature/top_p (recent Claude models
    # reject them). Without an explicit effort, thinking is omitted to keep
    # first-token latency low; with one, adaptive thinking runs at that effort.
    messages: list[MessageParam] = [{"role": "user", "content": user}]

    async def open_stream(opts: dict[str, Any]) -> Any:
        return await client.messages.create(
            model=model, system=system, messages=messages, stream=True, **opts
        )

    stream = await open_with_param_fallback(
        open_stream,
        anthropic_options(effort=effort, max_tokens=_max_tokens(deep)),
        anthropic_options(effort=None, max_tokens=_max_tokens(deep)),
        label="coding.claude",
    )
    # aclosing: an outer cancel must reach anthropic_text's finally, which
    # closes the HTTP response so an abandoned generation stops billing.
    async with aclosing(anthropic_text(stream, on_usage)) as texts:
        async for text in texts:
            yield text
