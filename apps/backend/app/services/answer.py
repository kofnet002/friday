from __future__ import annotations

import dataclasses
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Literal

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
from app.services.claude_agent_auth import claude_available
from app.services.claude_api import (
    claude_transport,
    claude_usage_model,
    image_media_type,
    stream_claude_api,
)
from app.settings import settings

Provider = Literal["gemini", "openai", "deepseek", "claude"]

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
    # Claude is the odd one out: it needs no API key when a Claude Code
    # subscription token is configured (the CLI transport bills the
    # subscription instead). See _stream_anthropic.
    if claude_available():
        available.add("claude")
    chain = [p for p in _FALLBACK_ORDER[primary] if p in available]
    # Skip providers whose quota breaker is open (e.g. Gemini free tier
    # exhausted) — no point paying the guaranteed-429 tax on every call.
    chain = _breaker.filter_chain(chain)
    # If only the primary is available, the chain has one entry — no
    # fallback. If even the primary is missing, return [primary] so the
    # caller hits the existing "API_KEY not set" RuntimeError cleanly.
    return chain or [primary]


def claude_answer_model(model: str | None = None) -> str:
    """Model label to bill answer usage against (``claude-code:<model>`` on
    the subscription transport, which deliberately has no PRICING row).
    `model` overrides the configured answer model (screen-mode pick)."""
    return claude_usage_model(model or settings.anthropic_answer_model)


async def stream_answer(
    provider: Provider,
    question: str,
    context: AnswerContext,
    *,
    on_fallback: Callable[[Provider, Provider, str], Awaitable[None]] | None = None,
    claude_model: str | None = None,
    images: list[bytes] | None = None,
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

    `images` (screenshots of on-screen charts/diagrams) reach only the
    `claude` provider. Every other provider in the chain — including a
    fallback after Claude fails — is told the visuals are unavailable so it
    flags answers that depend on them.
    """
    claude_system = answer_system_prompt(context)
    other_system = (
        answer_system_prompt(dataclasses.replace(context, screen_visuals="unavailable"))
        if images
        else claude_system
    )

    # Build a per-provider factory that handles in-provider transient
    # retries (`retry_stream`). The outer fallback helper switches providers
    # only after these retries are exhausted or hit a hard error.
    def make_factory(p: Provider) -> AsyncIterator[str]:
        system = claude_system if p == "claude" else other_system
        if p == "gemini":
            # Gemini path: embed the thread inside the user prompt. We don't
            # use Gemini's native multi-turn contents array here to keep
            # prior_turns framing centralized in the prompt template.
            user = answer_user_prompt(
                question, context.recent_transcript, context.prior_turns, context.code_refs
            )
            base = lambda: _stream_gemini(system, user)  # noqa: E731
        else:
            # OpenAI / DeepSeek / Claude path: pass prior turns as real
            # assistant/user messages on the wire. Strip <thread> from the
            # user prompt so we don't duplicate the history.
            user = answer_user_prompt(
                question, context.recent_transcript, prior_turns=None, code_refs=context.code_refs
            )
            if p == "deepseek":
                base = lambda: _stream_deepseek(system, user, context.prior_turns)  # noqa: E731
            elif p == "claude":
                # The subscription CLI transport takes ONE prompt string (no
                # messages array), so it needs the thread embedded the way the
                # Gemini path does. Build both and let _stream_anthropic pick
                # the one matching the transport it resolves to.
                threaded = answer_user_prompt(
                    question, context.recent_transcript, context.prior_turns, context.code_refs
                )
                base = lambda: _stream_anthropic(  # noqa: E731
                    system,
                    user,
                    threaded,
                    context.prior_turns,
                    model=claude_model,
                    images=images or None,
                )
            else:
                base = lambda: _stream_openai(system, user, context.prior_turns)  # noqa: E731
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


async def _stream_gemini(system: str, user: str) -> AsyncIterator[str]:
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    stream = await client.aio.models.generate_content_stream(
        model=settings.gemini_model,
        contents=user,
        config=genai_types.GenerateContentConfig(
            system_instruction=system,
            temperature=0.4,
            max_output_tokens=1500,
            top_p=0.9,
            thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
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
) -> AsyncIterator[str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    stream = await client.chat.completions.create(
        model=settings.openai_model,
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


async def _stream_anthropic(
    system: str,
    user: str,
    threaded_user: str,
    prior: tuple[PriorTurn, ...],
    *,
    model: str | None = None,
    images: list[bytes] | None = None,
) -> AsyncIterator[str]:
    """Stream an answer from Claude on the transport claude_transport() picks.

    - **api** → the Anthropic SDK, with `prior` sent as a real multi-turn
      `messages` array (best fidelity). Anthropic requires the first turn to
      be `user` and merges consecutive same-role turns, so the prior thread
      (starts user, ends assistant) slots in ahead of the final question.
    - **cli** → the local `claude` CLI in print mode, billed against the
      subscription. It accepts a single prompt, so we send `threaded_user`
      (history embedded in the prompt) instead.

    `images` go before the text on the API; the CLI can only read images
    from files in a one-shot call, so with images it yields the whole answer
    at once instead of streaming.
    """
    model = model or settings.anthropic_answer_model
    transport = claude_transport()
    if transport == "cli" and images:
        from app.services.claude_cli import run_claude_cli_with_images

        text = await run_claude_cli_with_images(
            images=images, prompt=threaded_user, system=system, model=model
        )
        if text:
            yield text
        return
    if transport == "cli":
        from app.services.claude_cli import stream_claude_cli_text

        async for text in stream_claude_cli_text(
            prompt=threaded_user,
            system=system,
            model=model,
        ):
            if text:
                yield text
        return
    if transport is None:
        raise RuntimeError("no Claude credential for CLAUDE_TRANSPORT")

    # Low effort by default: thinking can't be turned off on Opus 5.5, and
    # the answer system prompt already pins the output format tightly.
    async for text in stream_claude_api(
        system=system,
        user=user,
        model=model,
        max_tokens=1500,
        effort=settings.anthropic_effort,
        prior=((turn.role, turn.content) for turn in prior),
        image=[(b, image_media_type(b)) for b in images] if images else None,
        cache_system=True,
    ):
        yield text


async def _stream_deepseek(
    system: str,
    user: str,
    prior: tuple[PriorTurn, ...],
) -> AsyncIterator[str]:
    if not settings.deepseek_api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set")
    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )
    stream = await client.chat.completions.create(
        model=settings.deepseek_model,
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
