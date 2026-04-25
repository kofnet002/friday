from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Literal

from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI

from app.prompts.answer_generation import AnswerContext, answer_system_prompt, answer_user_prompt
from app.settings import settings

Provider = Literal["gemini", "openai"]


async def stream_answer(
    provider: Provider,
    question: str,
    context: AnswerContext,
) -> AsyncIterator[str]:
    """Yield answer tokens for the given question using the selected provider."""
    system = answer_system_prompt(context)
    user = answer_user_prompt(question, context.recent_transcript)
    if provider == "gemini":
        async for token in _stream_gemini(system, user):
            yield token
    else:
        async for token in _stream_openai(system, user):
            yield token


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


async def _stream_openai(system: str, user: str) -> AsyncIterator[str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    client = AsyncOpenAI(api_key=settings.openai_api_key)
    stream = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
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
