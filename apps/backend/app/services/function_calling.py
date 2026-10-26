"""Solve a function-calling assessment: pick the tool + build the payload.

Non-streaming structured-JSON call across the same providers as the coding
pipeline, with the same fallback idea as `coding_extraction.extract_problem` —
a transient failure on one provider falls through to the next rather than
failing the question. The result is a `{tool, arguments}` dict, ready to hand
to `tool_call_runner` for self-verify or grading.
"""

from __future__ import annotations

import json
from typing import Any, Literal

from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI

from app.logging import log
from app.prompts.coding_solution import (
    SOLUTION_DEEPSEEK_MODEL,
    SOLUTION_GEMINI_MODEL,
    SOLUTION_OPENAI_MODEL,
)
from app.prompts.function_calling import (
    FUNCTION_CALLING_MAX_OUTPUT_TOKENS,
    FUNCTION_CALLING_SYSTEM_PROMPT,
    FUNCTION_CALLING_TEMPERATURE,
    function_calling_user_prompt,
)
from app.services.claude_agent_auth import claude_available
from app.services.claude_api import claude_transport, complete_claude_api
from app.settings import settings

Provider = Literal["gemini", "openai", "deepseek", "claude"]

# The two keys we accept back from the model. Anything else is dropped so a
# chatty model can't smuggle extra fields past the verifier.
_TOOL_KEY = "tool"
_ARGS_KEY = "arguments"


def _claude_available() -> bool:
    return claude_available()


def _coerce(raw: str, *, model: str) -> dict[str, Any]:
    """Parse the model's JSON reply into a normalized `{tool, arguments}` dict.
    Tolerates a ```json fence / stray prose the way the extraction path does."""
    text = (raw or "").strip()
    if text.startswith("```"):
        body = text.split("\n", 1)[1] if "\n" in text else ""
        text = body.rsplit("```", 1)[0].strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start : end + 1]
    if not text:
        raise RuntimeError("empty function-calling response")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        log.warning("function_calling.bad_json", model=model, raw=text[:300])
        raise RuntimeError(f"function-calling JSON parse failed: {exc}") from exc
    if not isinstance(data, dict):
        raise RuntimeError("function-calling response was not a JSON object")
    tool = data.get(_TOOL_KEY)
    args = data.get(_ARGS_KEY)
    return {
        _TOOL_KEY: tool if isinstance(tool, str) and tool.strip() else None,
        _ARGS_KEY: args if isinstance(args, dict) else {},
    }


async def _solve_gemini(system: str, user: str) -> tuple[dict[str, Any], str]:
    if not settings.gemini_api_key:
        raise RuntimeError("GEMINI_API_KEY is not set")
    client = genai.Client(api_key=settings.gemini_api_key)
    model = SOLUTION_GEMINI_MODEL
    response = await client.aio.models.generate_content(
        model=model,
        contents=user,
        config=genai_types.GenerateContentConfig(
            system_instruction=system,
            temperature=FUNCTION_CALLING_TEMPERATURE,
            max_output_tokens=FUNCTION_CALLING_MAX_OUTPUT_TOKENS,
            response_mime_type="application/json",
            # Deterministic single-answer task — no thinking budget needed, and
            # thinking tokens would eat the small output budget.
            thinking_config=genai_types.ThinkingConfig(thinking_budget=0),
        ),
    )
    return _coerce(response.text or "", model=model), model


async def _solve_openai_compat(
    system: str, user: str, *, api_key: str, base_url: str | None, model: str
) -> tuple[dict[str, Any], str]:
    client = AsyncOpenAI(api_key=api_key, base_url=base_url, timeout=30.0, max_retries=1)
    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        temperature=FUNCTION_CALLING_TEMPERATURE,
        max_tokens=FUNCTION_CALLING_MAX_OUTPUT_TOKENS,
        response_format={"type": "json_object"},
    )
    if not response.choices:
        raise RuntimeError("empty response")
    return _coerce(response.choices[0].message.content or "", model=model), model


async def _solve_openai(system: str, user: str) -> tuple[dict[str, Any], str]:
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not set")
    return await _solve_openai_compat(
        system, user, api_key=settings.openai_api_key, base_url=None, model=SOLUTION_OPENAI_MODEL
    )


async def _solve_deepseek(system: str, user: str) -> tuple[dict[str, Any], str]:
    if not settings.deepseek_api_key:
        raise RuntimeError("DEEPSEEK_API_KEY is not set")
    return await _solve_openai_compat(
        system,
        user,
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
        model=SOLUTION_DEEPSEEK_MODEL,
    )


async def _solve_claude(system: str, user: str) -> tuple[dict[str, Any], str]:
    """Single-shot text reply parsed as `{tool, arguments}` — via the API or
    the subscription CLI, per CLAUDE_TRANSPORT. No native tool use: the prompt
    asks for the JSON object directly, same as the other providers."""
    from app.prompts.coding_solution import SOLUTION_ANTHROPIC_MODEL

    model = SOLUTION_ANTHROPIC_MODEL
    transport = claude_transport()
    if transport is None:
        raise RuntimeError("no Claude credential")
    if transport == "api":
        text, _, _ = await complete_claude_api(
            system=system,
            user=user,
            model=model,
            max_tokens=FUNCTION_CALLING_MAX_OUTPUT_TOKENS,
            effort=settings.anthropic_solve_effort,
        )
        return _coerce(text, model=model), model

    from app.services.claude_cli import stream_claude_cli_text

    chunks: list[str] = []
    async for text in stream_claude_cli_text(prompt=user, system=system, model=model):
        if text:
            chunks.append(text)
    return _coerce("".join(chunks), model=f"claude-code:{model}"), f"claude-code:{model}"


def _provider_chain(primary: Provider) -> list[Provider]:
    """Ordered, credential-filtered provider chain — primary first, the rest as
    fallbacks. DeepSeek stays only if it has a key; Claude only with a
    credential. Empty-catalog guard lives in the route, not here."""
    rest: list[Provider] = ["gemini", "openai", "deepseek", "claude"]
    order: list[Provider] = [primary] + [p for p in rest if p != primary]
    chain: list[Provider] = []
    for p in order:
        if p == "gemini" and settings.gemini_api_key:
            chain.append(p)
        elif p == "openai" and settings.openai_api_key:
            chain.append(p)
        elif p == "deepseek" and settings.deepseek_api_key:
            chain.append(p)
        elif p == "claude" and _claude_available():
            chain.append(p)
    return chain or ["gemini"]


async def solve_tool_call(
    *,
    question: str,
    tools: list[dict[str, Any]],
    provider: Provider = "gemini",
    extra_instructions: str | None = None,
) -> tuple[dict[str, Any], str]:
    """Return `({tool, arguments}, model_used)` for the assessment question.

    Walks the provider fallback chain; the first provider to return a parseable
    `{tool, arguments}` wins. Raises the last error only if every provider
    failed."""
    system = FUNCTION_CALLING_SYSTEM_PROMPT
    user = function_calling_user_prompt(question, tools, extra_instructions=extra_instructions)

    chain = _provider_chain(provider)
    last_exc: Exception | None = None
    for attempt, prov in enumerate(chain):
        if attempt:
            log.info("function_calling.fallback", prev=chain[attempt - 1], next=prov)
        try:
            if prov == "gemini":
                return await _solve_gemini(system, user)
            if prov == "openai":
                return await _solve_openai(system, user)
            if prov == "deepseek":
                return await _solve_deepseek(system, user)
            return await _solve_claude(system, user)
        except Exception as exc:  # try the next provider
            last_exc = exc
            log.warning("function_calling.provider_failed", provider=prov, error=str(exc)[:200])
    raise last_exc if last_exc is not None else RuntimeError("no provider available")


def normalize_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Strip catalog entries down to what the prompt + verifier read, so a
    caller can pass ToolSpec.model_dump() (which includes null fields) without
    polluting the prompt. Keeps name/description and whichever schema key is
    populated."""
    out: list[dict[str, Any]] = []
    for t in tools:
        entry: dict[str, Any] = {"name": t.get("name")}
        if t.get("description"):
            entry["description"] = t["description"]
        if isinstance(t.get("parameters"), dict):
            entry["parameters"] = t["parameters"]
        elif isinstance(t.get("input_schema"), dict):
            entry["input_schema"] = t["input_schema"]
        out.append(entry)
    return out
