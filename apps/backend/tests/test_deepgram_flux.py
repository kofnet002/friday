"""FluxSession must never hold up the audio loop while it (re)connects.

ws_transcribe forwards both streams (interviewer + mic) from ONE receive
loop, so a send() that awaited a slow Deepgram handshake froze the other
stream too — on a poor network the mic stream's 10 s handshake timeouts
starved the interviewer stream until Deepgram dropped it.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from app.providers import deepgram_flux
from app.providers.deepgram_flux import FluxSession
from app.settings import settings


class _FakeWs:
    def __init__(self) -> None:
        self.sent: list[Any] = []
        self._closed = asyncio.Event()

    async def send(self, data: Any) -> None:
        self.sent.append(data)

    async def close(self) -> None:
        self._closed.set()

    def __aiter__(self) -> _FakeWs:
        return self

    async def __anext__(self) -> Any:
        await self._closed.wait()
        raise StopAsyncIteration

    def audio(self) -> list[bytes]:
        return [d for d in self.sent if isinstance(d, bytes)]


class _Handshake:
    """Stands in for websockets.connect; each call waits until released."""

    def __init__(self) -> None:
        self.calls = 0
        self.release = asyncio.Event()
        self.fail_next = 0
        self.ws = _FakeWs()

    async def __call__(self, *_args: Any, **_kwargs: Any) -> _FakeWs:
        self.calls += 1
        if self.fail_next:
            self.fail_next -= 1
            raise TimeoutError("timed out during opening handshake")
        await self.release.wait()
        return self.ws


@pytest.fixture
def handshake(monkeypatch: pytest.MonkeyPatch) -> _Handshake:
    monkeypatch.setattr(settings, "deepgram_api_key", "test-key")
    fake = _Handshake()
    monkeypatch.setattr(deepgram_flux, "connect", fake)
    return fake


def _session() -> FluxSession:
    async def on_event(_ev: Any) -> None:
        return None

    async def on_error(_msg: str) -> None:
        return None

    return FluxSession(label="candidate", on_event=on_event, on_error=on_error)


async def _settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


async def test_send_does_not_wait_for_a_slow_handshake(handshake: _Handshake) -> None:
    flux = _session()
    # The handshake never completes here; send must still return at once.
    await asyncio.wait_for(flux.send(b"a"), timeout=0.2)
    await asyncio.wait_for(flux.send(b"b"), timeout=0.2)
    assert handshake.calls == 1  # one handshake in flight, not one per frame
    await flux.finish()


async def test_audio_sent_while_connecting_is_delivered_in_order(handshake: _Handshake) -> None:
    flux = _session()
    await flux.send(b"1")
    await flux.send(b"2")
    handshake.release.set()
    await _settle()
    await flux.send(b"3")
    assert handshake.ws.audio() == [b"1", b"2", b"3"]
    await flux.finish()


async def test_buffered_audio_is_bounded(
    handshake: _Handshake, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(deepgram_flux, "PENDING_AUDIO_MAX_FRAMES", 3)
    flux = _session()
    for frame in (b"1", b"2", b"3", b"4", b"5"):
        await flux.send(frame)
    handshake.release.set()
    await _settle()
    await flux.send(b"6")
    # Oldest frames give way; the newest audio survives.
    assert handshake.ws.audio() == [b"3", b"4", b"5", b"6"]
    await flux.finish()


async def test_failed_handshake_retries_after_cooldown(
    handshake: _Handshake, monkeypatch: pytest.MonkeyPatch
) -> None:
    handshake.fail_next = 1
    flux = _session()
    await flux.send(b"1")
    await _settle()
    assert handshake.calls == 1
    # Within the cooldown: no new attempt per frame.
    await flux.send(b"2")
    await _settle()
    assert handshake.calls == 1
    # Cooldown over: the next frame starts a fresh attempt.
    monkeypatch.setattr(deepgram_flux, "CONNECT_RETRY_S", 0.0)
    flux._next_connect_at = 0.0
    handshake.release.set()
    await flux.send(b"3")
    await _settle()
    await flux.send(b"4")
    assert handshake.calls == 2
    assert handshake.ws.audio() == [b"1", b"2", b"3", b"4"]
    await flux.finish()


async def test_suspend_cancels_an_in_flight_handshake(handshake: _Handshake) -> None:
    flux = _session()
    await flux.send(b"1")
    await _settle()
    await flux.suspend()
    handshake.release.set()
    await _settle()
    assert not flux.connected
    # Audio from before the pause is not replayed after resuming.
    await flux.send(b"2")
    await _settle()
    await flux.send(b"3")
    assert handshake.ws.audio() == [b"2", b"3"]
    await flux.finish()
