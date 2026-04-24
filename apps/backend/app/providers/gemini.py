from collections.abc import AsyncIterator

from google import genai

from app.settings import settings


async def stream_gemini(message: str) -> AsyncIterator[str]:
    """Stream tokens from Gemini for the given user message."""
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    client = genai.Client(api_key=settings.gemini_api_key)
    stream = await client.aio.models.generate_content_stream(
        model=settings.gemini_model,
        contents=message,
    )
    async for chunk in stream:
        text = getattr(chunk, "text", None)
        if text:
            yield text
