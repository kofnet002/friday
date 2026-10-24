from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.db import get_session
from app.logging import log
from app.providers.deepgram import DeepgramSession
from app.providers.deepgram_flux import FluxSession, FluxTurnEvent
from app.redis_client import append_transcript, recent_transcript_entries
from app.services.keyterms import extract_keyterms
from app.services.limits import add_audio_seconds, check_audio_budget
from app.services.question_detection import QuestionDetector
from app.services.turn_detection import TurnCoordinator
from app.settings import settings

# Each PCM frame from the desktop helper is 100ms long (16 kHz × 0.1s × 2 bytes).
AUDIO_FRAME_SECONDS = 0.1
# Flush audio-second counter to Redis every N frames to reduce write traffic.
AUDIO_TRACK_FLUSH_EVERY = 10

# Tagged audio (client sent {"type": "start", "audio_format": "tagged"}):
# every binary frame starts with one source byte, then raw PCM.
SOURCE_SYSTEM = 0  # interviewer — what comes out of the speakers
SOURCE_MIC = 1  # candidate

router = APIRouter()


def _use_flux(session: dict[str, Any] | None) -> bool:
    if settings.turn_engine != "flux":
        return False
    language = str((session or {}).get("language") or "en").lower()
    return language.startswith("en")


@router.websocket("/ws/transcribe")
async def ws_transcribe(websocket: WebSocket, session_id: str | None = None) -> None:
    await websocket.accept()
    # Accept a client-supplied session_id (from /setup flow); otherwise mint one.
    effective_session_id = session_id or str(uuid.uuid4())
    paused = False
    tagged_audio = False

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

    detector = QuestionDetector(
        effective_session_id,
        on_question,
        on_state=on_qd_state,
        on_fallback=on_qd_fallback,
        on_error=on_qd_error,
        on_dedup=on_qd_dedup,
    )
    # Restore the fallback flag if a prior WS connection persisted one.
    # Survives transient reconnects so we don't pay another wasted Gemini
    # retry per reconnect.
    await detector.restore_persistent_state()

    async def on_error(message: str) -> None:
        await send_json_safe({"type": "error", "message": message})

    session_row = await get_session(effective_session_id) if session_id else None
    keyterms = extract_keyterms(session_row)
    use_flux = _use_flux(session_row)
    log.info(
        "ws.transcribe_engine",
        session_id=effective_session_id,
        engine="flux" if use_flux else "nova",
        keyterms=len(keyterms),
    )

    # ─── engine wiring ────────────────────────────────────────────────────
    # Flux: one stream per source + the turn coordinator. Nova: one diarized
    # stream + the timer-driven detector (mic frames are ignored there), also
    # the fallback when Flux can't connect.
    nova: DeepgramSession | None = None
    interviewer: FluxSession | None = None
    candidate: FluxSession | None = None
    coordinator: TurnCoordinator | None = None

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

    async def append_final(row: dict[str, Any]) -> None:
        await append_transcript(effective_session_id, row)

    async def recent(window_s: float) -> list[dict[str, Any]]:
        return await recent_transcript_entries(effective_session_id, window_s)

    async def force_end() -> None:
        if interviewer is not None:
            await interviewer.force_end_turn()

    async def on_interviewer(ev: FluxTurnEvent) -> None:
        if coordinator is not None:
            await coordinator.on_interviewer(ev)

    async def on_candidate(ev: FluxTurnEvent) -> None:
        if coordinator is not None:
            await coordinator.on_candidate(ev)

    if use_flux:
        try:
            interviewer = FluxSession(
                label="interviewer",
                on_event=on_interviewer,
                on_error=on_error,
                keyterms=keyterms,
                eager=settings.speculative_answers,
            )
            await interviewer.connect()
            # Connected lazily on the first mic frame — a client without mic
            # capture never opens it.
            candidate = FluxSession(
                label="candidate",
                on_event=on_candidate,
                on_error=on_error,
                keyterms=keyterms,
                eager=False,
            )
            coordinator = TurnCoordinator(
                effective_session_id,
                detector,
                emit=send_json_safe,
                append_final=append_final,
                recent_entries=recent,
                force_end_interviewer=force_end,
                speculate=settings.speculative_answers,
            )
        except Exception as exc:  # noqa: BLE001
            # Flux unavailable (plan, outage) — degrade to nova-3 + timers
            # rather than failing the session.
            log.error("ws.flux_connect_failed", session_id=effective_session_id, error=str(exc))
            interviewer = candidate = None
            coordinator = None

    if coordinator is None:
        try:
            nova = DeepgramSession(
                on_transcript=on_transcript, on_error=on_error, keyterms=keyterms
            )
            await nova.connect()
        except Exception as exc:  # noqa: BLE001
            log.error("ws.deepgram_connect_failed", session_id=effective_session_id, error=str(exc))
            await send_json_safe({"type": "error", "message": f"Deepgram connect failed: {exc}"})
            await websocket.close(code=1011)
            return

    async def send_audio(source: int, pcm: bytes) -> None:
        if nova is not None:
            if source == SOURCE_SYSTEM:
                await nova.send(pcm)
        elif source == SOURCE_SYSTEM and interviewer is not None:
            await interviewer.send(pcm)
        elif source == SOURCE_MIC and candidate is not None:
            await candidate.send(pcm)

    async def suspend_streams() -> None:
        if nova is not None:
            await nova.start_keepalive()
        for stream in (interviewer, candidate):
            if stream is not None and stream.connected:
                await stream.suspend()

    audio_frame_count = 0
    audio_budget_blocked = False

    try:
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if "bytes" in message and message["bytes"] is not None:
                if audio_budget_blocked or paused:
                    continue
                data: bytes = message["bytes"]
                source = SOURCE_SYSTEM
                if tagged_audio:
                    if not data:
                        continue
                    source, data = data[0], data[1:]
                await send_audio(source, data)
                # Meter the interview (system audio) only — the mic stream
                # mirrors the same wall-clock time.
                if source != SOURCE_SYSTEM:
                    continue
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
                    tagged_audio = control.get("audio_format") == "tagged"
                    if nova is not None:
                        await nova.stop_keepalive()
                    log.info("ws.start", session_id=effective_session_id, tagged_audio=tagged_audio)
                elif kind == "pause":
                    paused = True
                    await suspend_streams()
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
                elif kind == "stop":
                    log.info("ws.stop", session_id=effective_session_id)
                    break
    except WebSocketDisconnect:
        log.info("ws.disconnect", session_id=effective_session_id)
    except Exception as exc:  # noqa: BLE001
        log.error("ws.error", session_id=effective_session_id, error=str(exc))
    finally:
        if coordinator is not None:
            await coordinator.close()
        await detector.close()
        if nova is not None:
            await nova.finish()
        for stream in (interviewer, candidate):
            if stream is not None:
                await stream.finish()
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass
        log.info("ws.closed", session_id=effective_session_id)
