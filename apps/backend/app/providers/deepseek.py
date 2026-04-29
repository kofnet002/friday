from collections.abc import AsyncIterator

from openai import AsyncOpenAI

from app.settings import settings


async def stream_deepseek(message: str) -> AsyncIterator[str]:
    """Stream tokens from DeepSeek for the given user message.

    DeepSeek exposes an OpenAI-compatible Chat Completions API, so we reuse
    the openai client pointed at the DeepSeek base URL.
    """
    if not settings.deepseek_api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set")

    client = AsyncOpenAI(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )
    stream = await client.chat.completions.create(
        model=settings.deepseek_model,
        messages=[{"role": "user", "content": message}],
        stream=True,
    )
    async for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta and delta.content:
            yield delta.content
