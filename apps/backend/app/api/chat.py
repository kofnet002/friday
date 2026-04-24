import json
from collections.abc import AsyncIterator
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.logging import log
from app.providers.gemini import stream_gemini
from app.providers.openai import stream_openai

router = APIRouter()

Provider = Literal["gemini", "openai"]


class ChatRequest(BaseModel):
    provider: Provider
    message: str = Field(min_length=1)


async def _token_events(provider: Provider, message: str) -> AsyncIterator[dict[str, str]]:
    log.info("chat.start", provider=provider, length=len(message))
    try:
        source = stream_gemini(message) if provider == "gemini" else stream_openai(message)
        async for token in source:
            yield {"event": "token", "data": json.dumps({"text": token})}
        yield {"event": "done", "data": "{}"}
        log.info("chat.done", provider=provider)
    except Exception as exc:  # noqa: BLE001 - surface any provider error to the client
        log.error("chat.error", provider=provider, error=str(exc))
        yield {"event": "error", "data": json.dumps({"message": str(exc)})}


@router.post("/api/chat")
async def chat(request: ChatRequest) -> EventSourceResponse:
    if request.provider not in ("gemini", "openai"):
        raise HTTPException(status_code=400, detail="invalid provider")
    return EventSourceResponse(_token_events(request.provider, request.message))
