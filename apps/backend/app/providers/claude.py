from collections.abc import AsyncIterator

from app.services.claude_api import stream_claude_api
from app.settings import settings

# max_tokens is the visible-answer budget; claude_api adds thinking headroom
# for models that always think. Low effort: this legacy /api/chat path wants
# the fastest possible first token.
_CHAT_MAX_TOKENS = 1500


async def stream_claude(message: str) -> AsyncIterator[str]:
    """Stream tokens from Claude (Anthropic API) for the given user message."""
    async for text in stream_claude_api(
        system="",
        user=message,
        model=settings.anthropic_answer_model,
        max_tokens=_CHAT_MAX_TOKENS,
        effort=settings.anthropic_effort,
    ):
        yield text
