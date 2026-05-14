from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app import session_bus
from app.db import record_coding_solution
from app.logging import log
from app.prompts.coding_modes import CodingMode
from app.redis_client import store_solution
from app.services.coding_extraction import problem_fingerprint
from app.services.coding_solution import Provider, resolved_model, stream_coding
from app.services.limits import check_token_budget
from app.services.usage import record_solution_call

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

    async def run_stream(request: dict[str, Any]) -> None:
        provider: Provider = request.get("provider", "gemini")
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
        if mode in ("solve", "tests") and not problem.get("problem_statement"):
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

        model = resolved_model(provider)
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
            effective_model = resolved_model(nxt)
            await send_json(
                {
                    "type": "provider_changed",
                    "from": prev,
                    "to": nxt,
                    "reason": reason,
                }
            )
            log.info("ws_coding.fallback", session_id=session_id, prev=prev, next=nxt, mode=mode)

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
                on_fallback=_on_fallback,
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
            output_tokens = max(1, len(solution_text) // 4)
            try:
                await record_solution_call(
                    session_id=session_id,
                    provider=effective_provider,
                    model=effective_model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                )
            except Exception:  # noqa: BLE001
                pass

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
