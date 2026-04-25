from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db import append_qa, get_session
from app.logging import log
from app.prompts.answer_generation import AnswerContext
from app.redis_client import recent_transcript_text
from app.services.answer import Provider, stream_answer
from app.settings import settings

router = APIRouter()

# Window of transcript automatically included as `recent_conversation` if the
# client doesn't pass one explicitly. Roomier than question-detection's 30s so
# the answer can ground in surrounding context.
ANSWER_TRANSCRIPT_WINDOW_S = 60.0


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
        question = str(request.get("question") or "").strip()
        if not question:
            await send_json({"type": "error", "message": "empty question"})
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
        )

        auto_detected = bool(request.get("auto_detected", False))
        model = (
            settings.gemini_model if provider == "gemini" else settings.openai_model
        )

        await send_json({"type": "started", "question": question, "provider": provider})
        collected: list[str] = []
        try:
            async for token in stream_answer(provider, question, context):
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
                    provider=provider,
                    model=model,
                    auto_detected=auto_detected,
                )
                await send_json({"type": "saved", "id": row_id})
            except Exception as exc:  # noqa: BLE001
                log.warning("ws_answer.save_failed", error=str(exc))

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
