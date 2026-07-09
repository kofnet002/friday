from collections.abc import AsyncIterator

from anthropic import AsyncAnthropic

from app.settings import settings

# Opus 4.8 (and the rest of the 4.x family) reject temperature/top_p/top_k —
# so unlike the OpenAI/Gemini streamers we pass none of them. max_tokens is
# required by the Messages API. Thinking is omitted: this legacy /api/chat
# path wants the fastest possible first token.
_CHAT_MAX_TOKENS = 1500


async def stream_claude(message: str) -> AsyncIterator[str]:
    """Stream tokens from Claude (Anthropic) for the given user message."""
    if not settings.anthropic_api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set")

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    async with client.messages.stream(
        model=settings.anthropic_model,
        max_tokens=_CHAT_MAX_TOKENS,
        messages=[{"role": "user", "content": message}],
    ) as stream:
        async for text in stream.text_stream:
            if text:
                yield text
