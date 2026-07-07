"""Quota circuit breaker for provider fallback chains.

`_retry.py` handles transient blips (503s) and `_fallback.py` switches
providers when one call fails — but neither remembers anything, so a provider
with an EXHAUSTED QUOTA (Gemini free tier returning 429 on every call) gets
retried at the head of the chain on every single request, burning ~0.5-1s and
a network round-trip each time for a guaranteed failure.

This module keeps a tiny in-process memory: after `_TRIP_AFTER` consecutive
quota-shaped failures, the provider's breaker OPENS and chain builders skip it
for `_OPEN_S`. Any success closes it immediately. Only quota/rate-limit errors
count — hard errors and transient 5xx never trip the breaker (they're either
bugs or already handled by retry).

Deliberately in-process and approximate (per-worker, resets on reload): the
goal is "stop paying the dead-provider tax on every call", not distributed
correctness.
"""

from __future__ import annotations

import time

from app.logging import log

# Substrings that mark a quota/rate-limit failure (case-insensitive).
_QUOTA_MARKERS = ("429", "quota", "rate limit", "rate_limit", "resource_exhausted")
# Consecutive quota failures before the breaker opens.
_TRIP_AFTER = 2
# How long an open breaker skips the provider. Gemini free-tier buckets reset
# hourly; 30 min means at most one wasted probe cycle after recovery.
_OPEN_S = 30 * 60


class _State:
    __slots__ = ("consecutive_quota_failures", "open_until")

    def __init__(self) -> None:
        self.consecutive_quota_failures = 0
        self.open_until = 0.0


_states: dict[str, _State] = {}


def _state(provider: str) -> _State:
    st = _states.get(provider)
    if st is None:
        st = _State()
        _states[provider] = st
    return st


def looks_like_quota_error(error_text: str) -> bool:
    lowered = error_text.lower()
    return any(marker in lowered for marker in _QUOTA_MARKERS)


def record_failure(provider: str, error_text: str) -> None:
    """Count a failure. Only quota-shaped errors advance the trip counter;
    anything else resets it (a real bug shouldn't sideline a provider)."""
    st = _state(provider)
    if not looks_like_quota_error(error_text):
        st.consecutive_quota_failures = 0
        return
    st.consecutive_quota_failures += 1
    if st.consecutive_quota_failures >= _TRIP_AFTER and st.open_until < time.monotonic():
        st.open_until = time.monotonic() + _OPEN_S
        log.info(
            "breaker.open",
            provider=provider,
            failures=st.consecutive_quota_failures,
            open_s=_OPEN_S,
        )


def record_success(provider: str) -> None:
    st = _state(provider)
    if st.open_until:
        log.info("breaker.close", provider=provider)
    st.consecutive_quota_failures = 0
    st.open_until = 0.0


def is_open(provider: str) -> bool:
    return _state(provider).open_until > time.monotonic()


def filter_chain(chain: list) -> list:  # type: ignore[type-arg]
    """Drop open-breaker providers from a fallback chain. Never returns an
    empty list — if everything is open, the original chain is returned (a
    doomed attempt beats an instant hard failure, and it doubles as the
    recovery probe)."""
    filtered = [p for p in chain if not is_open(p)]
    if filtered != chain:
        log.info("breaker.chain_filtered", skipped=[p for p in chain if p not in filtered])
    return filtered or chain
