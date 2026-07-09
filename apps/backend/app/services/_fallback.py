"""Cross-provider fallback for streaming endpoints.

`_retry.py` already retries transient failures against the SAME provider
(Gemini 503, OpenAI overload, etc.). This module sits one level above:
when retries are exhausted (or the error is hard / non-transient), it
switches to the next provider in a priority chain.

Constraints
-----------
- Fallback is only safe BEFORE any token has reached the caller. Once
  tokens have streamed, switching providers would mean the user sees a
  half-Gemini, half-OpenAI answer.
- Each per-provider attempt is itself wrapped in `retry_stream`, so a
  transient blip retries first; persistent failure tips into the next
  provider.
- The caller passes an `on_fallback` callback that's invoked just before
  the next provider's stream starts — the WS layer uses this to push a
  `provider_changed` event down so the client knows the badge changed.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import TypeVar

from app.logging import log
from app.services import _breaker

ProviderName = TypeVar("ProviderName", bound=str)

FactoryFn = Callable[[ProviderName], AsyncIterator[str]]
FallbackHook = Callable[[ProviderName, ProviderName, str], Awaitable[None]]


async def stream_with_fallback(
    *,
    providers: list[ProviderName],
    factory: FactoryFn[ProviderName],
    on_fallback: FallbackHook[ProviderName] | None = None,
    label: str = "stream",
) -> AsyncIterator[str]:
    """Try providers in order. Switch on pre-stream failure; raise if the
    chain is exhausted or the current attempt has already emitted tokens.

    `factory(provider)` should return the per-provider streaming iterator,
    typically the same call already wrapped in `retry_stream`. Each call to
    factory() opens a fresh upstream connection, so this generator can call
    it once per provider safely.
    """
    if not providers:
        raise ValueError("stream_with_fallback called with no providers")
    last_exc: BaseException | None = None
    for idx, provider in enumerate(providers):
        emitted = False
        start = time.monotonic()
        try:
            async for token in factory(provider):
                emitted = True
                yield token
            elapsed_ms = (time.monotonic() - start) * 1000
            log.info(
                "stream.provider_done",
                label=label,
                provider=provider,
                elapsed_ms=round(elapsed_ms, 1),
            )
            _breaker.record_success(provider)
            return
        except Exception as exc:  # noqa: BLE001
            elapsed_ms = (time.monotonic() - start) * 1000
            log.warning(
                "stream.provider_failed",
                label=label,
                provider=provider,
                elapsed_ms=round(elapsed_ms, 1),
                emitted=emitted,
                error=str(exc)[:200],
            )
            last_exc = exc
            # Feed the quota breaker so chain builders can skip a provider
            # whose quota is exhausted instead of re-failing on every call.
            _breaker.record_failure(provider, str(exc))
            # If we already streamed something to the caller we can't
            # safely switch — the partial output is in the wire. Re-raise.
            if emitted:
                raise
            # If there are no more providers to try, re-raise so the
            # endpoint reports the original error rather than the chain.
            if idx == len(providers) - 1:
                raise
            next_provider = providers[idx + 1]
            if on_fallback is not None:
                try:
                    await on_fallback(provider, next_provider, str(exc)[:200])
                except Exception:  # noqa: BLE001
                    # An on_fallback failure must not prevent the fallback
                    # itself; the user gets the next provider regardless.
                    pass
    # Unreachable — the loop either returns on success or re-raises.
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("stream_with_fallback exhausted with no exception captured")
