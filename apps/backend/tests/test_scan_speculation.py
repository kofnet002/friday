import asyncio

import pytest

from app.api.vision import ScanExtractionCache, scan_digest
from app.models.coding import ExtractedProblem


def _problem() -> ExtractedProblem:
    return ExtractedProblem(is_coding_problem=False, confidence=0.9)


def test_scan_digest_depends_on_every_view_and_its_order():
    assert scan_digest([b"a", b"b"]) == scan_digest([b"a", b"b"])
    assert scan_digest([b"a", b"b"]) != scan_digest([b"b", b"a"])
    assert scan_digest([b"ab"]) != scan_digest([b"a", b"b"])


@pytest.mark.asyncio
async def test_final_request_reuses_an_in_flight_speculative_read():
    cache = ScanExtractionCache(max_entries=4)
    calls = 0
    started = asyncio.Event()

    async def extract() -> ExtractedProblem:
        nonlocal calls
        calls += 1
        started.set()
        await asyncio.sleep(0.01)
        return _problem()

    speculative = asyncio.create_task(cache.run(("s", "d1"), extract))
    await started.wait()
    final = await cache.run(("s", "d1"), extract)
    assert calls == 1
    assert (await speculative).confidence == final.confidence
    # Each caller gets its own copy, so marking one partial can't leak.
    assert final is not await speculative


@pytest.mark.asyncio
async def test_failed_read_is_not_cached():
    cache = ScanExtractionCache(max_entries=4)
    attempts = 0

    async def flaky() -> ExtractedProblem:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("provider down")
        return _problem()

    with pytest.raises(RuntimeError):
        await cache.run(("s", "d"), flaky)
    assert (await cache.run(("s", "d"), flaky)).confidence == 0.9
    assert attempts == 2


@pytest.mark.asyncio
async def test_cache_is_bounded():
    cache = ScanExtractionCache(max_entries=2)

    async def extract() -> ExtractedProblem:
        return _problem()

    for i in range(5):
        await cache.run(("s", f"d{i}"), extract)
    assert len(cache) == 2


def test_speculative_question_event_is_marked_and_partial():
    from app.api.vision import screen_question_event

    problem = ExtractedProblem(
        is_coding_problem=False,
        is_screen_question=True,
        questions=["Q1", "Q2"],
        completeness="complete",
        confidence=0.9,
    )
    event = screen_question_event(problem, is_scan=True, speculative=True, scan_id="scan-1")
    assert event["speculative"] is True
    assert event["scan_id"] == "scan-1"
    # The scan is still running, so the page can't be complete yet.
    assert event["completeness"] == "partial"
