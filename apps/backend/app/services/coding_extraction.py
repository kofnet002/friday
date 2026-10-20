from __future__ import annotations

import base64
import hashlib
import json
import time
import re
from typing import Any, Literal, cast

from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI
from pydantic import BaseModel, ValidationError

from app.db import get_session
from app.logging import log
from app.models.catalog import resolve_model
from app.models.coding import ExtractedProblem
from app.models.params import openai_options
from app.prompts.coding_extraction import (
    CODING_EXTRACTION_SYSTEM_PROMPT,
    EXTRACTION_MAX_OUTPUT_TOKENS,
    EXTRACTION_TEMPERATURE,
)
from app.redis_client import get_redis
from app.services.usage import record_vision_call
from app.settings import settings

Provider = Literal["gemini", "openai", "deepseek", "claude"]

VISION_DEDUP_TTL_S = 60


def _claude_vision_available() -> bool:
    """Claude vision runs through the subscription CLI (or the API key if one
    is set). Only route to it when a credential exists — otherwise a 'claude'
    selection should fall back to gemini rather than hard-fail."""
    return bool(settings.claude_code_oauth_token or settings.anthropic_api_key)


def image_content_hash(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()


# ─── Post-detection cooldown ─────────────────────────────────────────────────
# Once we've LOCKED ONTO a coding problem, vision keeps re-running on every
# frame while that problem sits on screen (a cursor blink / caret move / typing
# busts the exact-hash cache), re-OCR-ing the same problem every few seconds —
# expensive, especially on the Claude subscription. So after a confident
# detection we arm a short per-session cooldown: subsequent (non-force) frames
# return the already-detected problem WITHOUT calling the model until it
# expires. Deliberately armed ONLY on a successful coding-problem detection, so
# a problem APPEARING on a previously-idle screen is still caught on the first
# frame (idle frames never arm the cooldown). Perceptual image hashing was
# tried first but coding screenshots are ~90% whitespace — different problems
# hash near-identically, risking a new problem being silently deduped away.


def _cooldown_key(session_id: str) -> str:
    return f"session:{session_id}:vision_cooldown"


async def cooldown_problem(session_id: str) -> ExtractedProblem | None:
    """The problem we most recently locked onto, if its cooldown is still
    active. While present, the caller serves it instead of re-running the
    model. None once the TTL lapses (then the next frame re-extracts)."""
    client = await get_redis()
    if client is None:
        return None
    raw: str | None = await client.get(_cooldown_key(session_id))
    if not raw:
        return None
    try:
        return ExtractedProblem.model_validate(json.loads(raw))
    except (json.JSONDecodeError, ValidationError):
        return None


async def arm_cooldown(session_id: str, problem: ExtractedProblem) -> None:
    """Start the re-scan cooldown after a confident detection. TTL =
    settings.vision_cooldown_s."""
    client = await get_redis()
    if client is None:
        return
    await cast(
        Any,
        client.set(
            _cooldown_key(session_id),
            problem.model_dump_json(),
            ex=settings.vision_cooldown_s,
        ),
    )


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
    blob = (problem.problem_statement or problem.question or "").strip().lower()
    if problem.title:
        blob = problem.title.strip().lower() + "\n" + blob
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


async def _resolve_provider(session_id: str, override: str | None) -> Provider:
    """Honor an explicit override; otherwise fall back to the session's
    saved default_provider; otherwise gemini."""
    valid = ("gemini", "openai", "deepseek", "claude")
    # A configured VISION_PROVIDER pins the OCR step regardless of the coding
    # panel's selection — run vision on a fast/reliable model (e.g. gpt-4o)
    # while solves use the selected provider (e.g. the Claude subscription).
    if settings.vision_provider in valid:
        return cast(Provider, settings.vision_provider)
    if override in valid:
        return cast(Provider, override)
    sess = await get_session(session_id) or {}
    candidate = sess.get("default_provider")
    if candidate in valid:
        return cast(Provider, candidate)
    return "gemini"


async def _selected_vision_model(session_id: str, provider: Provider) -> str | None:
    """The session's picked model, if it belongs to the provider running
    vision. None → that provider's env-configured vision model. A pinned
    VISION_PROVIDER means "run OCR on the configured model", so the coding
    selection is ignored then."""
    if settings.vision_provider:
        return None
    sess = await get_session(session_id) or {}
    raw = sess.get("default_model")
    if not isinstance(raw, str) or not raw:
        return None
    selection = resolve_model(raw, provider_hint=None)
    if selection is None or selection.provider != provider:
        return None
    return selection.model


def _vision_chain(
    chosen: Provider, selected_model: str | None
) -> list[tuple[Provider, str | None]]:
    """(provider, model) attempts in order; model None = env default. The
    picked model goes first, then the same provider's default (the pick may
    lack image input, e.g. a text-only model), then the other providers."""
    chain: list[tuple[Provider, str | None]] = []
    if selected_model:
        chain.append((chosen, selected_model))
    chain.append((chosen, None))
    others: list[tuple[Provider, bool]] = [
        ("openai", bool(settings.openai_api_key)),
        ("gemini", bool(settings.gemini_api_key)),
        ("claude", _claude_vision_available()),
    ]
    chain.extend((prov, None) for prov, ok in others if ok and prov != chosen)
    return chain


async def extract_problem(
    image_base64: str,
    session_id: str,
    provider: str | None = None,
) -> ExtractedProblem:
    """Run vision extraction using the user-selected provider. DeepSeek has
    no native vision model so it transparently falls back to Gemini (logged)."""
    # Allow data-URI prefix ("data:image/jpeg;base64,…") as well as raw base64.
    payload = image_base64.split(",", 1)[1] if image_base64.startswith("data:") else image_base64
    image_bytes = base64.b64decode(payload)

    chosen = await _resolve_provider(session_id, provider)
    if chosen == "deepseek":
        log.info("extraction.fallback", reason="deepseek_no_vision", session_id=session_id)
        chosen = "gemini"
    if chosen == "claude" and not _claude_vision_available():
        log.info("extraction.fallback", reason="claude_no_credential", session_id=session_id)
        chosen = "gemini"

    # Fallback chain — same idea as the solve path's stream_with_fallback. A
    # transient provider failure (timeout, 429, 503) shouldn't lose the
    # detection: fall through to the other vision-capable providers instead of
    # 502-ing the frame. Claude (subscription CLI) is last — slowest, but a
    # working OCR beats none when the API providers are down.
    chain = _vision_chain(chosen, await _selected_vision_model(session_id, chosen))

    t0 = time.time()
    problem = None
    output_tokens: int | None = None
    model_used = ""
    last_exc: Exception | None = None
    for attempt, (prov, model) in enumerate(chain):
        if attempt:
            log.info(
                "extraction.fallback",
                reason="provider_failed",
                prev=chain[attempt - 1][0],
                next=prov,
                model=model,
                session_id=session_id,
            )
        try:
            if prov == "claude":
                problem, output_tokens, model_used = await _extract_claude(
                    image_bytes, session_id, model=model
                )
            elif prov == "openai":
                problem, output_tokens, model_used = await _extract_openai(
                    image_bytes, model=model
                )
            else:
                problem, output_tokens, model_used = await _extract_gemini(
                    image_bytes, model=model
                )
            chosen = prov
            break
        except Exception as exc:  # try the next provider
            last_exc = exc
            log.warning(
                "extraction.provider_failed",
                provider=prov,
                error=str(exc)[:200],
                session_id=session_id,
            )
    if problem is None:
        raise last_exc if last_exc is not None else RuntimeError("no vision provider available")
    elapsed_ms = int((time.time() - t0) * 1000)

    await record_vision_call(
        session_id=session_id,
        provider=chosen,
        model=model_used,
        output_tokens=output_tokens,
    )

    log.info(
        "extraction.done",
        session_id=session_id,
        provider=chosen,
        model=model_used,
        elapsed_ms=elapsed_ms,
        is_coding_problem=problem.is_coding_problem,
        confidence=problem.confidence,
    )
    return problem


def _parse_extraction_json(text: str) -> ExtractedProblem:
    text = _strip_json_fence(text)
    if not text:
        raise RuntimeError("empty extraction response")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        # Some OpenAI vision responses contain JavaScript-style object keys or
        # trailing commas despite the JSON-only instruction. Repair only the
        # narrow, unambiguous cases before rejecting the response.
        repaired = re.sub(r",\s*([}\]])", r"\1", text)
        repaired = re.sub(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', repaired)
        try:
            data = json.loads(repaired)
        except json.JSONDecodeError as exc:
            log.warning("extraction.bad_json", raw=text[:300])
            raise RuntimeError(f"extraction JSON parse failed: {exc}") from exc
    try:
        return ExtractedProblem.model_validate(data)
    except ValidationError as exc:
        log.warning("extraction.validation_error", error=str(exc), raw=text[:300])
        raise RuntimeError(f"extraction schema invalid: {exc}") from exc


async def _extract_gemini(
    image_bytes: bytes, *, model: str | None = None
) -> tuple[ExtractedProblem, int | None, str]:
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    model = model or settings.vision_extraction_model
    response = await client.aio.models.generate_content(
        model=model,
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
    problem = _parse_extraction_json(response.text or "")
    usage = getattr(response, "usage_metadata", None)
    output_tokens = int(getattr(usage, "candidates_token_count", 0) or 0) if usage else None
    return problem, output_tokens, model


def _strip_json_fence(text: str) -> str:
    """Claude Code sometimes wraps JSON in a ```json fence or adds a stray
    sentence. Pull out the JSON object so _parse_extraction_json sees clean
    input. Falls back to the original text when no braces are found."""
    text = (text or "").strip()
    if text.startswith("```"):
        # Drop the opening fence line (```/```json) and any closing fence.
        body = text.split("\n", 1)[1] if "\n" in text else ""
        text = body.rsplit("```", 1)[0].strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]
    return text


async def _extract_claude(
    image_bytes: bytes, session_id: str, *, model: str | None = None
) -> tuple[ExtractedProblem, int | None, str]:
    """Vision extraction via the Claude subscription CLI (no API key needed).
    Claude Code reads the screenshot and returns the extraction JSON."""
    from app.services.claude_cli import run_claude_cli_vision

    model = model or settings.claude_vision_model
    raw = await run_claude_cli_vision(
        image_bytes=image_bytes,
        system=CODING_EXTRACTION_SYSTEM_PROMPT,
        prompt=(
            "Extract the coding problem shown in the screenshot. Reply with ONLY"
            " a single JSON object matching the schema — no markdown fences, no"
            " commentary."
        ),
        model=model,
        session_id=session_id,
    )
    problem = _parse_extraction_json(_strip_json_fence(raw))
    # Token usage isn't reported by the CLI path (subscription, not metered).
    return problem, None, f"claude-code:{model}"


# Constraint-free mirror of ExtractedProblem for OpenAI STRICT structured
# outputs (strict schemas reject numeric minimum/maximum, so `confidence`
# can't carry its ge/le Field constraints here). Parsed output is re-validated
# through the real model, which applies the constraints + normalizers.
class _StrictExample(BaseModel):
    input: str
    output: str
    explanation: str | None
    unreliable: bool


class _StrictExtraction(BaseModel):
    is_coding_problem: bool
    is_screen_question: bool
    question: str | None
    platform: str | None
    title: str | None
    difficulty: str | None
    problem_statement: str | None
    examples: list[_StrictExample] | None
    constraints: list[str] | None
    function_signature: str | None
    language_hint: str | None
    confidence: float


async def _extract_openai(
    image_bytes: bytes, *, model: str | None = None
) -> tuple[ExtractedProblem, int | None, str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    # Fail fast: default SDK timeout is 10min with retries — a network blip
    # would stall the frame for ages. 20s + 1 retry, then the fallback chain
    # takes over.
    client = AsyncOpenAI(api_key=settings.openai_api_key, timeout=20.0, max_retries=1)
    model = model or settings.openai_model  # must accept image input
    # Token-limit key + temperature vary by model family (gpt-5 / o-series).
    limits = openai_options(
        model,
        effort=None,
        max_tokens=EXTRACTION_MAX_OUTPUT_TOKENS,
        temperature=EXTRACTION_TEMPERATURE,
    )
    image_b64 = base64.b64encode(image_bytes).decode("ascii")
    image_url = f"data:image/jpeg;base64,{image_b64}"
    messages: list[Any] = [
        {"role": "system", "content": CODING_EXTRACTION_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": "Extract either the coding problem or the readable general question from this screenshot as strict JSON matching the schema.",
                },
                {"type": "image_url", "image_url": {"url": image_url}},
            ],
        },
    ]
    # STRICT structured outputs: the API guarantees schema-valid JSON, which
    # eliminates the "Unterminated string" / free-form-JSON parse failures.
    # Falls back to json_object mode if this model/deployment rejects strict
    # schemas, so a schema quirk can't take OpenAI vision down entirely.
    try:
        parsed_response = await client.beta.chat.completions.parse(
            model=model, messages=messages, response_format=_StrictExtraction, **limits
        )
        message = parsed_response.choices[0].message
        if message.refusal:
            raise RuntimeError(f"openai vision refusal: {message.refusal[:200]}")
        if message.parsed is None:
            raise RuntimeError("openai vision returned no parsed content")
        problem = ExtractedProblem.model_validate(message.parsed.model_dump())
        usage = parsed_response.usage
        return problem, usage.completion_tokens if usage else None, model
    except (ValidationError, RuntimeError):
        raise
    except Exception as exc:  # schema rejected / SDK gap — legacy JSON mode
        log.warning("extraction.strict_schema_fallback", error=str(exc)[:200])

    response = await client.chat.completions.create(
        model=model, messages=messages, response_format={"type": "json_object"}, **limits
    )
    if not response.choices:
        raise RuntimeError("empty openai vision response")
    text = response.choices[0].message.content or ""
    problem = _parse_extraction_json(text)
    output_tokens = response.usage.completion_tokens if response.usage else None
    return problem, output_tokens, model
