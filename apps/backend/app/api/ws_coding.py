from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app import session_bus
from app.db import record_agent_trace, record_coding_solution
from app.logging import log
from app.models.catalog import Provider, parse_effort, resolve_model
from app.prompts.coding_modes import CodingMode
from app.redis_client import store_solution
from app.services.code_runner import run_solution_tests
from app.services.coding_agent import (
    AgentUnavailableError,
    prewarm_agent,
    stream_coding_agent,
)
from app.services.coding_extraction import problem_fingerprint
from app.services.coding_solution import (
    resolved_model,
    should_use_deep,
    stream_coding,
)
from app.services.limits import check_token_budget
from app.services.usage import SUBSCRIPTION_SUFFIX, record_solution_call
from app.settings import settings

router = APIRouter()


@router.websocket("/ws/coding-solution")
async def ws_coding_solution(websocket: WebSocket, session_id: str | None = None) -> None:
    await websocket.accept()
    log.info("ws_coding.connect", session_id=session_id)

    in_flight: asyncio.Task[None] | None = None
    send_lock = asyncio.Lock()

    async def send_json(payload: dict[str, Any]) -> None:
        async with send_lock:
            try:
                await websocket.send_text(json.dumps(payload))
            except Exception as exc:  # noqa: BLE001
                log.warning("ws_coding.send_failed", error=str(exc))

    # Receive cross-endpoint pushes (coding_problem_detected from
    # /api/vision/extract) over this socket. The coding-solution WS is open
    # any time the /session page is mounted, so this channel works whether
    # or not transcription is also running.
    if session_id:
        session_bus.register(session_id, send_json)

    # A session panel just opened — pre-boot a CLI process so a later agent
    # run (button or auto-escalation) skips cold-start latency. No-op when
    # the agent is disabled or a warm slot already exists.
    prewarm_task = asyncio.create_task(prewarm_agent())
    prewarm_task.add_done_callback(lambda t: t.exception())

    async def _run_agent_stream(
        problem: dict[str, Any],
        language: str,
        extra: str | None,
        send_json: Any,
        prior_solution: str | None = None,
        feedback: str | None = None,
        model: str | None = None,
        effort: str | None = None,
    ) -> None:
        """Drive the Claude Code CLI agent for one problem.

        Emits agent_step / agent_tool / agent_tool_result trace events as the
        agent works, an agent_solution with the final formatted answer, then
        persists + self-verifies it exactly like a solve so the panel shows
        ✓/✗ against the examples. Streams no `token` events — the solution
        arrives whole in agent_solution once the loop finishes."""
        fp = _fingerprint(problem)
        await send_json(
            {
                "type": "started",
                "provider": "claude",
                "language": language,
                "model": f"claude-code:{model}" if model else "claude-code",
                "mode": "agent",
            }
        )

        # Full step trace, persisted at the end of the run (any outcome) so
        # "what did the agent actually do?" survives the panel state.
        trace: list[dict[str, Any]] = []
        run_started = time.monotonic()
        run_status = "done"

        async def _save_trace() -> None:
            if not (session_id and trace):
                return
            try:
                await record_agent_trace(
                    session_id=session_id,
                    fingerprint=fp,
                    status=run_status,
                    duration_s=round(time.monotonic() - run_started, 1),
                    trace=trace,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("agent_trace.save_failed", error=str(exc))

        solution_text = ""
        try:
            async for event in stream_coding_agent(
                problem=problem,
                language=language,
                session_id=session_id,
                extra_instructions=extra,
                prior_solution=prior_solution,
                feedback=feedback,
                model=model,
                effort=effort,
            ):
                if event.type == "step":
                    text = event.text.strip()
                    # EARLY ANSWER: the agent emits the full formatted solution
                    # as soon as its examples pass, then keeps hardening.
                    # Despite the prompt, it often prefixes a narration line
                    # ("Both examples pass. Now emitting…"), so look for the
                    # marker anywhere and slice from it rather than demanding
                    # the message start with it.
                    marker = text.find("### 🎯")
                    if marker != -1:
                        # Surface it as a provisional solution so the user
                        # reads it minutes before the final one; the terminal
                        # `result` event overwrites it if improved.
                        solution_text = text[marker:]
                        trace.append(
                            {"kind": "solution", "provisional": True, "text": solution_text}
                        )
                        await send_json(
                            {"type": "agent_solution", "text": solution_text, "provisional": True}
                        )
                    else:
                        trace.append({"kind": "step", "text": event.text})
                        await send_json({"type": "agent_step", "text": event.text})
                elif event.type == "tool":
                    trace.append({"kind": "tool", "tool": event.tool, "summary": event.summary})
                    await send_json(
                        {"type": "agent_tool", "tool": event.tool, "summary": event.summary}
                    )
                elif event.type == "tool_result":
                    trace.append({"kind": "result", "ok": event.ok, "summary": event.summary})
                    await send_json(
                        {"type": "agent_tool_result", "ok": event.ok, "summary": event.summary}
                    )
                elif event.type == "solution":
                    # Same narration-prefix problem as the provisional above
                    # ("Both examples pass. ### 🎯 …") — without the slice the
                    # final message would overwrite the clean provisional with
                    # a messier one.
                    text = event.text
                    marker = text.find("### 🎯")
                    if marker > 0:
                        text = text[marker:]
                    solution_text = text
                    trace.append({"kind": "solution", "text": text})
                    await send_json({"type": "agent_solution", "text": text})
            await send_json({"type": "done"})
        except AgentUnavailableError as exc:
            await send_json({"type": "error", "message": f"agent unavailable — {exc}"})
            return
        except asyncio.CancelledError:
            run_status = "cancelled"
            await _save_trace()
            await send_json({"type": "cancelled"})
            raise
        except Exception as exc:  # noqa: BLE001
            run_status = "error"
            await _save_trace()
            log.error("ws_coding.agent_error", error=str(exc))
            await send_json({"type": "error", "message": str(exc)})
            return
        await _save_trace()

        solution_text = solution_text.strip()
        if not solution_text:
            return

        # Persist + record usage against Claude, mirroring the solve path so
        # agent answers show up in history like any other solution.
        if session_id:
            try:
                await store_solution(session_id, fp, solution_text)
            except Exception as exc:  # noqa: BLE001
                log.warning("ws_coding.store_solution_failed", error=str(exc))
            try:
                row_id = await record_coding_solution(
                    session_id=session_id,
                    fingerprint=fp,
                    problem=problem,
                    language=language,
                    provider="claude",
                    model="claude-code",
                    solution_text=solution_text,
                )
                await send_json({"type": "saved", "id": row_id, "fingerprint": fp})
            except Exception as exc:  # noqa: BLE001
                log.warning("coding_solutions.save_failed", error=str(exc))
            # Usage row for the run. Subscription-billed, so no per-token
            # cost — the row makes agent runs visible in the usage breakdown
            # alongside API calls (model name marks the billing source).
            try:
                await record_solution_call(
                    session_id=session_id,
                    provider="claude",
                    model="claude-code-agent (subscription)",
                    input_tokens=max(1, len(str(problem)) // 4),
                    output_tokens=max(1, len(solution_text) // 4),
                )
            except Exception:  # noqa: BLE001
                pass

        # Independent self-verify of the agent's final answer (the agent
        # verifies internally, but we re-run through the same sandbox as solve
        # so the panel's ✓/✗ is apples-to-apples).
        examples = _reliable_examples(problem)
        try:
            verdict = await run_solution_tests(
                solution_markdown=solution_text,
                examples=examples,
                language=language,
            )
            await send_json(
                {
                    "type": "test_results",
                    "fingerprint": fp,
                    "ran": verdict.ran,
                    "skip_reason": verdict.skip_reason,
                    "cases": [
                        {
                            "ok": c.ok,
                            "input": c.input,
                            "expected": c.expected,
                            "actual": c.actual,
                            "error": c.error,
                        }
                        for c in verdict.cases
                    ],
                }
            )
            log.info(
                "ws_coding.verified",
                mode="agent",
                session_id=session_id,
                ran=verdict.ran,
                passed=verdict.passed,
                total=verdict.total,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("ws_coding.verify_failed", error=str(exc))

    async def run_stream(request: dict[str, Any]) -> None:
        provider: Provider = request.get("provider", "gemini")
        selected_model: str | None = None
        raw_model = request.get("model")
        if raw_model:
            selection = resolve_model(str(raw_model), provider_hint=provider)
            if selection is None:
                await send_json(
                    {
                        "type": "error",
                        "message": f"Can't resolve model {raw_model!r} — use a vendor ID "
                        "(claude-…, gpt-…, gemini-…, deepseek-…) or provider:model",
                    }
                )
                return
            provider = selection.provider
            selected_model = selection.model
        effort = parse_effort(request.get("effort"))
        language = str(request.get("language") or "Python")
        mode: CodingMode = request.get("mode") or "solve"
        problem = request.get("problem") or {}
        code = request.get("code")
        error_text = request.get("error")
        hint = request.get("hint")
        extra = request.get("extra_instructions")
        # Refine-mode inputs — only meaningful when mode == "solve" and the
        # user is re-running an existing tab with feedback ("Case 2 failed,
        # expected 94 got 64"). The prompt flips into refine framing when
        # either is present.
        prior_solution = request.get("prior_solution")
        feedback = request.get("feedback")

        # Pre-flight required-input validation. The service raises on
        # missing fields too but we want a clean per-mode error before any
        # tokens fly. Solve and tests need a problem statement; explain and
        # debug need a code snippet (and debug additionally needs an error).
        if mode in ("solve", "tests", "agent") and not problem.get("problem_statement"):
            await send_json({"type": "error", "message": "problem.problem_statement required"})
            return
        if mode in ("explain", "debug") and not (code and code.strip()):
            await send_json({"type": "error", "message": "code required"})
            return
        if mode == "debug" and not (error_text and error_text.strip()):
            await send_json({"type": "error", "message": "error required"})
            return

        budget = await check_token_budget(session_id)
        if not budget.ok:
            # Log it: without this line a budget-bounced request (e.g. an
            # auto-escalation that never starts) is invisible in the server
            # logs — a field incident cost a debugging session to trace.
            log.warning(
                "ws_coding.limit_exceeded",
                session_id=session_id,
                mode=mode,
                used=budget.used,
                limit=budget.limit,
            )
            await send_json(
                {
                    "type": "limit_exceeded",
                    "kind": "tokens",
                    "message": budget.message,
                    "used": budget.used,
                    "limit": budget.limit,
                }
            )
            return

        # Agent mode is a different animal from the four provider-backed modes:
        # it drives the local `claude` CLI's tool loop instead of a single
        # streamed completion (no provider fallback, no token accounting — it
        # bills against the Claude subscription). Handled in its own path.
        if mode == "agent":
            await _run_agent_stream(
                problem,
                language,
                extra,
                send_json,
                prior_solution=prior_solution,
                feedback=feedback,
                # The agent is Claude-only: a picked Claude model drives it;
                # any other pick leaves it on AGENT_MODEL. Effort applies as-is.
                model=selected_model if provider == "claude" else None,
                effort=effort,
            )
            return

        # Reasoning-tier routing: refines AND hard-difficulty solves use the
        # deep model. Compute it here too so the `started` event + usage
        # logging report the model that will actually run, not the default
        # Flash tier.
        deep = should_use_deep(mode, problem, prior_solution, feedback)
        model = resolved_model(provider, deep=deep, model=selected_model)
        await send_json(
            {
                "type": "started",
                "provider": provider,
                "language": language,
                "model": model,
                "mode": mode,
            }
        )
        # Track the effective provider/model so we credit usage + persist
        # solve-mode rows against whichever provider actually delivered.
        effective_provider: Provider = provider
        effective_model = model

        async def _on_fallback(prev: Provider, nxt: Provider, reason: str) -> None:
            nonlocal effective_provider, effective_model
            effective_provider = nxt
            # Preserve the deep flag across the fallback so the credited
            # model matches the tier the new provider actually used.
            effective_model = resolved_model(nxt, deep=deep)
            await send_json(
                {
                    "type": "provider_changed",
                    "from": prev,
                    "to": nxt,
                    "reason": reason,
                }
            )
            log.info("ws_coding.fallback", session_id=session_id, prev=prev, next=nxt, mode=mode)

        # Provider-reported (input, output) tokens (incl. reasoning) for the
        # attempt that completed. None → the char/4 estimates below.
        reported_usage: tuple[int | None, int | None] = (None, None)

        def _on_usage(input_tokens: int | None, output_tokens: int | None) -> None:
            nonlocal reported_usage
            reported_usage = (input_tokens, output_tokens)

        collected: list[str] = []
        # Rough input-token proxy. Use the largest available input source per
        # mode so the usage estimate isn't wildly off for explain/debug.
        input_blob = (
            problem.get("problem_statement")
            if mode in ("solve", "tests")
            else (code or "") + ("\n" + error_text if mode == "debug" and error_text else "")
        ) or ""
        input_tokens = max(1, len(input_blob) // 4)

        try:
            async for token in stream_coding(
                provider=provider,
                mode=mode,
                problem=problem if mode in ("solve", "tests") else None,
                code=code,
                error=error_text,
                hint=hint,
                language=language,
                extra_instructions=extra,
                prior_solution=prior_solution if mode == "solve" else None,
                feedback=feedback if mode == "solve" else None,
                model=selected_model,
                effort=effort,
                on_fallback=_on_fallback,
                on_usage=_on_usage,
            ):
                collected.append(token)
                await send_json({"type": "token", "text": token})
            await send_json({"type": "done"})
        except asyncio.CancelledError:
            await send_json({"type": "cancelled"})
            raise
        except Exception as exc:  # noqa: BLE001
            log.error("ws_coding.stream_error", error=str(exc), mode=mode)
            await send_json({"type": "error", "message": str(exc)})
            return

        solution_text = "".join(collected).strip()
        # Only `solve` mode persists to the coding_solutions table — the
        # other modes are ephemeral (no fingerprintable problem state, or
        # transient debug context that becomes stale once the candidate
        # moves on).
        if solution_text and session_id and mode == "solve":
            fp = _fingerprint(problem)
            try:
                await store_solution(session_id, fp, solution_text)
            except Exception as exc:  # noqa: BLE001
                log.warning("ws_coding.store_solution_failed", error=str(exc))
            try:
                row_id = await record_coding_solution(
                    session_id=session_id,
                    fingerprint=fp,
                    problem=problem,
                    language=language,
                    provider=effective_provider,
                    model=effective_model,
                    solution_text=solution_text,
                )
                await send_json({"type": "saved", "id": row_id, "fingerprint": fp})
                log.info(
                    "coding_solutions.saved",
                    session_id=session_id,
                    fingerprint=fp,
                    row_id=row_id,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("coding_solutions.save_failed", error=str(exc))

        if session_id:
            output_tokens = reported_usage[1] or max(1, len(solution_text) // 4)
            # Claude without an API key ran on the subscription CLI — not
            # metered per token, so don't price it as if it were the API.
            billed_model = (
                f"{effective_model}{SUBSCRIPTION_SUFFIX}"
                if effective_provider == "claude" and not settings.anthropic_api_key
                else effective_model
            )
            try:
                await record_solution_call(
                    session_id=session_id,
                    provider=effective_provider,
                    model=billed_model,
                    input_tokens=reported_usage[0] or input_tokens,
                    output_tokens=output_tokens,
                )
            except Exception:  # noqa: BLE001
                pass

        # Self-verification — only for solve mode (explain/debug/tests have
        # no problem examples to check against). Runs the streamed solution
        # against the extracted examples in a sandboxed subprocess and emits
        # a test_results event so the panel can show ✓/✗ before the user
        # pastes anything into the real judge. Best-effort: a verification
        # failure never blocks the solution that already streamed fine.
        if solution_text and mode == "solve":
            examples = _reliable_examples(problem)
            try:
                verdict = await run_solution_tests(
                    solution_markdown=solution_text,
                    examples=examples,
                    language=language,
                )
                await send_json(
                    {
                        "type": "test_results",
                        "fingerprint": _fingerprint(problem),
                        "ran": verdict.ran,
                        "skip_reason": verdict.skip_reason,
                        "cases": [
                            {
                                "ok": c.ok,
                                "input": c.input,
                                "expected": c.expected,
                                "actual": c.actual,
                                "error": c.error,
                            }
                            for c in verdict.cases
                        ],
                    }
                )
                log.info(
                    "ws_coding.verified",
                    session_id=session_id,
                    ran=verdict.ran,
                    passed=verdict.passed,
                    total=verdict.total,
                )
            except Exception as exc:  # noqa: BLE001
                log.warning("ws_coding.verify_failed", error=str(exc))

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await send_json({"type": "error", "message": "invalid json"})
                continue
            kind = msg.get("type")
            if kind == "solve":
                if in_flight and not in_flight.done():
                    in_flight.cancel()
                    try:
                        await in_flight
                    except (asyncio.CancelledError, Exception):  # noqa: BLE001
                        pass
                in_flight = asyncio.create_task(run_stream(msg))
            elif kind == "cancel":
                if in_flight and not in_flight.done():
                    in_flight.cancel()
            elif kind == "ping":
                await send_json({"type": "pong"})
    except WebSocketDisconnect:
        log.info("ws_coding.disconnect", session_id=session_id)
    except Exception as exc:  # noqa: BLE001
        log.error("ws_coding.error", session_id=session_id, error=str(exc))
    finally:
        if session_id:
            session_bus.unregister(session_id, send_json)
        if in_flight and not in_flight.done():
            in_flight.cancel()
            try:
                await in_flight
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        log.info("ws_coding.closed", session_id=session_id)


def _reliable_examples(problem: dict[str, Any]) -> list[dict[str, Any]]:
    """Examples safe to execute as test cases. The extractor marks an example
    `unreliable` when it couldn't reconcile the transcription with the
    statement (OCR misread) — running those produces false failures that
    mislead the refine loop and trigger pointless escalations."""
    examples = problem.get("examples") or []
    reliable = [ex for ex in examples if not ex.get("unreliable")]
    if len(reliable) != len(examples):
        log.info(
            "ws_coding.unreliable_examples_skipped",
            skipped=len(examples) - len(reliable),
            total=len(examples),
        )
    return reliable


def _fingerprint(problem: dict[str, Any]) -> str:
    """Stand-in fingerprint helper that accepts raw dicts (ExtractedProblem
    is not reconstructed here because the client is the source of truth)."""
    from app.models.coding import ExtractedProblem

    try:
        # Try to coerce; if it fails (e.g. missing required fields on retry),
        # fall back to a hash of statement+title.
        parsed = ExtractedProblem.model_validate({**problem, "confidence": problem.get("confidence", 1.0)})
        return problem_fingerprint(parsed)
    except Exception:  # noqa: BLE001
        import hashlib

        blob = (problem.get("problem_statement") or "").strip().lower()
        if problem.get("title"):
            blob = str(problem["title"]).strip().lower() + "\n" + blob
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]
