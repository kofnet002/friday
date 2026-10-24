"""Deepgram Flux streaming client (turn-based speech-to-text).

Flux (`/v2/listen`) is Deepgram's conversational model: instead of
silence-split "finals" it reports TURNS, with a semantic end-of-turn decision
that looks at what was said, not just how long the pause was. Events, all
`{"type": "TurnInfo", "event": ...}`:

- ``StartOfTurn``      — speech began a new turn.
- ``Update``           — ~every 250 ms with the turn's cumulative transcript.
- ``EagerEndOfTurn``   — early, lower-confidence "probably done" (only when
                         ``eager_eot_threshold`` is set). Speculate here.
- ``TurnResumed``      — the speaker kept going after an eager EOT; discard
                         anything started speculatively.
- ``EndOfTurn``        — confirmed end. Its transcript always equals the
                         preceding EagerEndOfTurn's (Deepgram guarantees this;
                         any change produces TurnResumed first).

We run Flux in "semi-manual" mode: native detection stays on, and the
coordinator can also send ``ForceEndTurn`` when it has a definite signal
(e.g. the candidate started answering). See services/turn_detection.py.

The deepgram-sdk version we pin predates Flux, so this speaks the documented
wire protocol directly over `websockets`.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from app.logging import log
from app.settings import settings

FLUX_URL = "wss://api.deepgram.com/v2/listen"


@dataclass(frozen=True)
class FluxWord:
    word: str
    confidence: float
    start: float | None = None
    end: float | None = None


@dataclass(frozen=True)
class FluxTurnEvent:
    """One TurnInfo message, normalized. `received_at` is local wall-clock
    time — used for latency timelines, since Flux's audio_window_* are
    stream-relative seconds."""

    event: str
    turn_index: int
    transcript: str
    end_of_turn_confidence: float
    audio_window_start: float
    audio_window_end: float
    words: tuple[FluxWord, ...] = ()
    trigger: str | None = None
    received_at: float = field(default_factory=time.time)


TurnEventCallback = Callable[[FluxTurnEvent], Awaitable[None]]
ErrorCallback = Callable[[str], Awaitable[None]]


def parse_turn_info(data: dict[str, Any]) -> FluxTurnEvent | None:
    """Parse a server JSON message into a FluxTurnEvent, or None when it
    isn't a TurnInfo (Connected / ConfigureSuccess / Warning …)."""
    if data.get("type") != "TurnInfo":
        return None
    words = tuple(
        FluxWord(
            word=str(w.get("word") or ""),
            confidence=float(w.get("confidence") or 0.0),
            start=float(w["start"]) if w.get("start") is not None else None,
            end=float(w["end"]) if w.get("end") is not None else None,
        )
        for w in data.get("words") or []
        if isinstance(w, dict)
    )
    return FluxTurnEvent(
        event=str(data.get("event") or ""),
        turn_index=int(data.get("turn_index") or 0),
        transcript=str(data.get("transcript") or "").strip(),
        end_of_turn_confidence=float(data.get("end_of_turn_confidence") or 0.0),
        audio_window_start=float(data.get("audio_window_start") or 0.0),
        audio_window_end=float(data.get("audio_window_end") or 0.0),
        words=words,
        trigger=data.get("trigger"),
    )


def flux_query(*, keyterms: Sequence[str] = (), eager: bool = True) -> list[tuple[str, str]]:
    params: list[tuple[str, str]] = [
        ("model", settings.flux_model),
        ("encoding", "linear16"),
        ("sample_rate", str(settings.deepgram_sample_rate)),
        ("eot_threshold", str(settings.flux_eot_threshold)),
        ("eot_timeout_ms", str(settings.flux_eot_timeout_ms)),
    ]
    if eager:
        params.append(("eager_eot_threshold", str(settings.flux_eager_eot_threshold)))
    # Repeated param, one term each — Deepgram rejects comma-joined lists.
    params.extend(("keyterm", term) for term in keyterms)
    return params


class FluxSession:
    """One Flux stream (one audio source). Reconnects with backoff on
    unexpected close; `suspend()` closes deliberately (pause) and the next
    `send()` reconnects lazily, so a paused session costs nothing."""

    MAX_RETRIES = 5
    BACKOFF_BASE_S = 0.5

    def __init__(
        self,
        *,
        label: str,
        on_event: TurnEventCallback,
        on_error: ErrorCallback,
        keyterms: Sequence[str] = (),
        eager: bool = True,
    ) -> None:
        if not settings.deepgram_api_key:
            raise RuntimeError("DEEPGRAM_API_KEY is not set")
        self.label = label
        self._on_event = on_event
        self._on_error = on_error
        self._keyterms = tuple(keyterms)
        self._eager = eager
        self._ws: ClientConnection | None = None
        self._reader: asyncio.Task[None] | None = None
        self._connect_lock = asyncio.Lock()
        self._closed = False
        self._suspended = False
        self._retries = 0

    @property
    def connected(self) -> bool:
        return self._ws is not None

    async def connect(self) -> None:
        async with self._connect_lock:
            if self._ws is not None or self._closed:
                return
            url = f"{FLUX_URL}?{urlencode(flux_query(keyterms=self._keyterms, eager=self._eager))}"
            ws = await connect(
                url,
                additional_headers={"Authorization": f"Token {settings.deepgram_api_key}"},
                max_size=None,
                open_timeout=10,
            )
            self._ws = ws
            self._suspended = False
            self._reader = asyncio.create_task(self._read_loop(ws))
            log.info(
                "flux.connected",
                label=self.label,
                model=settings.flux_model,
                keyterms=len(self._keyterms),
            )

    async def _read_loop(self, ws: ClientConnection) -> None:
        try:
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                try:
                    data = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                kind = data.get("type")
                if kind == "TurnInfo":
                    self._retries = 0
                    event = parse_turn_info(data)
                    if event is not None:
                        try:
                            await self._on_event(event)
                        except Exception as exc:  # noqa: BLE001
                            log.error("flux.on_event_error", label=self.label, error=str(exc))
                elif kind == "Error":
                    log.error(
                        "flux.error",
                        label=self.label,
                        code=data.get("code"),
                        description=data.get("description"),
                    )
                elif kind == "Warning":
                    log.info(
                        "flux.warning",
                        label=self.label,
                        code=data.get("code"),
                        description=data.get("description"),
                    )
        except ConnectionClosed as exc:
            log.info("flux.closed", label=self.label, code=exc.rcvd.code if exc.rcvd else None)
        except asyncio.CancelledError:
            return
        finally:
            if self._ws is ws:
                self._ws = None
        if not self._closed and not self._suspended:
            await self._reconnect()

    async def _reconnect(self) -> None:
        if self._retries >= self.MAX_RETRIES:
            await self._on_error(f"Deepgram Flux ({self.label}) reconnect gave up")
            return
        self._retries += 1
        delay = self.BACKOFF_BASE_S * (2 ** (self._retries - 1))
        log.warning("flux.reconnect", label=self.label, attempt=self._retries, delay_s=delay)
        await asyncio.sleep(delay)
        if self._closed or self._suspended:
            return
        try:
            await self.connect()
        except Exception as exc:  # noqa: BLE001
            log.error("flux.reconnect_failed", label=self.label, error=str(exc))
            await self._reconnect()

    async def send(self, audio: bytes) -> None:
        if self._closed:
            return
        if self._ws is None:
            # Lazy (re)connect after suspend() or a dropped socket.
            try:
                await self.connect()
            except Exception as exc:  # noqa: BLE001
                log.error("flux.connect_failed", label=self.label, error=str(exc))
                return
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(audio)
        except ConnectionClosed:
            pass

    async def _send_json(self, payload: dict[str, Any]) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            await ws.send(json.dumps(payload))
        except ConnectionClosed:
            pass

    async def force_end_turn(self) -> None:
        """End the current turn now (EndOfTurn with trigger=manual). A no-op
        warning from Flux when no turn is active."""
        await self._send_json({"type": "ForceEndTurn"})

    async def suspend(self) -> None:
        """Pause: close the stream so idle time isn't billed; the next send()
        reconnects."""
        self._suspended = True
        await self._close_ws()

    async def finish(self) -> None:
        self._closed = True
        await self._close_ws()

    async def _close_ws(self) -> None:
        ws = self._ws
        if ws is not None:
            await self._send_json({"type": "CloseStream"})
            try:
                await asyncio.wait_for(ws.close(), timeout=2.0)
            except Exception:  # noqa: BLE001
                pass
        self._ws = None
        reader = self._reader
        self._reader = None
        if reader is not None and not reader.done():
            reader.cancel()
            try:
                await reader
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
