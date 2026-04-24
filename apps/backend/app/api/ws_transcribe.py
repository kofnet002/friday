from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.logging import log
from app.providers.deepgram import DeepgramSession
from app.redis_client import append_transcript
from app.services.question_detection import QuestionDetector

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

    async def on_question(question: str, confidence: float) -> None:
        await send_json_safe(
            {"type": "question_detected", "question": question, "confidence": confidence}
        )

    detector = QuestionDetector(effective_session_id, on_question)

    async def on_transcript(payload: dict[str, Any]) -> None:
        await send_json_safe(payload)
        if payload.get("is_final") and payload.get("text"):
            await append_transcript(effective_session_id, payload)
            # Arm the silence timer for auto question-detection.
            detector.notify_final()

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

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if "bytes" in message and message["bytes"] is not None:
                if not paused:
                    await deepgram.send(message["bytes"])
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
