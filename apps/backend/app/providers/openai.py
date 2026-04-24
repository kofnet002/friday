from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from app.settings import settings


async def stream_openai(message: str) -> AsyncIterator[str]:
    """Stream tokens from OpenAI for the given user message."""
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")

    client = AsyncOpenAI(api_key=settings.openai_api_key)
    stream = await client.chat.completions.create(
        model=settings.openai_model,
        messages=[{"role": "user", "content": message}],
        stream=True,
    )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content
