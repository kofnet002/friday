"""Vision detection of function-calling assessments.

The coding-problem detector's sibling: given a screenshot, decide whether it's a
"Function Calling Test" and, if so, pull out the task + tool catalog as an
`ExtractedFunctionCall`. Same provider fan-out, dedup cache, and post-detection
cooldown as `coding_extraction`, but a separate Redis namespace so the two
detectors don't clobber each other's state.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
from typing import Any, Literal, cast

from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI
from pydantic import ValidationError

from app.logging import log
from app.models.function_calling import ExtractedFunctionCall
from app.prompts.function_call_extraction import (
    FUNCTION_CALL_EXTRACTION_MAX_OUTPUT_TOKENS,
    FUNCTION_CALL_EXTRACTION_SYSTEM_PROMPT,
    FUNCTION_CALL_EXTRACTION_TEMPERATURE,
)
from app.redis_client import get_redis
from app.services.claude_agent_auth import claude_available
from app.services.claude_api import claude_vision
from app.services.usage import record_vision_call
from app.settings import settings

Provider = Literal["gemini", "openai", "deepseek", "claude"]

_DEDUP_TTL_S = 60


def _claude_available() -> bool:
    return claude_available()


def function_call_fingerprint(fc: ExtractedFunctionCall) -> str:
    """Stable hash of the task + tool names — dedups "already detected this
    assessment this session?" the way problem_fingerprint does for coding."""
    blob = (fc.question or "").strip().lower()
    if fc.tools:
        blob += "\n" + ",".join(sorted(t.name for t in fc.tools))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


# ─── dedup cache + post-detection cooldown (own namespace) ───────────────────


def _cache_key(session_id: str, image_hash: str) -> str:
    return f"session:{session_id}:fc_vision_cache:{image_hash}"


def _cooldown_key(session_id: str) -> str:
    return f"session:{session_id}:fc_vision_cooldown"


async def cached_result(session_id: str, image_hash: str) -> ExtractedFunctionCall | None:
    client = await get_redis()
    if client is None:
        return None
    raw: str | None = await client.get(_cache_key(session_id, image_hash))
    if not raw:
        return None
    try:
        return ExtractedFunctionCall.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError):
        return None


async def store_result(session_id: str, image_hash: str, fc: ExtractedFunctionCall) -> None:
    client = await get_redis()
    if client is None:
        return
    await cast(
        Any,
        client.set(_cache_key(session_id, image_hash), fc.model_dump_json(), ex=_DEDUP_TTL_S),
    )


async def cooldown_detection(session_id: str) -> ExtractedFunctionCall | None:
    client = await get_redis()
    if client is None:
        return None
    raw: str | None = await client.get(_cooldown_key(session_id))
    if not raw:
        return None
    try:
        return ExtractedFunctionCall.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError):
        return None


async def arm_cooldown(session_id: str, fc: ExtractedFunctionCall) -> None:
    client = await get_redis()
    if client is None:
        return
    await cast(
        Any,
        client.set(_cooldown_key(session_id), fc.model_dump_json(), ex=settings.vision_cooldown_s),
    )


# ─── parse + per-provider extraction ─────────────────────────────────────────


def _strip_json_fence(text: str) -> str:
    text = (text or "").strip()
    if text.startswith("```"):
        body = text.split("\n", 1)[1] if "\n" in text else ""
        text = body.rsplit("```", 1)[0].strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


def _parse(text: str) -> ExtractedFunctionCall:
    text = _strip_json_fence(text)
    if not text:
        raise RuntimeError("empty function-call extraction response")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        log.warning("fc_extraction.bad_json", raw=text[:300])
        raise RuntimeError(f"function-call extraction parse failed: {exc}") from exc
    try:
        return ExtractedFunctionCall.model_validate(data)
    except ValidationError as exc:
        log.warning("fc_extraction.validation_error", error=str(exc)[:200], raw=text[:300])
        raise RuntimeError(f"function-call extraction schema invalid: {exc}") from exc


async def _extract_gemini(image_bytes: bytes) -> tuple[ExtractedFunctionCall, int | None, str]:
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    model = settings.vision_extraction_model
    response = await client.aio.models.generate_content(
        model=model,
        contents=[genai_types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg")],
        config=genai_types.GenerateContentConfig(
            system_instruction=FUNCTION_CALL_EXTRACTION_SYSTEM_PROMPT,
            temperature=FUNCTION_CALL_EXTRACTION_TEMPERATURE,
            max_output_tokens=FUNCTION_CALL_EXTRACTION_MAX_OUTPUT_TOKENS,
            response_mime_type="application/json",
        ),
    )
    fc = _parse(response.text or "")
    usage = getattr(response, "usage_metadata", None)
    output_tokens = int(getattr(usage, "candidates_token_count", 0) or 0) if usage else None
    return fc, output_tokens, model


async def _extract_openai(image_bytes: bytes) -> tuple[ExtractedFunctionCall, int | None, str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    client = AsyncOpenAI(api_key=settings.openai_api_key, timeout=20.0, max_retries=1)
    model = settings.openai_model
    image_url = f"data:image/jpeg;base64,{base64.b64encode(image_bytes).decode('ascii')}"
    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": FUNCTION_CALL_EXTRACTION_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Detect the function-calling assessment in this"
                        " screenshot as strict JSON matching the schema.",
                    },
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            },
        ],
        temperature=FUNCTION_CALL_EXTRACTION_TEMPERATURE,
        max_tokens=FUNCTION_CALL_EXTRACTION_MAX_OUTPUT_TOKENS,
        response_format={"type": "json_object"},
    )
    if not response.choices:
        raise RuntimeError("empty openai vision response")
    fc = _parse(response.choices[0].message.content or "")
    return fc, (response.usage.completion_tokens if response.usage else None), model


async def _extract_claude(
    image_bytes: bytes, session_id: str
) -> tuple[ExtractedFunctionCall, int | None, str]:
    raw, output_tokens, model_used = await claude_vision(
        image_bytes=image_bytes,
        system=FUNCTION_CALL_EXTRACTION_SYSTEM_PROMPT,
        prompt=(
            "Detect the function-calling assessment in the screenshot. Reply with"
            " ONLY a single JSON object matching the schema — no fences, no prose."
        ),
        model=settings.claude_vision_model,
        max_tokens=FUNCTION_CALL_EXTRACTION_MAX_OUTPUT_TOKENS,
        session_id=session_id,
    )
    return _parse(raw), output_tokens, model_used


def _provider_chain(chosen: Provider) -> list[Provider]:
    """Detection provider order: chosen first (if credentialed), then the other
    vision-capable providers. DeepSeek has no vision → dropped."""
    chain: list[Provider] = []
    order: list[Provider] = [chosen, "gemini", "openai", "claude"]
    for p in order:
        if p in chain:
            continue
        if p == "gemini" and settings.gemini_api_key:
            chain.append(p)
        elif p == "openai" and settings.openai_api_key:
            chain.append(p)
        elif p == "claude" and _claude_available():
            chain.append(p)
    return chain


async def extract_function_call(
    image_base64: str,
    session_id: str,
    provider: str | None = None,
) -> ExtractedFunctionCall:
    """Detect a function-calling assessment in the screenshot. DeepSeek (no
    vision) and Claude-without-credential fall through to Gemini/OpenAI."""
    payload = image_base64.split(",", 1)[1] if image_base64.startswith("data:") else image_base64
    image_bytes = base64.b64decode(payload)

    valid = ("gemini", "openai", "claude")
    chosen: Provider = (
        cast(Provider, settings.vision_provider)
        if settings.vision_provider in valid
        else cast(Provider, provider)
        if provider in valid
        else "gemini"
    )
    chain = _provider_chain(chosen) or ["gemini"]

    t0 = time.time()
    fc: ExtractedFunctionCall | None = None
    output_tokens: int | None = None
    model_used = ""
    used_provider: Provider = chain[0]
    last_exc: Exception | None = None
    for attempt, prov in enumerate(chain):
        if attempt:
            log.info("fc_extraction.fallback", prev=chain[attempt - 1], next=prov)
        try:
            if prov == "claude":
                fc, output_tokens, model_used = await _extract_claude(image_bytes, session_id)
            elif prov == "openai":
                fc, output_tokens, model_used = await _extract_openai(image_bytes)
            else:
                fc, output_tokens, model_used = await _extract_gemini(image_bytes)
            used_provider = prov
            break
        except Exception as exc:  # noqa: BLE001 - try the next provider
            last_exc = exc
            log.warning("fc_extraction.provider_failed", provider=prov, error=str(exc)[:200])
    if fc is None:
        raise last_exc if last_exc is not None else RuntimeError("no vision provider available")

    await record_vision_call(
        session_id=session_id,
        provider=used_provider,
        model=model_used,
        output_tokens=output_tokens,
    )
    log.info(
        "fc_extraction.done",
        session_id=session_id,
        provider=used_provider,
        model=model_used,
        elapsed_ms=int((time.time() - t0) * 1000),
        is_function_call=fc.is_function_call,
        confidence=fc.confidence,
    )
    return fc
