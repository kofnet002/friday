from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.logging import log
from app.providers.deepgram import DeepgramSession
from app.redis_client import append_transcript
from app.services.limits import add_audio_seconds, check_audio_budget
from app.services.question_detection import QuestionDetector

# Each PCM frame from the desktop helper is 100ms long (16 kHz × 0.1s × 2 bytes).
AUDIO_FRAME_SECONDS = 0.1
# Flush audio-second counter to Redis every N frames to reduce write traffic.
AUDIO_TRACK_FLUSH_EVERY = 10

router = APIRouter()


@router.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket, session_id: str | None = None) -> None:
    await websocket.accept()
    # Accept a client-supplied session_id (from /setup flow); otherwise mint one.
    effective_session_id = session_id or str(uuid.uuid4())
    paused = False

    await websocket.send_text(
        json.dumps({"type": "ready", "session_id": effective_session_id}),
    )
    log.info("ws.connect", session_id=effective_session_id)

    send_lock = asyncio.Lock()

    async def send_json_safe(payload: dict[str, Any]) -> None:
        async with send_lock:
            try:
                await websocket.send_text(json.dumps(payload))
            except Exception as exc:  # noqa: BLE001
                log.warning("ws.send_failed", session_id=effective_session_id, error=str(exc))

    async def on_question(question: str, confidence: float, is_follow_up: bool) -> None:
        await send_json_safe(
            {
                "type": "question_detected",
                "question": question,
                "confidence": confidence,
                "is_follow_up": is_follow_up,
            }
        )

    async def on_qd_state(state: str) -> None:
        await send_json_safe({"type": "qd_state", "state": state})

    async def on_qd_fallback(model: str) -> None:
        await send_json_safe({"type": "qd_fallback", "model": model})

    async def on_qd_error(reason: str) -> None:
        await send_json_safe({"type": "qd_error", "reason": reason})

    async def on_qd_dedup(question: str) -> None:
        await send_json_safe({"type": "qd_dedup", "question": question})

    async def on_manual_question(question: str | None) -> None:
        await send_json_safe({"type": "manual_question", "question": question})

    detector = QuestionDetector(
        effective_session_id,
        on_question,
        on_state=on_qd_state,
        on_fallback=on_qd_fallback,
        on_error=on_qd_error,
        on_dedup=on_qd_dedup,
        on_manual=on_manual_question,
    )
    # Restore the fallback flag if a prior WS connection persisted one.
    # Survives transient reconnects so we don't pay another wasted Gemini
    # retry per reconnect.
    await detector.restore_persistent_state()

    async def on_transcript(payload: dict[str, Any]) -> None:
        await send_json_safe(payload)
        if payload.get("is_final") and payload.get("text"):
            await append_transcript(effective_session_id, payload)
            # Arm timers (or fire on speaker-turn) for auto question-detection.
            sp_raw = payload.get("speaker")
            speaker = sp_raw if isinstance(sp_raw, int) else None
            text_raw = payload.get("text")
            text = str(text_raw) if isinstance(text_raw, str) else None
            detector.notify_final(speaker=speaker, text=text)

    async def on_error(message: str) -> None:
        await send_json_safe({"type": "error", "message": message})

    try:
        deepgram = DeepgramSession(on_transcript=on_transcript, on_error=on_error)
    except Exception as exc:  # noqa: BLE001
        await send_json_safe({"type": "error", "message": str(exc)})
        await websocket.close(code=1011)
        return

    try:
        await deepgram.connect()
    except Exception as exc:  # noqa: BLE001
        log.error(
            "ws.deepgram_connect_failed", session_id=effective_session_id, error=str(exc)
        )
        await send_json_safe({"type": "error", "message": f"Deepgram connect failed: {exc}"})
        await websocket.close(code=1011)
        return

    audio_frame_count = 0
    audio_budget_blocked = False

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if "bytes" in message and message["bytes"] is not None:
                if audio_budget_blocked:
                    continue
                if not paused:
                    await deepgram.send(message["bytes"])
                    audio_frame_count += 1
                    if audio_frame_count % AUDIO_TRACK_FLUSH_EVERY == 0:
                        await add_audio_seconds(
                            effective_session_id,
                            AUDIO_FRAME_SECONDS * AUDIO_TRACK_FLUSH_EVERY,
                        )
                        check = await check_audio_budget(effective_session_id)
                        if not check.ok:
                            audio_budget_blocked = True
                            await send_json_safe(
                                {
                                    "type": "limit_exceeded",
                                    "kind": "audio",
                                    "message": check.message,
                                    "used_minutes": check.used,
                                    "limit_minutes": check.limit,
                                }
                            )
                continue
            if "text" in message and message["text"] is not None:
                try:
                    control = json.loads(message["text"])
                except json.JSONDecodeError:
                    await send_json_safe(
                        {"type": "error", "message": "invalid control message"},
                    )
                    continue
                kind = control.get("type")
                if kind == "start":
                    paused = False
                    await deepgram.stop_keepalive()
                    log.info("ws.start", session_id=effective_session_id)
                elif kind == "pause":
                    paused = True
                    await deepgram.start_keepalive()
                    log.info("ws.pause", session_id=effective_session_id)
                elif kind == "set_qd_model":
                    model = control.get("model")
                    if isinstance(model, str):
                        ok = detector.set_model(model)
                        if not ok:
                            await send_json_safe(
                                {
                                    "type": "error",
                                    "message": f"invalid qd model: {model}",
                                }
                            )
                elif kind == "detect_now":
                    detector.detect_now()
                elif kind == "stop":
                    log.info("ws.stop", session_id=effective_session_id)
                    break
    except WebSocketDisconnect:
        log.info("ws.disconnect", session_id=effective_session_id)
    except Exception as exc:  # noqa: BLE001
        log.error("ws.error", session_id=effective_session_id, error=str(exc))
    finally:
        await detector.close()
        await deepgram.finish()
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        log.info("ws.closed", session_id=effective_session_id)
