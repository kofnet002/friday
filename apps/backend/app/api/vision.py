from __future__ import annotations

import base64 as _base64
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from app import session_bus
from app.logging import log
from app.models.coding import ExtractedProblem
from app.prompts.coding_extraction import EXTRACTION_MIN_CONFIDENCE
from app.redis_client import (
    add_seen_problem_fingerprint,
    get_screen_references,
    set_current_problem,
    set_screen_context,
    set_screen_references,
)
from app.services.claude_api import normalize_claude_model
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
    # Claude model picked in screen mode; ignored unless on the allow-list.
    claude_model: str | None = None
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


# Budget for remembered passages / preambles. Oldest are dropped first; the
# whole screen context is capped at 20k chars in redis_client.
MAX_REFERENCE_CHARS = 12_000
REFERENCE_HEADER = (
    "Earlier reference material on screen (passages / preambles the questions may refer to):"
)


def _norm(text: str) -> str:
    return " ".join(text.split()).lower()


def merge_references(references: list[str], new: str) -> list[str]:
    """Add a newly seen passage, dropping exact repeats and shorter earlier
    reads of the same passage (a rescan that captured more of it)."""
    new = new.strip()[:MAX_REFERENCE_CHARS]
    if not new:
        return list(references)
    new_norm = _norm(new)
    if any(new_norm in _norm(ref) for ref in references):
        return list(references)
    merged = [ref for ref in references if _norm(ref) not in new_norm] + [new]
    while len(merged) > 1 and sum(len(ref) for ref in merged) > MAX_REFERENCE_CHARS:
        merged.pop(0)
    return merged


def compose_screen_context(current: str, references: list[str]) -> str:
    """Current screen first (most relevant), then earlier reference material
    that isn't already visible on the current screen."""
    current_norm = _norm(current)
    earlier = [ref for ref in references if _norm(ref) not in current_norm]
    if not earlier:
        return current
    block = REFERENCE_HEADER + "\n\n" + "\n\n---\n\n".join(earlier)
    return f"{current}\n\n{block}" if current else block


def should_emit_screen_question(problem: ExtractedProblem) -> bool:
    return bool(
        problem.is_screen_question
        and not problem.is_coding_problem
        and problem.questions
        and problem.confidence >= EXTRACTION_MIN_CONFIDENCE
    )


def screen_question_event(problem: ExtractedProblem, *, is_scan: bool) -> dict[str, Any]:
    return {
        "type": "screen_question_detected",
        "question": problem.question,
        "questions": problem.questions,
        "screen_code": problem.screen_code,
        "completeness": problem.completeness,
        "missing_sections": problem.missing_sections,
        "source": "guided_scan" if is_scan else "single_frame",
    }


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
            claude_model=normalize_claude_model(request.claude_model),
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
            "\n\n".join(problem.questions) if problem.is_screen_question else None,
            problem.problem_statement if problem.is_coding_problem else None,
            problem.visible_context,
        )
        if part
    )
    # Always replace the prior *current-screen* context. Keeping the previous
    # value when a new screen has no extractable question/code can make a
    # spoken question get answered against stale content from an earlier
    # screen. Passages/preambles are the exception: questions are asked from
    # them after the user has scrolled on, so they are remembered separately
    # and appended as clearly-labelled earlier reference material.
    references = await get_screen_references(request.session_id)
    if (
        problem.is_reference_material
        and not problem.is_coding_problem
        and problem.visible_context
        and problem.confidence >= 0.5
    ):
        updated = merge_references(references, problem.visible_context)
        if updated != references:
            references = updated
            await set_screen_references(request.session_id, references)
            log.info("vision.reference_saved", session_id=request.session_id, count=len(references))
    current_screen = "\n\n".join(
        part for part in (screen_text or None, problem.screen_code) if part
    )
    await set_screen_context(request.session_id, compose_screen_context(current_screen, references))

    emitted = False
    if should_emit_screen_question(problem):
        emitted = await session_bus.publish(
            request.session_id, screen_question_event(problem, is_scan=is_scan)
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

    return {
        "problem": problem.model_dump(),
        "emitted": emitted,
        "cached": False,
        "image_hash": image_hash,
        "source": "guided_scan" if is_scan else "single_frame",
    }

