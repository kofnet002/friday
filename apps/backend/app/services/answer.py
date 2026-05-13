from __future__ import annotations

from collections.abc import AsyncIterator
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
from app.services._retry import retry_stream
from app.settings import settings

Provider = Literal["gemini", "openai", "deepseek"]


async def stream_answer(
    provider: Provider,
    question: str,
    context: AnswerContext,
) -> AsyncIterator[str]:
    """Yield answer tokens for the given question using the selected provider.

    `context.prior_turns` carries the conversation history (oldest first,
    excluding the current `question`). For OpenAI-compatible APIs we send it
    as a native multi-turn message list — the providers track conversation
    state cleanly that way. For Gemini we embed the thread inside the user
    prompt via answer_user_prompt(...); Gemini's `contents` array supports
    multi-turn too, but embedding keeps the prompt template the single source
    of truth for how prior turns are framed (see PriorTurn handling there).
    """
    system = answer_system_prompt(context)
    if provider == "gemini":
        # Gemini path: embed the thread inside the user prompt. We don't use
        # Gemini's native multi-turn contents array here to keep prior_turns
        # framing centralized in the prompt template.
        user = answer_user_prompt(question, context.recent_transcript, context.prior_turns)
        factory = lambda: _stream_gemini(system, user)  # noqa: E731
    else:
        # OpenAI / DeepSeek path: pass prior turns as real assistant/user
        # messages on the wire. Strip <thread> from the user prompt so we
        # don't duplicate the history.
        user = answer_user_prompt(question, context.recent_transcript, prior_turns=None)
        if provider == "deepseek":
            factory = lambda: _stream_deepseek(system, user, context.prior_turns)  # noqa: E731
        else:
            factory = lambda: _stream_openai(system, user, context.prior_turns)  # noqa: E731
    async for token in retry_stream(factory, label=f"answer.{provider}"):
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
