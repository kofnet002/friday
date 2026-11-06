"""Model lab: try a question (typed or read from screenshots) on any model.

Unlike the live session paths, nothing here is cached, tied to a session, or
silently retried on another provider: the point is to see exactly what one
model does with one question. Used by the web app's /lab page.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.api.vision import MAX_DECODED_IMAGE_BYTES, _decode
from app.logging import log
from app.models.catalog import ModelSelection, parse_effort, resolve_model
from app.prompts.answer_generation import AnswerContext
from app.prompts.coding_extraction import EXTRACTION_SCAN_MAX_IMAGES
from app.services.answer import stream_answer
from app.services.coding_extraction import (
    _extract_claude,
    _extract_gemini,
    _extract_openai,
    extraction_plan,
)
from app.services.usage import _cost

router = APIRouter(prefix="/api/lab")

MAX_QUESTION_CHARS = 40_000


class LabExtractRequest(BaseModel):
    images_base64: list[str] = Field(min_length=1, max_length=EXTRACTION_SCAN_MAX_IMAGES)
    model: str = Field(min_length=1)


class LabAnswerRequest(BaseModel):
    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    model: str = Field(min_length=1)
    effort: str | None = None


def _resolve(model: str) -> ModelSelection:
    selection = resolve_model(model, provider_hint=None)
    if selection is None:
        raise HTTPException(status_code=400, detail=f"unknown model: {model}")
    return selection


@router.post("/extract")
async def lab_extract(request: LabExtractRequest) -> dict[str, Any]:
    selection = _resolve(request.model)
    if selection.provider == "deepseek":
        raise HTTPException(status_code=400, detail="DeepSeek models can't read images")
    images = [_decode(encoded) for encoded in request.images_base64]
    if not all(images):
        raise HTTPException(status_code=400, detail="empty image")
    if sum(len(image) for image in images) > MAX_DECODED_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="images too large")

    plan = extraction_plan(len(images))
    started = time.monotonic()
    try:
        if selection.provider == "claude":
            problem, _, used = await _extract_claude(
                images, plan, f"lab-{int(started)}", model=selection.model
            )
        elif selection.provider == "gemini":
            problem, _, used = await _extract_gemini(images, plan, model=selection.model)
        else:
            problem, _, used = await _extract_openai(images, plan, model=selection.model)
    except Exception as exc:  # the page shows the provider's error
        log.warning("lab.extract_failed", model=selection.model, error=str(exc)[:300])
        raise HTTPException(status_code=502, detail=f"{selection.model}: {exc}") from exc
    return {
        "problem": problem.model_dump(),
        "model": used,
        "ms": int((time.monotonic() - started) * 1000),
    }


async def _answer_events(
    selection: ModelSelection, question: str, effort: str | None
) -> AsyncIterator[dict[str, str]]:
    usage: dict[str, Any] = {}

    def on_usage(input_tokens: int | None, output_tokens: int | None) -> None:
        usage.update(
            input=input_tokens,
            output=output_tokens,
            cost=_cost(selection.model, input_tokens or 0, output_tokens),
        )

    started = time.monotonic()
    first_token_ms: int | None = None
    try:
        # No on_fallback: a failure surfaces as an error instead of quietly
        # being answered by another provider.
        async for token in stream_answer(
            selection.provider,
            question,
            AnswerContext(),
            model=selection.model,
            effort=parse_effort(effort),
            on_usage=on_usage,
        ):
            if first_token_ms is None:
                first_token_ms = int((time.monotonic() - started) * 1000)
            yield {"event": "token", "data": json.dumps({"text": token})}
        yield {
            "event": "done",
            "data": json.dumps(
                {
                    "first_token_ms": first_token_ms,
                    "total_ms": int((time.monotonic() - started) * 1000),
                    "usage": usage or None,
                }
            ),
        }
    except Exception as exc:  # surface any provider error to the page
        log.warning("lab.answer_failed", model=selection.model, error=str(exc)[:300])
        yield {"event": "error", "data": json.dumps({"message": str(exc)})}


@router.post("/answer")
async def lab_answer(request: LabAnswerRequest) -> EventSourceResponse:
    selection = _resolve(request.model)
    return EventSourceResponse(_answer_events(selection, request.question, request.effort))
