from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from app.prompts.question_detection import Utterance
from app.services import question_detection as qd_mod
from app.services.question_detection import (
    ALLOWED_QD_MODELS,
    QuestionDetector,
    _is_claude_qd_model,
    _is_openai_qd_model,
    _is_quota_error,
    _looks_backchannel,
    _looks_mid_thought,
)
from app.settings import settings


@pytest.mark.parametrize(
    "text",
    [
        # The exact failure mode from the screenshot:
        "from how you usually did things. Interviewers are curious to learn how flex",
        "Please describe a situation where you needed to adapt a",
        "So I saw on your resume that you worked on an ML platform and",
        "I'm curious about",
        "Walk me through",
        "",
    ],
)
def test_mid_thought_skips(text: str) -> None:
    assert _looks_mid_thought(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "What's your favorite programming language?",
        "Tell me about a time you disagreed with your manager.",
        "Walk me through what happens when I type google.com into a browser.",
        "How would you design a rate limiter!",
    ],
)
def test_complete_fires(text: str) -> None:
    assert _looks_mid_thought(text) is False


# ─── backchannel filter ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "text",
    ["yeah", "Yeah.", "uh-huh", "MM-HMM", "right", "okay!", "no", "got it"],
)
def test_backchannel_detected(text: str) -> None:
    assert _looks_backchannel(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "Yeah I was thinking maybe we could look at the data",
        "Right, so the issue is that the retry logic is naive",
        "Tell me more about that decision",
    ],
)
def test_non_backchannel_kept(text: str) -> None:
    assert _looks_backchannel(text) is False


# ─── quota error detection ──────────────────────────────────────────────────


@pytest.mark.parametrize(
    "msg",
    [
        # The exact log line from the failing session:
        "429 RESOURCE_EXHAUSTED. {'error': {'code': 429, ...}}",
        "google.api_core.exceptions.ResourceExhausted: 429 RESOURCE_EXHAUSTED",
        "Quota exceeded: status RESOURCE_EXHAUSTED",
        "429 Too Many Requests",
    ],
)
def test_quota_error_matched(msg: str) -> None:
    assert _is_quota_error(Exception(msg)) is True


@pytest.mark.parametrize(
    "msg",
    [
        "500 Internal Server Error",
        "Connection reset",
        "Some random failure",
    ],
)
def test_non_quota_error_passes_through(msg: str) -> None:
    assert _is_quota_error(Exception(msg)) is False


def test_openai_model_detection() -> None:
    assert _is_openai_qd_model("gpt-4o") is True
    assert _is_openai_qd_model("gpt-4o-mini") is True
    assert _is_openai_qd_model("gemini-2.5-flash-lite") is False
    assert _is_openai_qd_model("gemini-2.5-pro") is False


def test_claude_model_detection() -> None:
    assert _is_claude_qd_model("claude-haiku-4-5") is True
    assert _is_claude_qd_model("claude-opus-5-5") is True
    assert _is_claude_qd_model("gpt-4o") is False
    assert _is_claude_qd_model("gemini-2.5-flash-lite") is False


def test_claude_models_are_selectable() -> None:
    """The QD dropdown mirrors this set — a model missing here is rejected
    by set_model and the user's pick silently does nothing."""
    assert {"claude-haiku-4-5", "claude-opus-5-5"} <= ALLOWED_QD_MODELS


def test_json_fence_stripped() -> None:
    """Gemini/OpenAI are pinned to a JSON response mode; Claude is not, so a
    stray ```json fence must not blow up the parse."""
    assert qd_mod._strip_json_fence('```json\n{"is_question": true}\n```') == (
        '{"is_question": true}'
    )
    assert qd_mod._strip_json_fence('{"is_question": true}') == '{"is_question": true}'


# ─── QuestionDetector integration ───────────────────────────────────────────


class _RecordingDetector:
    """Build a QuestionDetector with all LLM calls stubbed.

    The point of these tests is the *timer + routing* logic, not Gemini's
    actual question-detection quality. So we mock the client constructors
    to return None (no real API calls) and patch the LLM helpers to return
    canned results.
    """

    def __init__(self) -> None:
        self.questions: list[tuple[str, float, bool]] = []
        self.states: list[str] = []
        self.fallbacks: list[str] = []
        self.errors: list[str] = []
        self.dedups: list[str] = []
        self.qd_calls: int = 0

    async def on_question(self, q: str, c: float, is_follow_up: bool) -> None:
        self.questions.append((q, c, is_follow_up))

    async def on_state(self, s: str) -> None:
        self.states.append(s)

    async def on_fallback(self, m: str) -> None:
        self.fallbacks.append(m)

    async def on_error(self, reason: str) -> None:
        self.errors.append(reason)

    async def on_dedup(self, q: str) -> None:
        self.dedups.append(q)


def _make_detector(monkeypatch: pytest.MonkeyPatch) -> tuple[QuestionDetector, _RecordingDetector]:
    rec = _RecordingDetector()
    # Stub the client constructors so __init__ doesn't try to reach out.
    monkeypatch.setattr(qd_mod, "genai", _FakeGenai())
    monkeypatch.setattr(qd_mod, "AsyncOpenAI", lambda **_: _FakeOpenAI())
    monkeypatch.setattr(settings, "gemini_api_key", "fake-gemini-key")
    monkeypatch.setattr(settings, "openai_api_key", "fake-openai-key")
    # These tests exercise the OpenAI fallback path; pin it so a local .env
    # pointing the fallback at Claude doesn't change what they test.
    monkeypatch.setattr(settings, "question_detection_fallback_model", "gpt-4o-mini")
    det = QuestionDetector(
        session_id="t",
        on_question=rec.on_question,
        on_state=rec.on_state,
        on_fallback=rec.on_fallback,
        on_error=rec.on_error,
        on_dedup=rec.on_dedup,
    )
    return det, rec


class _FakeGenai:
    def Client(self, **_: Any) -> "_FakeGenaiClient":  # noqa: N802 - mirrors API
        return _FakeGenaiClient()


class _FakeGenaiClient:
    pass


class _FakeOpenAI:
    pass


async def _quick_finals(det: QuestionDetector, n: int, speaker: int | None = None, text: str = "hi") -> None:
    """Fire N finals rapidly so the idle timer keeps resetting and never
    settles — simulates an interviewer who keeps talking."""
    for _ in range(n):
        det.notify_final(speaker=speaker, text=text)
        await asyncio.sleep(0.05)


async def test_ceiling_fires_when_idle_keeps_resetting(monkeypatch: pytest.MonkeyPatch) -> None:
    """If finals arrive every 50ms forever, the idle timer (1200ms) never
    fires. The ceiling timer must fire on its own."""
    det, rec = _make_detector(monkeypatch)
    # Tiny ceiling so the test isn't slow. Idle threshold stays well above
    # the inter-final gap so it would never settle on its own.
    monkeypatch.setattr(settings, "question_detection_silence_ms", 1200)
    monkeypatch.setattr(settings, "question_detection_ceiling_ms", 400)
    monkeypatch.setattr(settings, "question_detection_transcript_window_s", 30)
    monkeypatch.setattr(settings, "question_detection_min_confidence", 0.7)

    triggered: list[str] = []

    async def fake_run(triggered_by: str = "idle") -> None:
        triggered.append(triggered_by)
        det._cancel_timers()  # mimic real _run behavior

    monkeypatch.setattr(det, "_run", fake_run)
    # Feed 10 finals 50ms apart → 500ms total, ceiling should fire at 400ms.
    await _quick_finals(det, 10)
    # Give the loop time for the ceiling to fire and the run task to settle.
    await asyncio.sleep(0.3)
    assert "ceiling" in triggered, f"expected ceiling to fire, got {triggered}"


async def test_speaker_turn_fires_immediately(monkeypatch: pytest.MonkeyPatch) -> None:
    det, rec = _make_detector(monkeypatch)
    monkeypatch.setattr(settings, "question_detection_silence_ms", 2000)
    monkeypatch.setattr(settings, "question_detection_ceiling_ms", 5000)
    triggered: list[str] = []

    async def fake_run(triggered_by: str = "idle") -> None:
        triggered.append(triggered_by)
        det._cancel_timers()

    monkeypatch.setattr(det, "_run", fake_run)
    # First final establishes speaker 0 baseline.
    det.notify_final(speaker=0, text="So tell me about your last project")
    await asyncio.sleep(qd_mod.SPEAKER_TURN_MIN_GAP_S + 0.1)
    # Second final from a different speaker (candidate) with substantive text.
    det.notify_final(speaker=1, text="Sure, I worked on a payments system that")
    await asyncio.sleep(0.1)
    assert "speaker_turn" in triggered


async def test_speaker_turn_skipped_on_backchannel(monkeypatch: pytest.MonkeyPatch) -> None:
    det, rec = _make_detector(monkeypatch)
    monkeypatch.setattr(settings, "question_detection_silence_ms", 2000)
    monkeypatch.setattr(settings, "question_detection_ceiling_ms", 5000)
    triggered: list[str] = []

    async def fake_run(triggered_by: str = "idle") -> None:
        triggered.append(triggered_by)
        det._cancel_timers()

    monkeypatch.setattr(det, "_run", fake_run)
    det.notify_final(speaker=0, text="So describe a time you disagreed with a manager")
    await asyncio.sleep(qd_mod.SPEAKER_TURN_MIN_GAP_S + 0.1)
    # Candidate emits a backchannel — should NOT fire speaker_turn.
    det.notify_final(speaker=1, text="Yeah")
    await asyncio.sleep(0.2)
    assert "speaker_turn" not in triggered


async def test_speaker_turn_skipped_on_rapid_alternation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    det, rec = _make_detector(monkeypatch)
    monkeypatch.setattr(settings, "question_detection_silence_ms", 2000)
    monkeypatch.setattr(settings, "question_detection_ceiling_ms", 5000)
    triggered: list[str] = []

    async def fake_run(triggered_by: str = "idle") -> None:
        triggered.append(triggered_by)
        det._cancel_timers()

    monkeypatch.setattr(det, "_run", fake_run)
    det.notify_final(speaker=0, text="So tell me about your last project")
    # Immediately flip — gap is < SPEAKER_TURN_MIN_GAP_S.
    det.notify_final(speaker=1, text="That's interesting, I have a question myself")
    await asyncio.sleep(0.2)
    assert "speaker_turn" not in triggered


async def test_backend_dedup_within_cooldown(monkeypatch: pytest.MonkeyPatch) -> None:
    det, rec = _make_detector(monkeypatch)
    det._last_question = "What is your favorite programming language?"
    det._last_question_at = time.time()
    monkeypatch.setattr(settings, "question_detection_dedup_cooldown_s", 4.0)
    # Exact match within cooldown → dup.
    assert det._is_recent_duplicate("What is your favorite programming language?")
    # Case + whitespace differences are still a dup.
    assert det._is_recent_duplicate(
        "  what is your favorite programming language?  "
    )
    # Different question is not a dup.
    assert not det._is_recent_duplicate("Tell me about a time you disagreed.")


async def test_backend_dedup_expires_after_cooldown(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    det, _rec = _make_detector(monkeypatch)
    det._last_question = "What is your favorite color?"
    det._last_question_at = time.time() - 10.0
    monkeypatch.setattr(settings, "question_detection_dedup_cooldown_s", 4.0)
    assert not det._is_recent_duplicate("What is your favorite color?")


async def test_fallback_activates_on_429(monkeypatch: pytest.MonkeyPatch) -> None:
    det, rec = _make_detector(monkeypatch)
    monkeypatch.setattr(
        settings, "question_detection_fallback_model", "gpt-4o-mini"
    )

    async def gemini_quota_error(_u: list[Utterance], _m: str) -> dict[str, Any]:
        raise RuntimeError("429 RESOURCE_EXHAUSTED: free-tier quota")

    async def openai_qd(_u: list[Utterance], model: str) -> dict[str, Any]:
        return {
            "is_question": True,
            "extracted_question": "What's your favorite language?",
            "confidence": 0.9,
        }

    monkeypatch.setattr(det, "_call_gemini_with_usage", gemini_quota_error)
    monkeypatch.setattr(det, "_call_openai_qd_with_usage", openai_qd)
    # Make sure the routing actually believes openai is available.
    det._openai_client = object()  # type: ignore[assignment]

    result = await det._call_qd_llm([], "gemini-2.5-flash-lite")
    assert result["is_question"] is True
    assert det._fallback_active is True
    # Subsequent call must route straight through OpenAI (no Gemini retry).
    gemini_calls = {"n": 0}

    async def gemini_explode(_u: list[Utterance], _m: str) -> dict[str, Any]:
        gemini_calls["n"] += 1
        raise RuntimeError("should not be called")

    monkeypatch.setattr(det, "_call_gemini_with_usage", gemini_explode)
    # Next call's model_snapshot must reflect the active fallback model.
    result2 = await det._call_qd_llm([], det._effective_qd_model())
    assert result2["is_question"] is True
    assert gemini_calls["n"] == 0
    # And the fallback callback was fired exactly once.
    # (The task is fire-and-forget; await it so the recording fires.)
    if det._fallback_notify_task is not None:
        await det._fallback_notify_task
    assert rec.fallbacks == ["gpt-4o-mini"]


async def test_user_pick_openai_routes_directly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A user picking gpt-4o-mini in the dropdown shouldn't go through
    Gemini at all — no 429-and-retry cost."""
    det, _rec = _make_detector(monkeypatch)
    det.set_model("gpt-4o-mini")
    gemini_calls = {"n": 0}

    async def gemini_explode(_u: list[Utterance], _m: str) -> dict[str, Any]:
        gemini_calls["n"] += 1
        raise RuntimeError("should not be called")

    async def openai_qd(_u: list[Utterance], model: str) -> dict[str, Any]:
        assert model == "gpt-4o-mini"
        return {
            "is_question": True,
            "extracted_question": "Hi",
            "confidence": 0.95,
        }

    monkeypatch.setattr(det, "_call_gemini_with_usage", gemini_explode)
    monkeypatch.setattr(det, "_call_openai_qd_with_usage", openai_qd)
    det._openai_client = object()  # type: ignore[assignment]
    result = await det._call_qd_llm([], "gpt-4o-mini")
    assert result["is_question"] is True
    assert gemini_calls["n"] == 0
    # Fallback flag should stay clean — user picked OpenAI, this isn't a
    # quota fallback.
    assert det._fallback_active is False


async def test_set_model_clears_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    det, _rec = _make_detector(monkeypatch)
    det._fallback_active = True
    det._fallback_notified = True
    ok = det.set_model("gemini-2.5-flash")
    assert ok is True
    assert det._fallback_active is False
    assert det._fallback_notified is False


def test_set_model_rejects_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    det, _rec = _make_detector(monkeypatch)
    assert det.set_model("gpt-5-omega") is False
    assert det.set_model("gemini-2.5-flash") is True
    assert det.set_model("gpt-4o-mini") is True


# ─── Phase 2 fixes: lock + probe + OpenAI 429 + Redis-persisted fallback ────


async def test_run_lock_prevents_concurrent_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two competing notify_final calls (speaker-turn + a timer firing in
    the same tick) must not produce two parallel _run executions."""
    det, _rec = _make_detector(monkeypatch)
    run_count = 0
    in_flight = 0
    max_in_flight = 0

    async def fake_run(triggered_by: str = "idle") -> None:
        nonlocal run_count, in_flight, max_in_flight
        run_count += 1
        in_flight += 1
        max_in_flight = max(max_in_flight, in_flight)
        await asyncio.sleep(0.05)
        in_flight -= 1
        det._cancel_timers()

    monkeypatch.setattr(det, "_run", fake_run)
    # Bypass the gap filter so both calls really try to fire.
    det._last_speaker = 0
    det._last_speaker_change_at = 0.0
    # Two near-simultaneous triggers.
    det._start_run("speaker_turn")
    det._start_run("idle")
    # Give both spawners time to acquire the lock.
    await asyncio.sleep(0.15)
    assert max_in_flight == 1, f"two _run instances ran in parallel: {max_in_flight}"
    # Second spawner sees _run_task in-flight and bails — only one execution.
    assert run_count == 1


async def test_probe_re_arms_gemini_after_recovery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    det, _rec = _make_detector(monkeypatch)
    det._fallback_active = True
    det._fallback_call_count = 999  # well past probe interval
    monkeypatch.setattr(settings, "question_detection_probe_interval", 10)

    gemini_calls = {"n": 0}

    async def gemini_ok(_u: list[Utterance], _m: str) -> dict[str, Any]:
        gemini_calls["n"] += 1
        return {
            "is_question": True,
            "extracted_question": "Gemini back",
            "confidence": 0.9,
        }

    monkeypatch.setattr(det, "_call_gemini_with_usage", gemini_ok)
    # Set user pref to a Gemini model so the probe path runs.
    det.set_model("gemini-2.5-flash-lite")
    det._fallback_active = True  # set_model cleared it; re-set for the test
    det._fallback_call_count = 999

    result = await det._call_qd_llm([], "gpt-4o-mini")
    assert result["is_question"] is True
    assert gemini_calls["n"] == 1
    # Probe success lifts the fallback flag.
    assert det._fallback_active is False
    assert det._fallback_call_count == 0


async def test_probe_still_429_keeps_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the probe also 429s, fallback stays armed and the call still
    succeeds via OpenAI."""
    det, _rec = _make_detector(monkeypatch)
    det.set_model("gemini-2.5-flash-lite")
    det._fallback_active = True
    det._fallback_call_count = 999
    monkeypatch.setattr(settings, "question_detection_probe_interval", 10)

    async def gemini_429(_u: list[Utterance], _m: str) -> dict[str, Any]:
        raise RuntimeError("429 RESOURCE_EXHAUSTED")

    async def openai_ok(_u: list[Utterance], _m: str) -> dict[str, Any]:
        return {
            "is_question": True,
            "extracted_question": "From OpenAI",
            "confidence": 0.9,
        }

    monkeypatch.setattr(det, "_call_gemini_with_usage", gemini_429)
    monkeypatch.setattr(det, "_call_openai_qd_with_usage", openai_ok)
    det._openai_client = object()  # type: ignore[assignment]

    result = await det._call_qd_llm([], "gpt-4o-mini")
    assert result["is_question"] is True
    assert det._fallback_active is True
    # Probe counter was reset so we wait another N calls before probing.
    assert det._fallback_call_count == 0


async def test_openai_429_emits_qd_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """When OpenAI is also rate-limited, the detector emits on_error and
    returns an empty result so the caller can surface a 'paused' state."""
    det, rec = _make_detector(monkeypatch)
    monkeypatch.setattr(
        settings, "question_detection_fallback_model", "gpt-4o-mini"
    )

    async def gemini_429(_u: list[Utterance], _m: str) -> dict[str, Any]:
        raise RuntimeError("429 RESOURCE_EXHAUSTED on Gemini")

    class _FakeOpenAIClient:
        class _Chat:
            class _Completions:
                @staticmethod
                async def create(**_: Any) -> Any:
                    raise RuntimeError("429 RESOURCE_EXHAUSTED on OpenAI too")

            completions = _Completions()

        chat = _Chat()

    det._openai_client = _FakeOpenAIClient()  # type: ignore[assignment]
    monkeypatch.setattr(det, "_call_gemini_with_usage", gemini_429)

    result = await det._call_qd_llm([], "gemini-2.5-flash-lite")
    assert result == {}
    # Both providers failed → on_error was called.
    assert rec.errors == ["both_providers_unavailable"]
    assert det._openai_unhealthy is True


async def test_model_snapshot_immune_to_concurrent_set_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An in-flight call must use the model we snapshotted, even if the
    user races a set_qd_model in the middle of the call."""
    det, _rec = _make_detector(monkeypatch)
    det.set_model("gemini-2.5-flash-lite")

    seen_models: list[str] = []

    async def slow_gemini(_u: list[Utterance], m: str) -> dict[str, Any]:
        seen_models.append(m)
        await asyncio.sleep(0.05)
        return {"is_question": False, "confidence": 0.1, "extracted_question": None}

    monkeypatch.setattr(det, "_call_gemini_with_usage", slow_gemini)

    # Start a call with the snapshotted model.
    snapshot = "gemini-2.5-flash-lite"
    call_task = asyncio.create_task(det._call_qd_llm([], snapshot))
    # Race: user picks a different model mid-flight.
    await asyncio.sleep(0.01)
    det.set_model("gpt-4o")
    await call_task
    # The Gemini call must have used the snapshot, not the new pick.
    assert seen_models == ["gemini-2.5-flash-lite"]


# ─── Phase 3 fixes: dedup signal + prior-answer wiring + interrogative ──────


def test_short_interrogative_passes_backchannel() -> None:
    """The carve-out: short questions ending in '?' shouldn't be classified
    as backchannel so they still trigger speaker-turn detection."""
    assert _looks_backchannel("How so?") is False
    assert _looks_backchannel("Why?") is False
    assert _looks_backchannel("Like what?") is False
    # Without the question mark they're still filtered.
    assert _looks_backchannel("How so") is True
    assert _looks_backchannel("why") is True


async def test_dedup_emits_signal(monkeypatch: pytest.MonkeyPatch) -> None:
    """When backend dedup rejects a detected question, on_dedup fires
    so the UI can show a subtle 'heard it' pulse."""
    det, rec = _make_detector(monkeypatch)
    det._last_question = "What's your name?"
    det._last_question_at = time.time()  # within cooldown
    monkeypatch.setattr(settings, "question_detection_dedup_cooldown_s", 4.0)

    await det._notify_dedup("What's your name?")
    assert rec.dedups == ["What's your name?"]


# ─── stale closure / entry index ────────────────────────────────────────────
# (Frontend logic; tested via unit tests in apps/web/tests when present.
# These are placeholders documenting the contracts the Python side enforces.)


async def test_probe_uses_snapshotted_model_under_concurrent_set_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A concurrent set_model arriving mid-probe must not change which
    Gemini model the in-flight probe call uses."""
    det, _rec = _make_detector(monkeypatch)
    det.set_model("gemini-2.5-flash-lite")
    det._fallback_active = True
    det._fallback_call_count = 999
    monkeypatch.setattr(settings, "question_detection_probe_interval", 10)
    monkeypatch.setattr(
        settings, "question_detection_fallback_model", "gpt-4o-mini"
    )

    probed_with: list[str] = []

    async def slow_gemini(_u: list[Utterance], m: str) -> dict[str, Any]:
        probed_with.append(m)
        await asyncio.sleep(0.05)
        return {
            "is_question": False,
            "extracted_question": None,
            "confidence": 0.1,
        }

    monkeypatch.setattr(det, "_call_gemini_with_usage", slow_gemini)

    call = asyncio.create_task(det._call_qd_llm([], "gpt-4o-mini"))
    await asyncio.sleep(0.01)
    # Race: user switches to gpt-4o mid-probe. Must NOT change the model
    # that the in-flight Gemini call is using.
    det.set_model("gpt-4o")
    await call
    assert probed_with == ["gemini-2.5-flash-lite"]


async def test_repick_same_model_clears_backend_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Re-picking the currently-active model via set_qd_model clears the
    sticky fallback flag — gives the user a way to force a retry."""
    det, _rec = _make_detector(monkeypatch)
    det.set_model("gemini-2.5-flash-lite")
    det._fallback_active = True
    det._fallback_notified = True
    det._openai_unhealthy = True
    # Re-pick same model.
    ok = det.set_model("gemini-2.5-flash-lite")
    assert ok is True
    assert det._fallback_active is False
    assert det._fallback_notified is False
    assert det._openai_unhealthy is False


async def test_set_model_persists_redis_clear(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """set_model must persist the cleared fallback state to Redis so a
    later WS reconnect doesn't restore stale fallback. Regression test
    for the B3 race."""
    det, _rec = _make_detector(monkeypatch)
    written: list[str | None] = []

    async def capture_write(_sid: str, model: str | None) -> None:
        written.append(model)

    monkeypatch.setattr(qd_mod, "set_qd_fallback", capture_write)
    # Put the detector into fallback (as if Gemini 429'd earlier).
    det._fallback_active = True
    det._fallback_notified = True
    # User picks a new model.
    assert det.set_model("gemini-2.5-flash") is True
    # Wait for the persist task to settle.
    if det._persist_fallback_task is not None:
        await det._persist_fallback_task
    # Redis was told to clear the fallback marker.
    assert written == [None]


async def test_set_model_no_persist_when_not_in_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When not in fallback, set_model shouldn't write to Redis at all
    (idle clear is wasteful)."""
    det, _rec = _make_detector(monkeypatch)
    written: list[str | None] = []

    async def capture_write(_sid: str, model: str | None) -> None:
        written.append(model)

    monkeypatch.setattr(qd_mod, "set_qd_fallback", capture_write)
    assert det._fallback_active is False
    assert det.set_model("gemini-2.5-flash") is True
    if det._persist_fallback_task is not None:
        await det._persist_fallback_task
    assert written == []


async def test_persist_fallback_serializes_redis_writes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Activate-then-clear must hit Redis in that exact order, even if
    the activate write is slow."""
    det, _rec = _make_detector(monkeypatch)
    write_order: list[str | None] = []

    async def slow_set(_sid: str, model: str | None) -> None:
        # Activate is intentionally slower to expose any ordering bug.
        await asyncio.sleep(0.05 if model is not None else 0.01)
        write_order.append(model)

    monkeypatch.setattr(qd_mod, "set_qd_fallback", slow_set)

    det._activate_fallback("quota")
    det._clear_fallback("test_clear")
    # Both writes scheduled; wait for the last one to complete.
    if det._persist_fallback_task is not None:
        await det._persist_fallback_task
    assert write_order == ["gpt-4o-mini", None]


async def test_close_does_not_hang_on_slow_callback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """close() must complete within CLOSE_TIMEOUT_S even if _on_question
    is slow (e.g. backed up WS send queue)."""
    det, _rec = _make_detector(monkeypatch)

    async def slow_question(_q: str, _c: float, _f: bool) -> None:
        await asyncio.sleep(30)  # well beyond CLOSE_TIMEOUT_S

    det._on_question = slow_question
    # Spawn a fake "in-flight" run task so close() has something to await.
    det._run_task = asyncio.create_task(slow_question("q", 0.9, False))
    # Use a tiny timeout for the test so it doesn't actually wait 5s.
    monkeypatch.setattr(qd_mod, "CLOSE_TIMEOUT_S", 0.1)
    start = time.time()
    await det.close()
    elapsed = time.time() - start
    assert elapsed < 1.0, f"close() took {elapsed:.2f}s, should be < CLOSE_TIMEOUT_S"


async def test_claude_pick_routes_to_claude(monkeypatch: pytest.MonkeyPatch) -> None:
    """A Claude QD pick must reach the Claude transport, not Gemini/OpenAI."""
    det, _rec = _make_detector(monkeypatch)
    assert det.set_model("claude-haiku-4-5") is True

    seen: list[str] = []

    async def fake_claude(utterances: list[Utterance], model: str) -> dict[str, Any]:
        seen.append(model)
        return {"is_question": True, "confidence": 0.9, "extracted_question": "q?"}

    monkeypatch.setattr(det, "_call_claude_qd_with_usage", fake_claude)
    result = await det._call_qd_llm([Utterance(text="hi", speaker=None)], det._effective_qd_model())
    assert seen == ["claude-haiku-4-5"]
    assert result["is_question"] is True


async def test_explicit_gpt4o_pick_is_not_downgraded(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Picking gpt-4o must run gpt-4o. The quota fallback exists for a Gemini
    pick that 429'd; letting it rewrite an explicit OpenAI pick to the cheaper
    gpt-4o-mini silently downgrades what the user chose."""
    det, _rec = _make_detector(monkeypatch)
    det.set_model("gpt-4o")
    det._fallback_active = True
    assert det._effective_qd_model() == "gpt-4o"
    assert det._should_probe_gemini() is False


async def test_gemini_pick_still_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    """The flip side: a Gemini pick in fallback DOES route to the fallback
    model — that path must keep working."""
    det, _rec = _make_detector(monkeypatch)
    det.set_model("gemini-2.5-flash-lite")
    det._fallback_active = True
    assert det._effective_qd_model() == settings.question_detection_fallback_model


async def test_claude_pick_survives_gemini_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    """A stale Gemini-quota fallback must not hijack an explicit Claude pick —
    Claude has its own credential and its own quota."""
    det, _rec = _make_detector(monkeypatch)
    det.set_model("claude-opus-5-5")
    # Simulate a fallback that was armed before the user switched to Claude.
    det._fallback_active = True
    assert det._effective_qd_model() == "claude-opus-5-5"
    # ...and it never wastes a probe on Gemini.
    assert det._should_probe_gemini() is False
