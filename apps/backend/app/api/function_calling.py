"""REST endpoints for function-calling assessments.

`POST /api/function-call/solve` — the full pipeline: an LLM picks the tool and
builds the payload, then the answer is self-verified against the catalog (and
graded against the answer key when one is supplied). Mirrors the coding panel's
solve → self-verify flow, but for tool selection instead of code.

`POST /api/function-call/check` — verify-only: grade a client-supplied
`{tool, arguments}` with no model call. Cheap, deterministic, and lets the
desktop re-check a hand-edited answer.
"""

from __future__ import annotations

from typing import Any, Literal, cast

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.logging import log
from app.models.function_calling import FunctionCallAssessment, PredictedToolCall, ToolSpec
from app.services.function_calling import normalize_tools, solve_tool_call
from app.services.limits import check_token_budget
from app.services.tool_call_runner import (
    ToolCallCheck,
    check_tool_call,
    grade_tool_call,
)
from app.services.usage import record_solution_call

router = APIRouter(prefix="/api/function-call")

Provider = Literal["gemini", "openai", "deepseek", "claude"]


class SolveRequest(FunctionCallAssessment):
    provider: Provider = "gemini"
    session_id: str | None = None


class CheckRequest(BaseModel):
    prediction: PredictedToolCall
    tools: list[ToolSpec] = Field(min_length=1)
    expected_tool: str | None = None
    expected_arguments: dict[str, Any] | None = None


def _check_payload(check: ToolCallCheck) -> dict[str, Any]:
    return {
        "ran": check.ran,
        "ok": check.ok,
        "skip_reason": check.skip_reason,
        "checks": [
            {"ok": c.ok, "kind": c.kind, "detail": c.detail, "field": c.field}
            for c in check.checks
        ],
    }


def _grade_and_check(
    *,
    tool: str | None,
    arguments: dict[str, Any],
    tools: list[dict[str, Any]],
    expected_tool: str | None,
    expected_arguments: dict[str, Any] | None,
) -> dict[str, Any]:
    """Structural self-verify + optional answer-key grade, as a JSON blob."""
    check = check_tool_call(tool=tool, arguments=arguments, tools=tools)
    result: dict[str, Any] = {"check": _check_payload(check)}
    if expected_tool is not None:
        grade = grade_tool_call(
            tool=tool,
            arguments=arguments,
            expected_tool=expected_tool,
            expected_arguments=expected_arguments,
        )
        result["grade"] = {
            "correct": grade.correct,
            "tool_match": grade.tool_match,
            "payload_match": grade.payload_match,
            "expected_tool": grade.expected_tool,
            "predicted_tool": grade.predicted_tool,
            "payload_diff": grade.payload_diff,
        }
    return result


@router.post("/solve")
async def solve(request: SolveRequest) -> dict[str, Any]:
    tools = normalize_tools([t.model_dump() for t in request.tools])

    if request.session_id:
        budget = await check_token_budget(request.session_id)
        if not budget.ok:
            log.warning(
                "function_call.limit_exceeded",
                session_id=request.session_id,
                used=budget.used,
                limit=budget.limit,
            )
            raise HTTPException(
                status_code=429,
                detail={
                    "kind": "tokens",
                    "message": budget.message,
                    "used": budget.used,
                    "limit": budget.limit,
                },
            )

    try:
        predicted, model = await solve_tool_call(
            question=request.question,
            tools=tools,
            provider=request.provider,
            extra_instructions=request.extra_instructions,
        )
    except Exception as exc:  # noqa: BLE001
        log.error("function_call.solve_error", error=str(exc)[:300])
        raise HTTPException(status_code=502, detail=f"solve failed: {exc}") from exc

    tool = cast("str | None", predicted.get("tool"))
    arguments = cast("dict[str, Any]", predicted.get("arguments") or {})

    verdict = _grade_and_check(
        tool=tool,
        arguments=arguments,
        tools=tools,
        expected_tool=request.expected_tool,
        expected_arguments=request.expected_arguments,
    )

    if request.session_id:
        # Subscription-billed for the CLI path; still record so the run shows
        # up in usage. Rough token proxy from the prompt + answer sizes.
        try:
            await record_solution_call(
                session_id=request.session_id,
                provider=request.provider,
                model=model,
                input_tokens=max(1, (len(request.question) + len(str(tools))) // 4),
                output_tokens=max(1, len(str(predicted)) // 4),
            )
        except Exception:  # noqa: BLE001
            pass

    log.info(
        "function_call.solved",
        provider=request.provider,
        model=model,
        tool=tool,
        check_ok=verdict["check"]["ok"],
        graded=("grade" in verdict),
    )
    return {"prediction": {"tool": tool, "arguments": arguments}, "model": model, **verdict}


@router.post("/check")
async def check(request: CheckRequest) -> dict[str, Any]:
    tools = normalize_tools([t.model_dump() for t in request.tools])
    return _grade_and_check(
        tool=request.prediction.tool,
        arguments=request.prediction.arguments,
        tools=tools,
        expected_tool=request.expected_tool,
        expected_arguments=request.expected_arguments,
    )
