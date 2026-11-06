from __future__ import annotations

import base64 as _base64
import binascii
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ValidationError, model_validator

from app import session_bus
from app.logging import log
from app.models.coding import ExtractedProblem
from app.prompts.coding_extraction import EXTRACTION_MIN_CONFIDENCE, EXTRACTION_SCAN_MAX_IMAGES
from app.redis_client import (
    add_seen_problem_fingerprint,
    get_current_problem,
    set_current_problem,
    set_screen_context,
)
from app.services.coding_extraction import (
    arm_cooldown,
    cached_result,
    cooldown_problem,
    extract_problem,
    images_content_hash,
    is_fragment_of,
    problem_fingerprint,
    store_result,
)
from app.settings import settings

router = APIRouter(prefix="/api/vision")


class ExtractRequest(BaseModel):
    # Exactly one of these: a single screenshot (watcher / Re-extract), or the
    # ordered screenshots of a scroll scan, merged into one problem.
    image_base64: str | None = Field(default=None, min_length=16)
    images_base64: list[str] | None = Field(
        default=None, min_length=1, max_length=EXTRACTION_SCAN_MAX_IMAGES
    )
    # Scan only: screenshot 1 is the whole screen, the rest are crops of the
    # region that scrolled (see CODING_EXTRACTION_SCAN_CROP_NOTE).
    scan_cropped: bool = False
    session_id: str = Field(min_length=1)
    force: bool = False
    # Optional override of the provider used for vision extraction. When
    # absent the service resolves it from the session's default_provider,
    # so the user-selected model in the Coding panel reaches the OCR step.
    provider: str | None = None

    @model_validator(mode="after")
    def _one_image_source(self) -> ExtractRequest:
        if (self.image_base64 is None) == (self.images_base64 is None):
            raise ValueError("send exactly one of image_base64 or images_base64")
        return self

    @property
    def is_scan(self) -> bool:
        return self.images_base64 is not None

    def encoded_images(self) -> list[str]:
        return self.images_base64 if self.images_base64 is not None else [self.image_base64 or ""]


# A full scan is ~1-8 MB of JPEGs; anything far beyond that is a bug or abuse.
MAX_DECODED_IMAGE_BYTES = 32 * 1024 * 1024


def _decode(image_base64: str) -> bytes:
    payload = image_base64.split(",", 1)[1] if image_base64.startswith("data:") else image_base64
    try:
        return _base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid base64: {exc}") from exc


# Keeps a pasted 2,000-line file from bloating every answer prompt.
SCREEN_CONTEXT_MAX_CHARS = 12_000


def screen_context_text(problem: ExtractedProblem) -> str | None:
    """What a spoken question could be pointing at, as plain text: the
    question or problem on screen plus any visible code. None when the frame
    had nothing readable (keep the previous context instead of wiping it)."""
    parts: list[str] = []
    if problem.is_screen_question and problem.question:
        parts.append(f"Question shown on screen:\n{problem.question.strip()}")
    elif problem.is_coding_problem and problem.problem_statement:
        title = f"{problem.title.strip()}\n" if problem.title else ""
        parts.append(f"Coding problem on screen:\n{title}{problem.problem_statement.strip()}")
    code = (problem.screen_code or "").rstrip()
    signature = (problem.function_signature or "").rstrip()
    if code.strip():
        parts.append(f"Code on screen:\n{code}")
    elif signature.strip() and problem.is_coding_problem:
        # Vision files the editor's contents here when they look like the
        # starter - which for a "fix this code" task is the buggy code itself.
        parts.append(f"Code in the editor:\n{signature}")
    if not parts:
        return None
    text = "\n\n".join(parts)
    if len(text) > SCREEN_CONTEXT_MAX_CHARS:
        text = text[:SCREEN_CONTEXT_MAX_CHARS] + "\n… (truncated)"
    return text


async def _known_problem(session_id: str) -> ExtractedProblem | None:
    raw = await get_current_problem(session_id)
    if not raw:
        return None
    try:
        return ExtractedProblem.model_validate_json(raw)
    except ValidationError:
        return None


@router.post("/extract")
async def extract(request: ExtractRequest) -> dict[str, Any]:
    images = [_decode(encoded) for encoded in request.encoded_images()]
    if not all(images):
        raise HTTPException(status_code=400, detail="empty image")
    if sum(len(image) for image in images) > MAX_DECODED_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="images too large")
    # A scan is an explicit user action, like Re-extract: never served from
    # the cache/cooldown, and never skipped for lack of a listener.
    explicit = request.force or request.is_scan
    source = "scan" if request.is_scan else ("force" if request.force else "auto")

    # No panel listening → a detection would just be dropped (emitted=False),
    # so don't pay for the vision model. This is the common "app was left open
    # overnight / the /session socket dropped" case: the desktop keeps POSTing
    # frames, but there's nowhere to deliver a result. `force` (Re-extract)
    # always comes from an open panel, so it bypasses this.
    if request.session_id and not explicit and not session_bus.has_subscriber(request.session_id):
        return {"problem": None, "emitted": False, "skipped": "no_listener"}

    image_hash = images_content_hash(images)

    # Server-side dedup: if we've processed this exact image in the last 60s
    # for this session, return the cached result (unless force=true).
    if not explicit:
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
            images,
            request.session_id,
            provider=request.provider,
            cropped=request.is_scan and request.scan_cropped,
        )
    except Exception as exc:  # noqa: BLE001 - surface the provider error to the client
        log.error("vision.extract_error", session_id=request.session_id, error=str(exc))
        raise HTTPException(status_code=502, detail=str(exc)[:500]) from exc

    await store_result(request.session_id, image_hash, problem)
    screen_text = screen_context_text(problem)
    if screen_text:
        await set_screen_context(request.session_id, screen_text)

    emitted = False
    if (
        problem.is_screen_question
        and problem.confidence >= EXTRACTION_MIN_CONFIDENCE
        and problem.question
    ):
        fingerprint = problem_fingerprint(problem)
        emitted = await session_bus.publish(
            request.session_id,
            {
                "type": "screen_question_detected",
                "question": problem.question,
                "fingerprint": fingerprint,
                "source": source,
            },
        )
        log.info(
            "vision.screen_question_emitted",
            session_id=request.session_id,
            fingerprint=fingerprint,
            emitted=emitted,
        )
    elif (
        problem.is_coding_problem
        and problem.confidence >= EXTRACTION_MIN_CONFIDENCE
        and problem.problem_statement
    ):
        # The watcher re-read a slice of the problem the panel already has
        # (e.g. the bottom half after a scan) — nothing new, so don't open a
        # truncated tab. Re-arm the cooldown on the KNOWN problem to stop
        # paying for OCR of the same page.
        known = None if explicit else await _known_problem(request.session_id)
        if known is not None and is_fragment_of(problem, known):
            if settings.vision_cooldown_s > 0:
                await arm_cooldown(request.session_id, known)
            log.info("vision.fragment_suppressed", session_id=request.session_id)
            return {
                "problem": known.model_dump(),
                "emitted": False,
                "cached": False,
                "suppressed": "fragment_of_current",
                "image_hash": image_hash,
            }
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
                "source": source,
            },
        )
        log.info(
            "vision.problem_emitted",
            session_id=request.session_id,
            source=source,
            images=len(images),
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
