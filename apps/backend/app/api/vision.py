from __future__ import annotations

import asyncio
import base64 as _base64
import hashlib
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from app import session_bus
from app.logging import log
from app.models.coding import ExtractedProblem
from app.prompts.coding_extraction import EXTRACTION_MIN_CONFIDENCE
from app.redis_client import (
    add_seen_problem_fingerprint,
    clear_screen_state,
    get_current_screen_images,
    get_screen_references,
    prune_screen_images,
    put_screen_images,
    set_current_problem,
    set_current_screen_images,
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
from app.services.screen_memory import (  # noqa: F401 - re-exported
    MAX_REFERENCE_CHARS,
    REFERENCE_HEADER,
    compose_screen_context,
    merge_references,
    reference_saved_event,
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
    # Guided-scan id shared by every request of one scan. `speculative` reads
    # run while the user is still scrolling: they answer fully visible
    # questions early, and the final request reuses their result when it
    # covers the same views.
    scan_id: str | None = Field(default=None, max_length=64)
    speculative: bool = False

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


def scan_digest(images: list[bytes]) -> str:
    """Identity of an ordered set of scan views."""
    digest = hashlib.sha256()
    for image in images:
        digest.update(len(image).to_bytes(8, "big"))
        digest.update(image)
    return digest.hexdigest()


class ScanExtractionCache:
    """Shares one vision read per (session, views) between the speculative
    request made while the user scrolls and the final request at the end.
    In-process and small: entries only need to live for the length of a scan.
    A failed read is dropped so the next request retries it."""

    def __init__(self, max_entries: int = 16) -> None:
        self._max_entries = max_entries
        self._tasks: OrderedDict[tuple[str, str], asyncio.Task[ExtractedProblem]] = OrderedDict()

    def __len__(self) -> int:
        return len(self._tasks)

    async def run(
        self,
        key: tuple[str, str],
        extract: Callable[[], Awaitable[ExtractedProblem]],
    ) -> ExtractedProblem:
        task = self._tasks.get(key)
        if task is None:
            task = asyncio.ensure_future(extract())
            self._tasks[key] = task
            while len(self._tasks) > self._max_entries:
                self._tasks.popitem(last=False)
        try:
            # shield: a cancelled caller (client went away) must not cancel
            # the read another request is waiting on.
            problem = await asyncio.shield(task)
        except Exception:
            if self._tasks.get(key) is task:
                del self._tasks[key]
            raise
        # Callers mutate their copy (e.g. mark_scan_incomplete).
        return problem.model_copy(deep=True)


_scan_extractions = ScanExtractionCache()


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
        and problem.questions
        and problem.confidence >= EXTRACTION_MIN_CONFIDENCE
    )


def screen_question_event(
    problem: ExtractedProblem,
    *,
    is_scan: bool,
    speculative: bool = False,
    scan_id: str | None = None,
) -> dict[str, Any]:
    return {
        "type": "screen_question_detected",
        "question": problem.question,
        "questions": problem.questions,
        "screen_code": problem.screen_code,
        # Mid-scan the page isn't fully read yet, whatever the model says.
        "completeness": "partial" if speculative else problem.completeness,
        "missing_sections": problem.missing_sections,
        "source": "guided_scan" if is_scan else "single_frame",
        "speculative": speculative,
        "scan_id": scan_id,
    }


async def update_screen_images(
    sid: str,
    encoded_images: list[str],
    problem: ExtractedProblem,
    *,
    speculative: bool,
) -> list[str]:
    """Keep screenshots of frames with charts/diagrams as the current screen's
    images. A text-only final read clears them; a speculative one leaves them.
    Returns the stored keys for this read."""
    frames = problem.valid_visual_frames(len(encoded_images))
    if not frames:
        if not speculative:
            old = await get_current_screen_images(sid)
            await set_current_screen_images(sid, [])
            await prune_screen_images(sid, old)
        return []
    old = await get_current_screen_images(sid)
    keys = await put_screen_images(sid, [encoded_images[i] for i in frames])
    await set_current_screen_images(sid, keys)
    await prune_screen_images(sid, old)
    return keys


@router.delete("/screen-context")
async def clear_screen_context(session_id: str) -> dict[str, bool]:
    """Forget remembered passages and the current screen text, e.g. when the
    user moves on to a different assessment."""
    await clear_screen_state(session_id)
    return {"ok": True}


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

    speculative = is_scan and request.speculative

    async def run_extraction() -> ExtractedProblem:
        return await extract_problem(
            image_base64 if not is_scan else image_list,
            request.session_id,
            provider=request.provider,
            claude_model=normalize_claude_model(request.claude_model),
        )

    try:
        if is_scan:
            problem = await _scan_extractions.run(
                (request.session_id, scan_digest(image_list)), run_extraction
            )
        else:
            problem = await run_extraction()
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
    visual_keys = await update_screen_images(
        request.session_id,
        [request.image_base64] if request.image_base64 is not None else encoded_images,
        problem,
        speculative=speculative,
    )
    references = await get_screen_references(request.session_id)
    if (
        problem.is_reference_material
        and not problem.is_coding_problem
        and problem.visible_context
        and problem.confidence >= 0.5
    ):
        updated = merge_references(references, problem.visible_context, visual_keys)
        if updated != references:
            kept = {k for ref in updated for k in ref.image_keys}
            displaced = [k for ref in references for k in ref.image_keys if k not in kept]
            references = updated
            await set_screen_references(request.session_id, references)
            await prune_screen_images(request.session_id, displaced)
            log.info("vision.reference_saved", session_id=request.session_id, count=len(references))
            await session_bus.publish(
                request.session_id, reference_saved_event(references, problem.visible_context)
            )
    current_screen = "\n\n".join(
        part for part in (screen_text or None, problem.screen_code) if part
    )
    await set_screen_context(request.session_id, compose_screen_context(current_screen, references))

    emitted = False
    if should_emit_screen_question(problem):
        emitted = await session_bus.publish(
            request.session_id,
            screen_question_event(
                problem, is_scan=is_scan, speculative=speculative, scan_id=request.scan_id
            ),
        )
    if speculative:
        # A coding problem can still be cut off mid-scroll; leave solving to
        # the final request so a truncated problem never opens a tab.
        return {
            "problem": problem.model_dump(),
            "emitted": emitted,
            "cached": False,
            "image_hash": image_hash,
            "source": "guided_scan",
            "speculative": True,
        }
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

