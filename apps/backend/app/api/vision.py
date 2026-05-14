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
    # Optional override of the provider used for vision extraction. When
    # absent the service resolves it from the session's default_provider,
    # so the user-selected model in the Coding panel reaches the OCR step.
    provider: str | None = None


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
        problem = await extract_problem(
            request.image_base64,
            request.session_id,
            provider=request.provider,
        )
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
        # The seen-set is informational now (used for usage analytics) —
        # NOT a publish gate. The frontend's onCodingProblemDetected
        # dedupes by fingerprint when matching against the current tabs,
        # so emitting on every valid detection is safe and ensures that
        # re-extracts always reach the panel even after a 1-hour Redis
        # TTL or a tab close. Pre-this fix, a fingerprint already in the
        # Redis seen-set silently blocked emission and the panel sat
        # idle while vision kept burning tokens.
        is_first = await add_seen_problem_fingerprint(request.session_id, fingerprint)
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
            first_seen=is_first,
        )
    else:
        # Log the skip reason so "vision detected but nothing happened"
        # is debuggable without a code dive.
        log.info(
            "vision.problem_not_emitted",
            session_id=request.session_id,
            is_coding_problem=problem.is_coding_problem,
            confidence=problem.confidence,
            has_statement=bool(problem.problem_statement),
        )

    return {
        "problem": problem.model_dump(),
        "emitted": emitted,
        "cached": False,
        "image_hash": image_hash,
    }
