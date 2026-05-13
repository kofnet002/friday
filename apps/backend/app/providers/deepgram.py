from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from deepgram import DeepgramClient, LiveOptions, LiveTranscriptionEvents

from app.logging import log
from app.settings import settings

TranscriptCallback = Callable[[dict[str, Any]], Awaitable[None]]
ErrorCallback = Callable[[str], Awaitable[None]]


def _dominant_speaker(words: list[Any]) -> int | None:
    """Pick the speaker id of the segment from per-word labels.

    Deepgram with diarize=True returns each word as an object/dict with a
    `speaker` attribute (integer 0,1,2,…). We pick the one that appears most
    often in this segment as the segment's speaker. Returns None when the
    SDK didn't include speaker info (older responses, or diarize disabled)."""
    if not words:
        return None
    tally: dict[int, int] = {}
    for w in words:
        sp = getattr(w, "speaker", None) if not isinstance(w, dict) else w.get("speaker")
        if isinstance(sp, int):
            tally[sp] = tally.get(sp, 0) + 1
    if not tally:
        return None
    # Tie-break by lower speaker id so a stable speaker numbering survives
    # ambiguous mixed-speaker words.
    return min(tally.items(), key=lambda kv: (-kv[1], kv[0]))[0]


class DeepgramSession:
    """Thin wrapper around Deepgram async streaming with reconnection.

    Retry budget
    ------------
    The retry counter only resets when a real (non-empty) transcript lands —
    not merely on `connect()` success. This prevents reconnect storms when
    Deepgram's idle-timeout closes the socket immediately after a reconnect.

    Pause handling
    --------------
    While the caller is "paused" and not forwarding audio, Deepgram will
    close the socket after ~10s (error net0001). Call `start_keepalive()` on
    pause and `stop_keepalive()` on resume; the loop sends a KeepAlive frame
    every 5s to hold the session open.
    """

    MAX_RETRIES = 3
    BACKOFF_BASE_S = 0.5
    KEEPALIVE_INTERVAL_S = 5.0

    def __init__(
        self,
        on_transcript: TranscriptCallback,
        on_error: ErrorCallback,
    ) -> None:
        if not settings.deepgram_api_key:
            raise RuntimeError("DEEPGRAM_API_KEY is not set")
        self._on_transcript = on_transcript
        self._on_error = on_error
        self._client = DeepgramClient(settings.deepgram_api_key)
        self._connection: Any | None = None
        self._retries = 0
        self._closed = False
        self._keepalive_task: asyncio.Task[None] | None = None

    def _live_options(self) -> LiveOptions:
        return LiveOptions(
            model=settings.deepgram_model,
            language=settings.deepgram_language,
            interim_results=True,
            endpointing=settings.deepgram_endpointing_ms,
            punctuate=True,
            smart_format=True,
            # Enable speaker diarization so we can attribute each turn to a
            # speaker id (0, 1, 2, …). Deepgram emits per-word speaker labels
            # on result.channel.alternatives[0].words. We treat the dominant
            # speaker of the segment as the speaker for the whole transcript
            # turn (see speaker extraction in _on_message).
            diarize=True,
            encoding="linear16",
            sample_rate=settings.deepgram_sample_rate,
            channels=settings.deepgram_channels,
        )

    async def connect(self) -> None:
        connection = self._client.listen.asyncwebsocket.v("1")

        async def _on_message(_self: Any, result: Any, **_kwargs: Any) -> None:
            try:
                alt = result.channel.alternatives[0]
                text = alt.transcript or ""
                if not text:
                    return
                # A real transcript arrived — the stream is healthy.
                self._retries = 0
                payload = {
                    "type": "transcript",
                    "is_final": bool(result.is_final),
                    "text": text,
                    "confidence": float(getattr(alt, "confidence", 0.0) or 0.0),
                    "speaker": _dominant_speaker(getattr(alt, "words", None) or []),
                    "timestamp": time.time(),
                }
                await self._on_transcript(payload)
            except Exception as exc:  # noqa: BLE001
                log.error("deepgram.on_message_error", error=str(exc))

        async def _on_error(_self: Any, error: Any, **_kwargs: Any) -> None:
            log.error("deepgram.error", error=str(error))
            if not self._closed:
                await self._reconnect()

        async def _on_close(_self: Any, close: Any, **_kwargs: Any) -> None:
            log.info("deepgram.closed", reason=str(close))
            if not self._closed:
                await self._reconnect()

        connection.on(LiveTranscriptionEvents.Transcript, _on_message)
        connection.on(LiveTranscriptionEvents.Error, _on_error)
        connection.on(LiveTranscriptionEvents.Close, _on_close)

        started = await connection.start(self._live_options())
        if not started:
            raise RuntimeError("Deepgram connection failed to start")
        self._connection = connection
        log.info("deepgram.connected", model=settings.deepgram_model)

    async def _reconnect(self) -> None:
        if self._closed:
            return
        if self._retries >= self.MAX_RETRIES:
            await self._on_error(
                f"Deepgram reconnect gave up after {self.MAX_RETRIES} attempts"
            )
            return
        self._retries += 1
        delay = self.BACKOFF_BASE_S * (2 ** (self._retries - 1))
        log.warning("deepgram.reconnect", attempt=self._retries, delay_s=delay)
        await asyncio.sleep(delay)
        if self._closed:  # flag can flip during the backoff sleep
            return  # type: ignore[unreachable]
        try:
            await self.connect()
        except Exception as exc:  # noqa: BLE001
            log.error("deepgram.reconnect_failed", attempt=self._retries, error=str(exc))
            await self._reconnect()

    async def send(self, audio: bytes) -> None:
        if self._connection is None or self._closed:
            return
        try:
            await self._connection.send(audio)
        except Exception as exc:  # noqa: BLE001
            log.error("deepgram.send_error", error=str(exc))
            if not self._closed:
                await self._reconnect()

    async def start_keepalive(self) -> None:
        """Begin sending Deepgram KeepAlive frames to prevent idle-timeout close."""
        if self._keepalive_task and not self._keepalive_task.done():
            return
        self._keepalive_task = asyncio.create_task(self._keepalive_loop())

    async def stop_keepalive(self) -> None:
        task = self._keepalive_task
        self._keepalive_task = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

    async def _keepalive_loop(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(self.KEEPALIVE_INTERVAL_S)
                if self._closed or self._connection is None:
                    return
                try:
                    await self._connection.keep_alive()
                except Exception as exc:  # noqa: BLE001
                    log.warning("deepgram.keepalive_failed", error=str(exc))
                    return
        except asyncio.CancelledError:
            return

    async def finish(self) -> None:
        self._closed = True
        await self.stop_keepalive()
        if self._connection is None:
            return
        try:
            await self._connection.finish()
        except Exception as exc:  # noqa: BLE001
            log.error("deepgram.finish_error", error=str(exc))
        finally:
            self._connection = None
