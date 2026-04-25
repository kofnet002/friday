from __future__ import annotations

import base64 as _base64
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app import session_bus
from app.logging import log
from app.prompts.coding_extraction import EXTRACTION_MIN_CONFIDENCE
from app.redis_client import add_seen_problem_fingerprint, set_current_problem
from app.services.coding_extraction import (
    cached_result,
    extract_problem,
    image_content_hash,
    problem_fingerprint,
    store_result,
)

router = APIRouter(prefix="/api/vision")


class ExtractRequest(BaseModel):
    image_base64: str = Field(min_length=16)
    session_id: str = Field(min_length=1)
    force: bool = False


@router.post("/extract")
async def extract(request: ExtractRequest) -> dict[str, Any]:
    try:
        payload = (
            request.image_base64.split(",", 1)[1]
            if request.image_base64.startswith("data:")
            else request.image_base64
        )
        image_bytes = _base64.b64decode(payload, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid base64: {exc}") from exc

    if not image_bytes:
        raise HTTPException(status_code=400, detail="empty image")

    image_hash = image_content_hash(image_bytes)

    # Server-side dedup: if we've processed this exact image in the last 60s
    # for this session, return the cached result (unless force=true).
    if not request.force:
        cached = await cached_result(request.session_id, image_hash)
        if cached is not None:
            log.info("vision.cache_hit", session_id=request.session_id, hash=image_hash[:12])
            return {
                "problem": cached.model_dump(),
                "emitted": False,
                "cached": True,
                "image_hash": image_hash,
            }

    try:
        problem = await extract_problem(request.image_base64, request.session_id)
    except Exception as exc:  # noqa: BLE001 - surface the provider error to the client
        log.error("vision.extract_error", session_id=request.session_id, error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc)[:500]) from exc

    await store_result(request.session_id, image_hash, problem)

    emitted = False
    if (
        problem.is_coding_problem
        and problem.confidence >= EXTRACTION_MIN_CONFIDENCE
        and problem.problem_statement
    ):
        fingerprint = problem_fingerprint(problem)
        is_new = await add_seen_problem_fingerprint(request.session_id, fingerprint)
        if is_new or request.force:
            await set_current_problem(request.session_id, problem.model_dump_json())
            emitted = await session_bus.publish(
                request.session_id,
                {
                    "type": "coding_problem_detected",
                    "problem": problem.model_dump(),
                    "fingerprint": fingerprint,
                },
            )
            log.info(
                "vision.problem_emitted",
                session_id=request.session_id,
                fingerprint=fingerprint,
                emitted=emitted,
            )

    return {
        "problem": problem.model_dump(),
        "emitted": emitted,
        "cached": False,
        "image_hash": image_hash,
    }
