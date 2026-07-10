from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Literal

from anthropic import AsyncAnthropic
from anthropic.types import MessageParam
from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam

from app.prompts.answer_generation import (
    AnswerContext,
    PriorTurn,
    answer_system_prompt,
    answer_user_prompt,
)
from app.services import _breaker
from app.services._fallback import stream_with_fallback
from app.services._retry import retry_stream
from app.settings import settings

Provider = Literal["gemini", "openai", "deepseek", "claude"]


def _gemini_thinking_config(model: str) -> genai_types.ThinkingConfig:
    """Gemini Pro requires thinking; Flash permits it to be disabled."""
    return genai_types.ThinkingConfig(thinking_budget=-1 if "pro" in model else 0)

# Default fallback chain. If the user picks gemini and it 503s through all
# in-provider retries, we try openai next, then deepseek. Different primaries
# get their own chain — the primary is always tried first.
_FALLBACK_ORDER: dict[Provider, list[Provider]] = {
    "gemini": ["gemini", "openai", "deepseek", "claude"],
    "openai": ["openai", "gemini", "deepseek", "claude"],
    "deepseek": ["deepseek", "gemini", "openai", "claude"],
    "claude": ["claude", "gemini", "openai", "deepseek"],
}


def _provider_chain(primary: Provider) -> list[Provider]:
    """Return the ordered list of providers to try for a given primary,
    skipping any that don't have an API key configured (so we don't waste
    a retry round on a guaranteed RuntimeError)."""
    available: set[str] = set()
    if settings.gemini_api_key:
        available.add("gemini")
    if settings.openai_api_key:
        available.add("openai")
    if settings.deepseek_api_key:
        available.add("deepseek")
    if settings.anthropic_api_key:
        available.add("claude")
    chain = [p for p in _FALLBACK_ORDER[primary] if p in available]
    # Skip providers whose quota breaker is open (e.g. Gemini free tier
    # exhausted) — no point paying the guaranteed-429 tax on every call.
    chain = _breaker.filter_chain(chain)
    # If only the primary is available, the chain has one entry — no
    # fallback. If even the primary is missing, return [primary] so the
    # caller hits the existing "API_KEY not set" RuntimeError cleanly.
    return chain or [primary]


async def stream_answer(
    provider: Provider,
    question: str,
    context: AnswerContext,
    *,
    model: str | None = None,
    on_fallback: Callable[[Provider, Provider, str], Awaitable[None]] | None = None,
) -> AsyncIterator[str]:
    """Yield answer tokens for the given question using the selected provider.

    `context.prior_turns` carries the conversation history (oldest first,
    excluding the current `question`). For OpenAI-compatible APIs we send it
    as a native multi-turn message list — the providers track conversation
    state cleanly that way. For Gemini we embed the thread inside the user
    prompt via answer_user_prompt(...); Gemini's `contents` array supports
    multi-turn too, but embedding keeps the prompt template the single source
    of truth for how prior turns are framed (see PriorTurn handling there).

    When `on_fallback` is provided and the primary provider fails before
    emitting any tokens, the next provider in the chain is tried. The
    callback fires once per switch so the WS layer can notify the client.
    """
    system = answer_system_prompt(context)
    # Build a per-provider factory that handles in-provider transient
    # retries (`retry_stream`). The outer fallback helper switches providers
    # only after these retries are exhausted or hit a hard error.
    def make_factory(p: Provider) -> AsyncIterator[str]:
        selected = model if p == provider else None
        if p == "gemini":
            # Gemini path: embed the thread inside the user prompt. We don't
            # use Gemini's native multi-turn contents array here to keep
            # prior_turns framing centralized in the prompt template.
            user = answer_user_prompt(
                question, context.recent_transcript, context.prior_turns
            )
            base = lambda: _stream_gemini(system, user, model=selected)  # noqa: E731
        else:
            # OpenAI / DeepSeek / Claude path: pass prior turns as real
            # assistant/user messages on the wire. Strip <thread> from the
            # user prompt so we don't duplicate the history.
            user = answer_user_prompt(question, context.recent_transcript, prior_turns=None)
            if p == "deepseek":
                base = lambda: _stream_deepseek(system, user, context.prior_turns, model=selected)  # noqa: E731
            elif p == "claude":
                base = lambda: _stream_anthropic(system, user, context.prior_turns, model=selected)  # noqa: E731
            else:
                # A user-selected model applies only to the selected
                # provider. Fallback providers must use their own defaults.
                base = lambda: _stream_openai(system, user, context.prior_turns, model=selected)  # noqa: E731
        return retry_stream(base, label=f"answer.{p}")

    chain = _provider_chain(provider)
    # Same head-substitution honesty as stream_coding: if the selected
    # provider isn't in the resolved chain (no API key / breaker open), tell
    # the WS layer up front so usage is credited to the provider that
    # actually runs, not the one the user selected.
    if on_fallback is not None and chain and chain[0] != provider:
        await on_fallback(provider, chain[0], "selected provider unavailable")
    async for token in stream_with_fallback(
        providers=chain,
        factory=make_factory,
        on_fallback=on_fallback,
        label="answer",
    ):
        yield token


def _openai_messages(
    system: str,
    user: str,
    prior: tuple[PriorTurn, ...],
) -> list[ChatCompletionMessageParam]:
    """Build the OpenAI/DeepSeek `messages` array. Prior assistant turns are
    included as actual `assistant` messages so the API treats this as a real
    multi-turn conversation (cleaner than re-embedding history in the user
    prompt). The current user turn (`user`) wraps the question with the
    template's framing, which still includes recent_conversation context but
    omits prior_turns — those go in the message list instead."""
    msgs: list[ChatCompletionMessageParam] = [{"role": "system", "content": system}]
    for turn in prior:
        if turn.role == "assistant":
            msgs.append({"role": "assistant", "content": turn.content})
        else:
            msgs.append({"role": "user", "content": turn.content})
    msgs.append({"role": "user", "content": user})
    return msgs


async def _stream_gemini(system: str, user: str, *, model: str | None = None) -> AsyncIterator[str]:
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    stream = await client.aio.models.generate_content_stream(
        model=model or settings.gemini_model,
        contents=user,
        config=genai_types.GenerateContentConfig(
            system_instruction=system,
            temperature=0.4,
            max_output_tokens=1500,
            top_p=0.9,
            thinking_config=_gemini_thinking_config(model or settings.gemini_model),
        ),
    )
    async for chunk in stream:
        text = getattr(chunk, "text", None)
        if text:
            yield text


async def _stream_openai(
    system: str,
    user: str,
    prior: tuple[PriorTurn, ...],
    *,
    model: str | None = None,
) -> AsyncIterator[str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    effective_model = model or settings.openai_model
    if effective_model.startswith("gpt-5"):
        stream = await client.chat.completions.create(
            model=effective_model,
            messages=_openai_messages(system, user, prior),
            stream=True,
            temperature=0.4,
            max_completion_tokens=1500,
        )
    else:
        stream = await client.chat.completions.create(
            model=effective_model,
            messages=_openai_messages(system, user, prior),
            stream=True,
            temperature=0.4,
            max_tokens=1500,
        )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content


def _anthropic_messages(user: str, prior: tuple[PriorTurn, ...]) -> list[MessageParam]:
    """Build the Anthropic `messages` array. The system prompt is passed
    separately (top-level `system=`), so this only carries the conversation:
    prior assistant/user turns followed by the current user turn. Anthropic
    requires the first turn to be `user` and merges consecutive same-role
    turns, so the prior thread (which starts user, ends assistant) slots in
    cleanly ahead of the final user question."""
    msgs: list[MessageParam] = [
        {"role": turn.role, "content": turn.content} for turn in prior
    ]
    msgs.append({"role": "user", "content": user})
    return msgs


async def _stream_anthropic(
    system: str,
    user: str,
    prior: tuple[PriorTurn, ...],
    *,
    model: str | None = None,
) -> AsyncIterator[str]:
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")
    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    # No temperature/top_p — the Opus 4.x family rejects them. Thinking is
    # omitted for the lowest first-token latency; the answer system prompt
    # already pins the output format tightly.
    async with client.messages.stream(
        model=model or settings.anthropic_model,
        max_tokens=1500,
        system=system,
        messages=_anthropic_messages(user, prior),
    ) as stream:
        async for text in stream.text_stream:
            if text:
                yield text


async def _stream_deepseek(
    system: str,
    user: str,
    prior: tuple[PriorTurn, ...],
    *,
    model: str | None = None,
) -> AsyncIterator[str]:
    if not settings.deepseek_api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set")
    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )
    stream = await client.chat.completions.create(
        model=model or settings.deepseek_model,
        messages=_openai_messages(system, user, prior),
        stream=True,
        temperature=0.4,
        max_tokens=1500,
    )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content
