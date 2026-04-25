from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any, cast

from google import genai
from google.genai import types as genai_types
from pydantic import ValidationError

from app.logging import log
from app.models.coding import ExtractedProblem
from app.prompts.coding_extraction import (
    CODING_EXTRACTION_SYSTEM_PROMPT,
    EXTRACTION_MAX_OUTPUT_TOKENS,
    EXTRACTION_TEMPERATURE,
)
from app.redis_client import get_redis
from app.services.usage import record_vision_call
from app.settings import settings

VISION_DEDUP_TTL_S = 60


def image_content_hash(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()


def _cache_key(session_id: str, image_hash: str) -> str:
    return f"session:{session_id}:vision_cache:{image_hash}"


async def cached_result(session_id: str, image_hash: str) -> ExtractedProblem | None:
    client = await get_redis()
    if client is None:
        return None
    raw: str | None = await client.get(_cache_key(session_id, image_hash))
    if not raw:
        return None
    try:
        data = json.loads(raw)
        return ExtractedProblem.model_validate(data)
    except (json.JSONDecodeError, ValidationError):
        return None


async def store_result(session_id: str, image_hash: str, problem: ExtractedProblem) -> None:
    client = await get_redis()
    if client is None:
        return
    key = _cache_key(session_id, image_hash)
    # redis.asyncio returns Awaitable on async clients; cast for mypy.
    from collections.abc import Awaitable  # local to keep module clean

    await cast(
        Awaitable[Any],
        client.set(key, problem.model_dump_json(), ex=VISION_DEDUP_TTL_S),
    )


def problem_fingerprint(problem: ExtractedProblem) -> str:
    """Stable hash of the problem statement — used to dedup the "have we
    already shown this problem this session?" check."""
    blob = (problem.problem_statement or "").strip().lower()
    if problem.title:
        blob = problem.title.strip().lower() + "\n" + blob
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


async def extract_problem(image_base64: str, session_id: str) -> ExtractedProblem:
    """Call Gemini Flash with the screenshot and validate the JSON response."""
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")

    # Allow data-URI prefix ("data:image/jpeg;base64,…") as well as raw base64.
    payload = image_base64.split(",", 1)[1] if image_base64.startswith("data:") else image_base64
    image_bytes = base64.b64decode(payload)

    client = genai.Client(api_key=settings.gemini_api_key)

    t0 = time.time()
    response = await client.aio.models.generate_content(
        model=settings.vision_extraction_model,
        contents=[
            genai_types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
        ],
        config=genai_types.GenerateContentConfig(
            system_instruction=CODING_EXTRACTION_SYSTEM_PROMPT,
            temperature=EXTRACTION_TEMPERATURE,
            max_output_tokens=EXTRACTION_MAX_OUTPUT_TOKENS,
            response_mime_type="application/json",
        ),
    )
    elapsed_ms = int((time.time() - t0) * 1000)

    text = (response.text or "").strip()
    if not text:
        raise RuntimeError("empty extraction response")

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        log.warning("extraction.bad_json", raw=text[:300])
        raise RuntimeError(f"extraction JSON parse failed: {exc}") from exc

    try:
        problem = ExtractedProblem.model_validate(data)
    except ValidationError as exc:
        log.warning("extraction.validation_error", error=str(exc), raw=text[:300])
        raise RuntimeError(f"extraction schema invalid: {exc}") from exc

    usage = getattr(response, "usage_metadata", None)
    output_tokens = int(getattr(usage, "candidates_token_count", 0) or 0) if usage else None
    await record_vision_call(
        session_id=session_id,
        model=settings.vision_extraction_model,
        output_tokens=output_tokens,
    )

    log.info(
        "extraction.done",
        session_id=session_id,
        elapsed_ms=elapsed_ms,
        is_coding_problem=problem.is_coding_problem,
        confidence=problem.confidence,
    )
    return problem
