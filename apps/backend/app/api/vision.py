from __future__ import annotations

import base64 as _base64
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from app import session_bus
from app.logging import log
from app.models.coding import ExtractedProblem
from app.prompts.coding_extraction import EXTRACTION_MIN_CONFIDENCE
from app.prompts.function_call_extraction import FUNCTION_CALL_EXTRACTION_MIN_CONFIDENCE
from app.redis_client import add_seen_problem_fingerprint, set_current_problem, set_screen_context
from app.services import function_call_extraction as fc_extraction
from app.services.coding_extraction import (
    arm_cooldown,
    cached_result,
    cooldown_problem,
    extract_problem,
    image_content_hash,
    problem_fingerprint,
    store_result,
)
from app.settings import settings

router = APIRouter(prefix="/api/vision")


class ExtractRequest(BaseModel):
    image_base64: str | None = Field(default=None, min_length=16)
    images_base64: list[str] | None = None
    session_id: str = Field(min_length=1)
    force: bool = False
    # Optional override of the provider used for vision extraction. When
    # absent the service resolves it from the session's default_provider,
    # so the user-selected model in the Coding panel reaches the OCR step.
    provider: str | None = None
    scan_cropped: bool = False
    scan_incomplete: bool = False

    @model_validator(mode="after")
    def exactly_one_source(self) -> "ExtractRequest":
        if (self.image_base64 is None) == (self.images_base64 is None):
            raise ValueError("provide exactly one of image_base64 or images_base64")
        if self.images_base64 is not None and not self.images_base64:
            raise ValueError("images_base64 must contain at least one image")
        return self


MAX_SCAN_IMAGES = 12
MAX_SCAN_BYTES = 32 * 1024 * 1024


def decode_images(encoded_images: list[str]) -> list[bytes]:
    if len(encoded_images) > MAX_SCAN_IMAGES:
        raise ValueError(f"guided scan supports at most {MAX_SCAN_IMAGES} images")
    decoded: list[bytes] = []
    total = 0
    for encoded in encoded_images:
        payload = encoded.split(",", 1)[1] if encoded.startswith("data:") else encoded
        try:
            image_bytes = _base64.b64decode(payload, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError(f"invalid base64 image: {exc}") from exc
        if not image_bytes:
            raise ValueError("empty image")
        total += len(image_bytes)
        if total > MAX_SCAN_BYTES:
            raise ValueError("guided scan exceeds 32 MiB decoded image data")
        decoded.append(image_bytes)
    return decoded


def mark_scan_incomplete(problem: ExtractedProblem) -> ExtractedProblem:
    """Make an extraction partial when capture ended at a hard scan limit."""
    problem.completeness = "partial"
    marker = "remaining page content may not have been captured"
    if marker not in problem.missing_sections:
        problem.missing_sections.append(marker)
    return problem


def should_emit_screen_question(problem: ExtractedProblem) -> bool:
    return bool(
        problem.is_screen_question
        and not problem.is_coding_problem
        and problem.question
        and problem.confidence >= EXTRACTION_MIN_CONFIDENCE
    )


@router.post("/extract")
async def extract(request: ExtractRequest) -> dict[str, Any]:
    is_scan = request.images_base64 is not None
    try:
        encoded_images = request.images_base64 or [request.image_base64 or ""]
        image_list = decode_images(encoded_images)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    image_bytes = image_list[0]
    image_base64 = request.image_base64 or encoded_images[0]

    # No panel listening → a detection would just be dropped (emitted=False),
    # so don't pay for the vision model. This is the common "app was left open
    # overnight / the /session socket dropped" case: the desktop keeps POSTing
    # frames, but there's nowhere to deliver a result. `force` (Re-extract)
    # always comes from an open panel, so it bypasses this.
    if request.session_id and not request.force and not session_bus.has_subscriber(
        request.session_id
    ):
        return {"problem": None, "emitted": False, "skipped": "no_listener"}

    image_hash = image_content_hash(image_bytes)

    # Server-side dedup: if we've processed this exact image in the last 60s
    # for this session, return the cached result (unless force=true).
    if not request.force and not is_scan:
        cached = await cached_result(request.session_id, image_hash)
        if cached is not None:
            log.info("vision.cache_hit", session_id=request.session_id, hash=image_hash[:12])
            return {
                "problem": cached.model_dump(),
                "emitted": False,
                "cached": True,
                "image_hash": image_hash,
            }
        # Post-detection cooldown: once we've locked onto a coding problem,
        # skip re-running the (expensive) vision model on every subsequent
        # frame while it stays on screen — serve the detected problem instead.
        # Armed only after a confident detection (see below), so a problem
        # appearing on a previously-idle screen is still caught immediately.
        if settings.vision_cooldown_s > 0:
            locked = await cooldown_problem(request.session_id)
            if locked is not None:
                log.info("vision.cooldown_hit", session_id=request.session_id)
                return {
                    "problem": locked.model_dump(),
                    "emitted": False,
                    "cached": True,
                    "image_hash": image_hash,
                }

    try:
        problem = await extract_problem(
            image_base64 if not is_scan else image_list,
            request.session_id,
            provider=request.provider,
        )
    except Exception as exc:  # noqa: BLE001 - surface the provider error to the client
        log.error("vision.extract_error", session_id=request.session_id, error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc)[:500]) from exc

    if is_scan and request.scan_incomplete:
        problem = mark_scan_incomplete(problem)

    if not is_scan:
        await store_result(request.session_id, image_hash, problem)

    screen_text = "\n\n".join(
        part
        for part in (
            problem.question if problem.is_screen_question else None,
            problem.problem_statement if problem.is_coding_problem else None,
            problem.visible_context,
        )
        if part
    )
    # Always replace the prior screen context. Keeping the previous value
    # when a new screen has no extractable question/code can make a spoken
    # question get answered against stale content from an earlier screen.
    await set_screen_context(
        request.session_id,
        "\n\n".join(part for part in (screen_text or None, problem.screen_code) if part),
    )

    emitted = False
    if should_emit_screen_question(problem):
        emitted = await session_bus.publish(
            request.session_id,
            {
                "type": "screen_question_detected",
                "question": problem.question,
                "screen_code": problem.screen_code,
                "completeness": problem.completeness,
                "missing_sections": problem.missing_sections,
                "source": "guided_scan" if is_scan else "single_frame",
            },
        )
    if (
        problem.is_coding_problem
        and problem.confidence >= EXTRACTION_MIN_CONFIDENCE
        and problem.problem_statement
    ):
        # Arm the re-scan cooldown: we've locked onto a problem, so stop
        # re-OCR-ing it every frame until the cooldown lapses.
        if settings.vision_cooldown_s > 0:
            await arm_cooldown(request.session_id, problem)
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
                "source": "guided_scan" if is_scan else "single_frame",
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

    # Function-calling assessments aren't coding problems, so the coding
    # detector rejects them (is_coding_problem=false → emitted=false). When
    # that happens, give the frame a second look for a "pick the tool + build
    # the payload" test. Runs ONLY here — coding frames never pay for it.
    function_call: dict[str, Any] | None = None
    if not emitted and not is_scan and settings.function_call_detection_enabled:
        function_call = await _maybe_detect_function_call(
            request.session_id, image_base64, image_hash, force=request.force or is_scan
        )

    return {
        "problem": problem.model_dump(),
        "emitted": emitted,
        "function_call": function_call,
        "cached": False,
        "image_hash": image_hash,
        "source": "guided_scan" if is_scan else "single_frame",
    }


async def _maybe_detect_function_call(
    session_id: str, image_base64: str, image_hash: str, *, force: bool
) -> dict[str, Any] | None:
    """Second-pass detection for function-calling assessments. Returns a small
    summary (`{detected, emitted, fingerprint}`) or None when detection was
    skipped/failed. Best-effort: never raises into the vision response — a
    coding detection already succeeded or legitimately found nothing, and a FC
    detection error must not 502 the frame."""
    # Own dedup cache + cooldown (separate Redis namespace from coding) so we
    # don't re-run the model every frame while the same assessment sits on
    # screen. A force re-extract bypasses both.
    if not force:
        if await fc_extraction.cached_result(session_id, image_hash) is not None:
            return None
        if settings.vision_cooldown_s > 0 and await fc_extraction.cooldown_detection(session_id):
            return None

    try:
        fc = await fc_extraction.extract_function_call(image_base64, session_id)
    except Exception as exc:  # noqa: BLE001
        log.warning("fc_extraction.failed", session_id=session_id, error=str(exc)[:200])
        return None

    await fc_extraction.store_result(session_id, image_hash, fc)

    if not (fc.is_function_call and fc.confidence >= FUNCTION_CALL_EXTRACTION_MIN_CONFIDENCE):
        log.info(
            "fc.not_emitted",
            session_id=session_id,
            is_function_call=fc.is_function_call,
            confidence=fc.confidence,
        )
        return None

    if settings.vision_cooldown_s > 0:
        await fc_extraction.arm_cooldown(session_id, fc)
    fingerprint = fc_extraction.function_call_fingerprint(fc)
    emitted = await session_bus.publish(
        session_id,
        {
            "type": "function_call_detected",
            "assessment": fc.model_dump(),
            "fingerprint": fingerprint,
        },
    )
    log.info("fc.emitted", session_id=session_id, fingerprint=fingerprint, emitted=emitted)
    return {"detected": True, "emitted": emitted, "fingerprint": fingerprint}
