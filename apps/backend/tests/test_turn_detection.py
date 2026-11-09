from __future__ import annotations

import asyncio
import time
from typing import Any, cast

import pytest

from app.prompts.question_detection import (
    ThreadContext,
    Utterance,
    question_detection_user_prompt,
)
from app.providers.deepgram_flux import FluxTurnEvent, flux_query, parse_turn_info
from app.services.keyterms import extract_keyterms
from app.services.question_detection import (
    Classification,
    QuestionDetector,
    normalize_classification,
)
from app.services.turn_detection import TurnCoordinator, is_echo, looks_dangling
from app.settings import settings


class FakeDetector:
    """Stands in for QuestionDetector's classifier API."""

    def __init__(self, verdicts: dict[str, Classification], delay: float = 0.0) -> None:
        self.verdicts = verdicts
        self.delay = delay
        self.calls: list[list[Utterance]] = []
        self.remembered: list[str] = []
        self._last_question: str | None = None
        self._last_question_at = 0.0
        self.fail: Exception | None = None
        self.failures_reported = 0

    async def classify(self, utterances: Any, **_: Any) -> Classification:
        self.calls.append(list(utterances))
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.fail is not None:
            raise self.fail
        latest = " ".join(u.text for u in utterances if u.latest)
        return self.verdicts.get(latest, _verdict("none", None))

    def _is_recent_duplicate(self, q: str) -> bool:
        return bool(self.remembered) and self.remembered[-1] == q

    async def report_call_failed(self) -> None:
        self.failures_reported += 1

    def remember_question(self, q: str) -> None:
        self.remembered.append(q)
        self._last_question = q
        self._last_question_at = time.time()


def _verdict(kind: str, q: str | None, conf: float = 0.95) -> Classification:
    return Classification(kind=kind, question=q, confidence=conf, reasoning="t", model="m")  # type: ignore[arg-type]


def _ev(event: str, text: str = "", turn: int = 0, trigger: str | None = None) -> FluxTurnEvent:
    return FluxTurnEvent(
        event=event,
        turn_index=turn,
        transcript=text,
        end_of_turn_confidence=0.9,
        audio_window_start=0.0,
        audio_window_end=1.0,
        trigger=trigger,
    )


class Harness:
    def __init__(self, detector: FakeDetector, rows: list[dict[str, Any]] | None = None) -> None:
        self.events: list[dict[str, Any]] = []
        self.finals: list[dict[str, Any]] = []
        self.rows = rows or []
        self.forced = 0
        self.coord = TurnCoordinator(
            "s",
            cast(QuestionDetector, detector),
            emit=self.emit,
            append_final=self.append,
            recent_entries=self.recent,
            force_end_interviewer=self.force,
        )

    async def emit(self, e: dict[str, Any]) -> None:
        self.events.append(e)

    async def append(self, row: dict[str, Any]) -> None:
        self.finals.append(row)
        self.rows.append(row)

    async def recent(self, _w: float) -> list[dict[str, Any]]:
        return list(self.rows)

    async def force(self) -> None:
        self.forced += 1

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e["type"] == kind]


Q = "Tell me about a time you led a project."


def _interviewer_paused(h: "Harness") -> None:
    """Pretend the interviewer's last new word was a second ago."""
    h.coord._last_word_at = time.time() - 1.0


async def _settle() -> None:
    for _ in range(5):
        await asyncio.sleep(0)


async def test_eager_then_end_confirms_same_candidate() -> None:
    h = Harness(FakeDetector({Q: _verdict("new_question", Q)}))
    await h.coord.on_interviewer(_ev("StartOfTurn"))
    await h.coord.on_interviewer(_ev("Update", Q))
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", Q))
    # Raw candidate goes out immediately, before the classifier answers…
    [raw] = h.of("question_candidate")
    assert raw["provisional"] is True
    await _settle()
    # …then the verdict relabels the same candidate.
    _raw, verdict = h.of("question_candidate")
    assert verdict["candidate_id"] == raw["candidate_id"] and verdict["question"] == Q
    await h.coord.on_interviewer(_ev("EndOfTurn", Q))
    [done] = h.of("question_detected")
    assert done["candidate_id"] == raw["candidate_id"]
    assert h.finals[-1]["source"] == "interviewer" and h.finals[-1]["is_final"]


async def test_turn_resumed_retracts_then_rejudges() -> None:
    longer = "Tell me about a time you led a project that failed."
    det = FakeDetector({Q: _verdict("new_question", Q), longer: _verdict("new_question", longer)})
    h = Harness(det)
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", Q))
    await _settle()
    cand = h.of("question_candidate")[-1]
    await h.coord.on_interviewer(_ev("TurnResumed", Q))
    [retracted] = h.of("question_retracted")
    assert retracted["candidate_id"] == cand["candidate_id"]
    await h.coord.on_interviewer(_ev("EndOfTurn", longer))
    [done] = h.of("question_detected")
    assert done["question"] == longer
    assert done["candidate_id"] != cand["candidate_id"]


async def test_end_of_turn_during_slow_judgement_delivers_directly() -> None:
    h = Harness(FakeDetector({Q: _verdict("new_question", Q)}, delay=0.05))
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", Q))
    await asyncio.sleep(0)
    await h.coord.on_interviewer(_ev("EndOfTurn", Q))
    await asyncio.sleep(0.1)
    [raw] = h.of("question_candidate")  # only the raw one; verdict came after EOT
    [done] = h.of("question_detected")
    assert done["candidate_id"] == raw["candidate_id"]


async def test_classifier_failure_is_reported_to_ui() -> None:
    det = FakeDetector({})
    det.fail = RuntimeError("Error code: 401 - Incorrect API key provided")
    h = Harness(det)
    await h.coord.on_interviewer(_ev("EndOfTurn", Q))
    await _settle()
    # The failure reaches the client as qd_error instead of a silent drop.
    assert det.failures_reported == 1
    assert h.of("question_detected") == []


async def test_not_a_question_emits_nothing() -> None:
    text = "Great, thanks for that overview."
    h = Harness(FakeDetector({}))
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", text))
    await _settle()
    await h.coord.on_interviewer(_ev("EndOfTurn", text))
    assert h.of("question_candidate") == [] and h.of("question_detected") == []


async def test_small_talk_and_low_confidence_do_not_fire() -> None:
    hi = "Hi, can you hear me okay?"
    unsure = "So what would you do there?"
    det = FakeDetector(
        {hi: _verdict("small_talk", hi), unsure: _verdict("new_question", unsure, 0.5)}
    )
    h = Harness(det)
    for text in (hi, unsure):
        await h.coord.on_interviewer(_ev("EndOfTurn", text))
    assert h.of("question_detected") == []


async def test_backchannel_turn_skips_classifier() -> None:
    det = FakeDetector({})
    h = Harness(det)
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", "Okay."))
    await h.coord.on_interviewer(_ev("EndOfTurn", "Okay."))
    assert det.calls == []


async def test_dangling_eager_waits_for_end_of_turn() -> None:
    text = "And I'd like to hear about your"
    det = FakeDetector({})
    h = Harness(det)
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", text))
    await _settle()
    assert det.calls == []  # no speculation on a dangling tail
    await h.coord.on_interviewer(_ev("EndOfTurn", text, trigger="timeout"))
    assert len(det.calls) == 1  # still judged once the turn really ends


async def test_follow_up_kind_sets_flag() -> None:
    q = "How would that scale?"
    h = Harness(FakeDetector({q: _verdict("follow_up", q)}))
    await h.coord.on_interviewer(_ev("EndOfTurn", q))
    [done] = h.of("question_detected")
    assert done["is_follow_up"] is True and done["kind"] == "follow_up"


async def test_duplicate_question_not_refired() -> None:
    h = Harness(FakeDetector({Q: _verdict("new_question", Q)}))
    await h.coord.on_interviewer(_ev("EndOfTurn", Q, turn=0))
    await h.coord.on_interviewer(_ev("EndOfTurn", Q, turn=1))
    assert len(h.of("question_detected")) == 1


async def test_context_rows_and_latest_marking() -> None:
    rows = [{"text": "Question number two.", "source": "interviewer"}]
    det = FakeDetector({Q: _verdict("new_question", Q)})
    h = Harness(det, rows=rows)
    await h.coord.on_interviewer(_ev("EndOfTurn", Q))
    [call] = det.calls
    # Stored EndOfTurn row isn't duplicated; only the judged turn is latest.
    assert [u.text for u in call] == ["Question number two.", Q]
    assert [u.latest for u in call] == [False, True]
    assert all(u.role == "interviewer" for u in call)


async def test_candidate_speech_forces_end_once() -> None:
    h = Harness(FakeDetector({}))
    await h.coord.on_interviewer(_ev("StartOfTurn"))
    await h.coord.on_interviewer(_ev("Update", "Design a rate limiter for an API gateway."))
    _interviewer_paused(h)
    await h.coord.on_candidate(_ev("Update", "Sure, so I would start"))
    await h.coord.on_candidate(_ev("Update", "Sure, so I would start with a token bucket"))
    assert h.forced == 1


@pytest.mark.parametrize(
    "candidate_text",
    [
        "Mm-hmm.",  # backchannel
        "Yeah okay",  # too short
        "design a rate limiter for an API gateway",  # echo of the interviewer
    ],
)
async def test_candidate_noise_does_not_force_end(candidate_text: str) -> None:
    h = Harness(FakeDetector({}))
    await h.coord.on_interviewer(_ev("StartOfTurn"))
    await h.coord.on_interviewer(_ev("Update", "Design a rate limiter for an API gateway."))
    _interviewer_paused(h)
    await h.coord.on_candidate(_ev("Update", candidate_text))
    assert h.forced == 0


async def test_candidate_speech_after_turn_end_does_not_force() -> None:
    h = Harness(FakeDetector({}))
    await h.coord.on_interviewer(_ev("EndOfTurn", "Thanks."))
    await h.coord.on_candidate(_ev("Update", "So my approach would be the following"))
    assert h.forced == 0


async def test_candidate_final_stored_with_role() -> None:
    h = Harness(FakeDetector({}))
    await h.coord.on_candidate(_ev("EndOfTurn", "I'd use a token bucket."))
    assert h.finals[-1]["source"] == "candidate"


async def test_question_then_monologue_hits_checkpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "question_detection_ceiling_ms", 50)
    q = "How would you shard this database?"
    narrated = f"{q} Take your time, there's no rush, think it through"
    h = Harness(FakeDetector({narrated: _verdict("new_question", q)}))
    await h.coord.on_interviewer(_ev("StartOfTurn"))
    await h.coord.on_interviewer(_ev("Update", q))
    await h.coord.on_interviewer(_ev("Update", narrated))
    await asyncio.sleep(0.15)
    [done] = h.of("question_detected")
    assert done["question"] == q


async def test_speculation_disabled_waits_for_end() -> None:
    h = Harness(FakeDetector({Q: _verdict("new_question", Q)}))
    h.coord._speculate = False
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", Q))
    await _settle()
    assert h.of("question_candidate") == []
    await h.coord.on_interviewer(_ev("EndOfTurn", Q))
    assert len(h.of("question_detected")) == 1


# ─── helpers ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("text", "dangling"),
    [
        ("Tell me about your", True),
        ("I want to hear about the project and", True),
        ("Tell me about your project.", False),
        ("Why", False),
    ],
)
def test_looks_dangling(text: str, dangling: bool) -> None:
    assert looks_dangling(text) is dangling


def test_is_echo() -> None:
    assert is_echo("design a rate limiter", "Design a rate limiter for an API gateway.")
    assert not is_echo("I would use a token bucket", "Design a rate limiter.")


def test_normalize_v1_and_v2() -> None:
    v2 = normalize_classification(
        {"kind": "addendum", "is_question": True, "extracted_question": "Q", "confidence": 0.9},
        "m",
    )
    assert v2.kind == "addendum" and v2.is_follow_up and v2.has_kind
    v1 = normalize_classification(
        {"is_question": True, "extracted_question": "Q", "confidence": 0.9}, "m"
    )
    assert v1.kind == "new_question" and not v1.has_kind
    bad = normalize_classification({"kind": "weird", "confidence": "x"}, "m")
    assert bad.kind == "none" and bad.confidence == 0.0


def test_prompt_labels_roles_thread_and_latest() -> None:
    prompt = question_detection_user_prompt(
        [
            Utterance(text="I'd use a hash map.", role="candidate"),
            Utterance(text="And the complexity?", role="interviewer", latest=True),
        ],
        thread=ThreadContext(question="Find duplicates in an array.", answer_excerpt="Use a set."),
    )
    assert "[1, Candidate] I'd use a hash map." in prompt
    assert "[2, Interviewer] (latest) And the complexity?" in prompt
    assert "question: Find duplicates in an array." in prompt


def test_prompt_infers_latest_without_marks() -> None:
    prompt = question_detection_user_prompt(["Question two.", "What is a deadlock?"])
    assert "[2] (latest) What is a deadlock?" in prompt


def test_parse_turn_info_and_query() -> None:
    ev = parse_turn_info(
        {
            "type": "TurnInfo",
            "event": "EndOfTurn",
            "turn_index": 3,
            "transcript": " Why? ",
            "words": [{"word": "why", "confidence": 0.9, "start": 1.0, "end": 1.2}],
            "end_of_turn_confidence": 0.91,
            "audio_window_start": 0.5,
            "audio_window_end": 1.4,
            "trigger": "model",
        }
    )
    assert ev is not None and ev.transcript == "Why?" and ev.trigger == "model"
    assert ev.words[0].end == 1.2
    assert parse_turn_info({"type": "Connected"}) is None
    q = flux_query(keyterms=["Kubernetes", "C++"], eager=True)
    assert ("keyterm", "Kubernetes") in q and ("keyterm", "C++") in q
    assert any(k == "eager_eot_threshold" for k, _ in q)
    assert not any(k == "eager_eot_threshold" for k, _ in flux_query(eager=False))


def test_extract_keyterms() -> None:
    terms = extract_keyterms(
        {
            "company": "Stripe",
            "job_title": "Senior Backend Engineer (Go, gRPC)",
            "resume_text": (
                "Built services in TypeScript and Node.js on AWS EC2 with PostgreSQL. "
                "Migrated to Kubernetes; owned CI/CD. Used PostgreSQL and C++ daily. "
                "Led a Team of 5 in January 2023."
            ),
        }
    )
    assert terms[0] == "Stripe"
    for expected in ("gRPC", "TypeScript", "Node.js", "AWS", "EC2", "PostgreSQL", "CI/CD", "C++"):
        assert expected in terms, expected
    for noise in ("Led", "Team", "January", "Built"):
        assert noise not in terms
    assert extract_keyterms(None) == []


async def test_silent_update_after_end_does_not_open_turn() -> None:
    h = Harness(FakeDetector({}))
    await h.coord.on_interviewer(_ev("EndOfTurn", "Thanks.", turn=0))
    # Flux keeps streaming empty Updates (with the next index) in silence.
    await h.coord.on_interviewer(_ev("Update", "", turn=1))
    await h.coord.on_candidate(_ev("Update", "So my approach would be the following"))
    assert h.forced == 0


async def test_raw_candidate_dropped_when_not_a_question() -> None:
    text = "How about we take a short break here."
    h = Harness(FakeDetector({}))  # verdict: none
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", text))
    [raw] = h.of("question_candidate")
    await _settle()
    [retracted] = h.of("question_retracted")
    assert retracted["candidate_id"] == raw["candidate_id"]
    await h.coord.on_interviewer(_ev("EndOfTurn", text))
    assert h.of("question_detected") == []


async def test_raw_candidate_restarted_for_follow_up() -> None:
    text = "And what's the space complexity?"
    full = "What's the space complexity of the hash-set solution?"
    h = Harness(FakeDetector({text: _verdict("follow_up", full)}))
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", text))
    await _settle()
    raw, fixed = h.of("question_candidate")
    [retracted] = h.of("question_retracted")
    assert retracted["candidate_id"] == raw["candidate_id"]
    assert fixed["candidate_id"] != raw["candidate_id"] and fixed["is_follow_up"] is True
    await h.coord.on_interviewer(_ev("EndOfTurn", text))
    [done] = h.of("question_detected")
    assert done["candidate_id"] == fixed["candidate_id"]


async def test_raw_candidate_restarted_when_question_spans_turns() -> None:
    tail = "how would you go about debugging it?"
    full = "If a service suddenly started timing out under load, how would you debug it?"
    h = Harness(FakeDetector({tail: _verdict("new_question", full)}))
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", tail))
    await _settle()
    raw, fixed = h.of("question_candidate")
    assert fixed["candidate_id"] != raw["candidate_id"] and fixed["question"] == full


async def test_statement_turn_waits_for_verdict() -> None:
    text = "Great, thanks for sharing that."
    h = Harness(FakeDetector({}))
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", text))
    assert h.of("question_candidate") == []  # no raw speculation on a statement


async def test_raw_follow_up_guess_keeps_answer_when_right() -> None:
    text = "And what's the space complexity?"
    full = "What's the space complexity of the hash-set solution?"
    det = FakeDetector({text: _verdict("follow_up", full)})
    det.remember_question("Find duplicates in an array.")  # live thread
    h = Harness(det)
    await h.coord.on_interviewer(_ev("EagerEndOfTurn", text))
    [raw] = h.of("question_candidate")
    assert raw["is_follow_up"] is True
    await _settle()
    assert h.of("question_retracted") == []  # guess was right: no restart
    await h.coord.on_interviewer(_ev("EndOfTurn", text))
    [done] = h.of("question_detected")
    assert done["candidate_id"] == raw["candidate_id"] and done["question"] == full


def test_guess_follow_up() -> None:
    from app.services.turn_detection import guess_follow_up

    assert guess_follow_up("And how would that scale?", True)
    assert guess_follow_up("Why?", True)
    assert not guess_follow_up("Why?", False)  # no live thread
    assert not guess_follow_up(
        "Okay, switching gears. Tell me about the hardest bug you have ever fixed in production.",
        True,
    )


async def test_stale_candidate_transcript_does_not_chop_interviewer() -> None:
    """Flux resends the candidate's cumulative turn transcript until that
    turn closes. Words already said before the interviewer cut in must not
    count as "the candidate took the floor" (they chopped the interviewer's
    question into fragments in a live run)."""
    h = Harness(FakeDetector({}))
    answer = "Sure, at my last company we shipped without load testing"
    await h.coord.on_candidate(_ev("StartOfTurn", "Sure,"))
    await h.coord.on_candidate(_ev("Update", answer))
    # Interviewer cuts in while the candidate's turn is still open.
    await h.coord.on_interviewer(_ev("StartOfTurn", "", turn=1))
    await h.coord.on_interviewer(_ev("Update", "Great, thanks. Next, how would", turn=1))
    _interviewer_paused(h)
    await h.coord.on_candidate(_ev("Update", answer))  # stale resend
    await h.coord.on_candidate(_ev("Update", answer + " so"))  # 1 new word
    assert h.forced == 0
    # The candidate genuinely starts talking again → that does count.
    await h.coord.on_candidate(_ev("Update", answer + " so what I would do is"))
    assert h.forced == 1


async def test_new_candidate_turn_counts_from_zero() -> None:
    h = Harness(FakeDetector({}))
    await h.coord.on_candidate(_ev("EndOfTurn", "That's my answer for that one."))
    await h.coord.on_interviewer(_ev("StartOfTurn", "", turn=1))
    await h.coord.on_interviewer(_ev("Update", "How would you scale it", turn=1))
    _interviewer_paused(h)
    await h.coord.on_candidate(_ev("StartOfTurn", "So"))
    await h.coord.on_candidate(_ev("Update", "So I would shard by user"))
    assert h.forced == 1


async def test_candidate_side_speech_ignored_while_interviewer_talking() -> None:
    """Room audio on the mic (TV, another person) overlaps the interviewer
    mid-sentence; it must not end their turn."""
    h = Harness(FakeDetector({}))
    await h.coord.on_interviewer(_ev("StartOfTurn"))
    await h.coord.on_interviewer(_ev("Update", "So for this next part I want you to"))
    await h.coord.on_candidate(_ev("Update", "honey did you see the news about the game"))
    assert h.forced == 0
    _interviewer_paused(h)
    await h.coord.on_candidate(_ev("Update", "honey did you see the news about the game tonight"))
    assert h.forced == 1
