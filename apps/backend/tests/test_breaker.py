"""Quota circuit breaker behavior."""

from __future__ import annotations

import time

from app.services import _breaker


def test_trips_after_consecutive_quota_failures() -> None:
    p = "prov-a"
    _breaker.record_success(p)  # clean slate
    _breaker.record_failure(p, "429 Too Many Requests: quota exceeded")
    assert not _breaker.is_open(p)
    _breaker.record_failure(p, "RESOURCE_EXHAUSTED")
    assert _breaker.is_open(p)


def test_success_closes_breaker() -> None:
    p = "prov-b"
    _breaker.record_failure(p, "429 quota")
    _breaker.record_failure(p, "429 quota")
    assert _breaker.is_open(p)
    _breaker.record_success(p)
    assert not _breaker.is_open(p)


def test_non_quota_errors_never_trip() -> None:
    p = "prov-c"
    _breaker.record_success(p)
    for _ in range(5):
        _breaker.record_failure(p, "503 Service Unavailable")
    assert not _breaker.is_open(p)
    # A non-quota error also resets the quota streak.
    _breaker.record_failure(p, "429 quota")
    _breaker.record_failure(p, "boom: connection reset")
    _breaker.record_failure(p, "429 quota")
    assert not _breaker.is_open(p)


def test_filter_chain_skips_open_but_never_empties() -> None:
    a, b = "prov-d", "prov-e"
    _breaker.record_success(a)
    _breaker.record_success(b)
    _breaker.record_failure(a, "429 quota")
    _breaker.record_failure(a, "429 quota")
    assert _breaker.filter_chain([a, b]) == [b]
    # All open → original chain returned (doubles as the recovery probe).
    _breaker.record_failure(b, "429 quota")
    _breaker.record_failure(b, "429 quota")
    assert _breaker.filter_chain([a, b]) == [a, b]


def test_open_expires() -> None:
    p = "prov-f"
    _breaker.record_failure(p, "429 quota")
    _breaker.record_failure(p, "429 quota")
    assert _breaker.is_open(p)
    # Rewind the deadline instead of sleeping.
    _breaker._state(p).open_until = time.monotonic() - 1
    assert not _breaker.is_open(p)
