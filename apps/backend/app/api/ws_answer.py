from __future__ import annotations

import asyncio
import json
from typing import Any, Literal

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db import append_qa, get_session
from app.logging import log
from app.prompts.answer_generation import AnswerContext, PriorTurn
from app.redis_client import recent_transcript_text, set_last_answer
from app.services.answer import Provider, claude_answer_model, stream_answer
from app.services.limits import check_token_budget
from app.services.usage import ANSWER_PROMPT_OVERHEAD_TOKENS, record_answer_call
from app.settings import settings

router = APIRouter()

# Window of transcript automatically included as `recent_conversation` if the
# client doesn't pass one explicitly. Roomier than question-detection's 30s so
# the answer can ground in surrounding context.
ANSWER_TRANSCRIPT_WINDOW_S = 60.0


_Role = Literal["user", "assistant"]


def _extract_role_content(msg: Any) -> tuple[_Role | None, str | None]:
    if not isinstance(msg, dict):
        return None, None
    role = msg.get("role")
    content = msg.get("content")
    if role != "user" and role != "assistant":
        return None, None
    if not isinstance(content, str):
        return None, None
    return role, content


def _last_user_index(messages: list[Any]) -> int | None:
    for i in range(len(messages) - 1, -1, -1):
        role, _ = _extract_role_content(messages[i])
        if role == "user":
            return i
    return None


@router.websocket("/ws/answer")
async def ws_answer(websocket: WebSocket, session_id: str | None = None) -> None:
    await websocket.accept()
    log.info("ws_answer.connect", session_id=session_id)

    in_flight: asyncio.Task[None] | None = None
    send_lock = asyncio.Lock()

    async def send_json(payload: dict[str, Any]) -> None:
        async with send_lock:
            try:
                await websocket.send_text(json.dumps(payload))
            except Exception as exc:  # noqa: BLE001
                log.warning("ws_answer.send_failed", error=str(exc))

    async def run_stream(request: dict[str, Any]) -> None:
        provider: Provider = request.get("provider", "gemini")
        thread_id = request.get("thread_id") or None

        # Accept either the new threaded payload (messages: [...]) or the
        # legacy one-shot {question: "..."} shape. New shape wins when both
        # are present.
        raw_messages = request.get("messages")
        if isinstance(raw_messages, list) and raw_messages:
            # Split the thread into prior turns + current question. The
            # current question is the last user turn; everything before it
            # is history. Trailing assistant turns (in-flight from a prior
            # cancel) are dropped — we only want completed turns as context.
            tail_idx = _last_user_index(raw_messages)
            if tail_idx is None:
                await send_json({"type": "error", "message": "no user turn in thread"})
                return
            question = str(raw_messages[tail_idx].get("content") or "").strip()
            prior_turns = tuple(
                PriorTurn(role=role, content=content)
                for msg in raw_messages[:tail_idx]
                for role, content in [_extract_role_content(msg)]
                if role and content
            )
        else:
            question = str(request.get("question") or "").strip()
            prior_turns = ()

        if not question:
            await send_json({"type": "error", "message": "empty question"})
            return

        # Pre-flight budget check.
        budget = await check_token_budget(session_id)
        if not budget.ok:
            # Mirror of ws_coding: budget bounces must be visible in logs.
            log.warning(
                "ws_answer.limit_exceeded",
                session_id=session_id,
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

        override = request.get("session_context") or {}
        persisted: dict[str, Any] = {}
        if session_id:
            persisted = await get_session(session_id) or {}

        recent_transcript = override.get("recent_transcript")
        if not recent_transcript and session_id:
            try:
                recent_transcript = await recent_transcript_text(
                    session_id, ANSWER_TRANSCRIPT_WINDOW_S
                )
            except Exception:  # noqa: BLE001
                recent_transcript = None

        context = AnswerContext(
            resume_text=override.get("resume_text") or persisted.get("resume_text"),
            extra_instructions=(
                override.get("extra_instructions") or persisted.get("extra_instructions")
            ),
            job_title=override.get("job_title") or persisted.get("job_title"),
            company=override.get("company") or persisted.get("company"),
            language=override.get("language") or persisted.get("language") or "en",
            recent_transcript=recent_transcript,
            prior_turns=prior_turns,
        )

        auto_detected = bool(request.get("auto_detected", False))
        if provider == "gemini":
            model = settings.gemini_model
        elif provider == "deepseek":
            model = settings.deepseek_model
        elif provider == "claude":
            model = claude_answer_model()
        else:
            model = settings.openai_model

        await send_json(
            {
                "type": "started",
                "question": question,
                "provider": provider,
                "thread_id": thread_id,
            }
        )
        # Track the effective provider — we report cost / usage against
        # whichever one actually produced tokens, not the user's original
        # selection. Mutated by the on_fallback hook below.
        effective_provider: Provider = provider
        effective_model = model

        async def _on_fallback(prev: Provider, nxt: Provider, reason: str) -> None:
            nonlocal effective_provider, effective_model
            effective_provider = nxt
            if nxt == "gemini":
                effective_model = settings.gemini_model
            elif nxt == "deepseek":
                effective_model = settings.deepseek_model
            elif nxt == "claude":
                effective_model = claude_answer_model()
            else:
                effective_model = settings.openai_model
            await send_json(
                {
                    "type": "provider_changed",
                    "from": prev,
                    "to": nxt,
                    "reason": reason,
                }
            )
            log.info("answer.fallback", session_id=session_id, prev=prev, next=nxt)

        collected: list[str] = []
        try:
            async for token in stream_answer(
                provider, question, context, on_fallback=_on_fallback
            ):
                collected.append(token)
                await send_json({"type": "token", "text": token})
            await send_json({"type": "done"})
        except asyncio.CancelledError:
            await send_json({"type": "cancelled"})
            raise
        except Exception as exc:  # noqa: BLE001
            log.error("ws_answer.stream_error", error=str(exc))
            await send_json({"type": "error", "message": str(exc)})
            return

        answer_text = "".join(collected).strip()
        if answer_text and session_id:
            try:
                row_id = await append_qa(
                    session_id=session_id,
                    question=question,
                    answer=answer_text,
                    provider=effective_provider,
                    model=effective_model,
                    auto_detected=auto_detected,
                    thread_id=thread_id,
                )
                await send_json({"type": "saved", "id": row_id, "thread_id": thread_id})
            except Exception as exc:  # noqa: BLE001
                log.warning("ws_answer.save_failed", error=str(exc))
            # Cache the latest Q+A so the follow-up classifier gets real
            # answer context, not just the prior question. Best-effort —
            # Redis-down is fine; classifier degrades gracefully to
            # question-only context.
            try:
                await set_last_answer(session_id, question, answer_text)
            except Exception as exc:  # noqa: BLE001
                log.warning("ws_answer.qa_cache_failed", error=str(exc))

            # Record answer-stream usage so the cost pill reflects copilot
            # spend (previously uncounted entirely). Token counts are a
            # rough char/4 proxy: input = system-prompt overhead + question
            # + recent transcript + prior thread turns; output = answer.
            try:
                prior_chars = sum(len(t.content) for t in prior_turns)
                transcript_chars = len(context.recent_transcript or "")
                input_tokens = (
                    ANSWER_PROMPT_OVERHEAD_TOKENS
                    + (len(question) + transcript_chars + prior_chars) // 4
                )
                output_tokens = max(1, len(answer_text) // 4)
                await record_answer_call(
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
                message = json.loads(raw)
            except json.JSONDecodeError:
                await send_json({"type": "error", "message": "invalid json"})
                continue
            kind = message.get("type")
            if kind == "question":
                # Cancel any in-flight stream before starting a new one.
                if in_flight and not in_flight.done():
                    in_flight.cancel()
                    try:
                        await in_flight
                    except (asyncio.CancelledError, Exception):  # noqa: BLE001
                        pass
                in_flight = asyncio.create_task(run_stream(message))
            elif kind == "cancel":
                if in_flight and not in_flight.done():
                    in_flight.cancel()
            elif kind == "ping":
                await send_json({"type": "pong"})
    except WebSocketDisconnect:
        log.info("ws_answer.disconnect", session_id=session_id)
    except Exception as exc:  # noqa: BLE001
        log.error("ws_answer.error", session_id=session_id, error=str(exc))
    finally:
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
        log.info("ws_answer.closed", session_id=session_id)
