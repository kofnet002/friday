"""Flux-driven question detection with speculative answers.

Replaces the silence timers of QuestionDetector (still used on the nova-3
path) with Deepgram Flux's semantic end-of-turn events, plus our own guards:

    interviewer stream (system audio, Flux with eager EOT)
      StartOfTurn ─► Update… ─► EagerEndOfTurn ─► EndOfTurn
                                   │                 │
                     judge now ────┘                 └─► confirm
                     question_candidate (answer streams hidden on the client)
                                   │
                     TurnResumed ──┴─► question_retracted (client drops it)

    candidate stream (mic, Flux)
      speech that isn't a backchannel or echo while the interviewer's turn is
      open ─► ForceEndTurn on the interviewer stream (they've stopped; the
      candidate is answering)

Guards layered on Flux:
- Filler turns ("okay", "mm-hmm") and turns that end mid-phrase ("…and")
  are not speculated on.
- Question checkpoint: an interviewer who asks and then keeps narrating
  never ends their turn; a "?" sentence left standing for
  QUESTION_DETECTION_CEILING_MS gets judged anyway.
- Dedup (exact repeat within the cooldown) and the classifier's own
  "restatement of the current thread → none" rule.

Wire events (to the client on /ws/transcribe):
- ``question_candidate`` {candidate_id, question, confidence, is_follow_up, kind}
- ``question_retracted`` {candidate_id}
- ``question_detected``  {candidate_id, question, confidence, is_follow_up, kind}
  — either confirms a candidate (same id) or is a fresh, non-speculative
  question.
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from app.logging import log
from app.providers.deepgram_flux import FluxTurnEvent
from app.services import latency
from app.services.question_detection import (
    FOLLOW_UP_WINDOW_S,
    Classification,
    QuestionDetector,
    _looks_backchannel,
    utterances_from_entries,
)
from app.settings import settings

Emit = Callable[[dict[str, Any]], Awaitable[None]]
AppendFinal = Callable[[dict[str, Any]], Awaitable[None]]
RecentEntries = Callable[[float], Awaitable[list[dict[str, Any]]]]
ForceEnd = Callable[[], Awaitable[None]]

# Candidate speech must have at least this many words before we treat it as
# "the candidate took the floor" (shorter is usually a backchannel).
CANDIDATE_FLOOR_MIN_WORDS = 3
# Share of candidate words also heard from the interviewer in the last few
# seconds above which the mic line is treated as echo leaking past AEC.
ECHO_OVERLAP_THRESHOLD = 0.6
ECHO_LOOKBACK_S = 12.0
# The interviewer must have produced no new words for this long before
# candidate-side speech may end their turn. A real candidate answers after
# the interviewer pauses; other voices the mic picks up (a TV, someone in the
# room — seen in a live run) talk OVER the interviewer.
INTERVIEWER_PAUSE_FOR_FORCE_S = 0.6

# A turn ending in one of these is mid-phrase even if Flux thinks it's done.
_DANGLING_TAIL = frozenset(
    {
        "and",
        "or",
        "but",
        "so",
        "if",
        "that",
        "which",
        "when",
        "while",
        "because",
        "for",
        "to",
        "a",
        "an",
        "the",
        "of",
        "at",
        "in",
        "on",
        "with",
        "from",
        "about",
        "like",
        "as",
        "your",
        "my",
        "is",
        "are",
    }
)
_WORD_RE = re.compile(r"[a-z0-9']+")
# Phrasing that marks a turn as a likely question/request — enough to start
# answering the raw turn before the classifier rules (see _on_eager).
_ASK_RE = re.compile(
    r"\?|\b(what|why|how|when|where|which|who|can you|could you|would you|will you|"
    r"do you|did you|have you|are you|is there|tell me|walk me|talk me|describe|"
    r"explain|design|implement|write|give me|talk about|share|elaborate)\b",
    re.IGNORECASE,
)


def looks_dangling(text: str) -> bool:
    """True if the turn ends mid-phrase ("…tell me about your", "…and")."""
    s = text.strip()
    if not s or s[-1] in ".?!":
        return False
    last = s.rsplit(" ", 1)[-1].rstrip(",;:-").lower()
    return last in _DANGLING_TAIL


def _words(text: str) -> list[str]:
    return _WORD_RE.findall(text.lower())


def looks_like_ask(text: str) -> bool:
    return bool(_ASK_RE.search(text))


_CONTINUATION_RE = re.compile(
    r"^\s*(okay,?\s+|ok,?\s+|right,?\s+|so,?\s+)?"
    r"(and|so|but|what about|how about|why|then|also|what if|could you elaborate|"
    r"can you elaborate|say more|go deeper)\b",
    re.IGNORECASE,
)
FOLLOW_UP_GUESS_MAX_WORDS = 12


def guess_follow_up(text: str, thread_active: bool) -> bool:
    """Cheap pre-verdict guess: with a live thread, a short turn or one that
    opens with a continuation ("And…", "What about…", "Why…") is probably a
    follow-up. Only steers the raw speculative answer — the classifier still
    decides, and a wrong guess restarts the answer."""
    if not thread_active:
        return False
    return bool(_CONTINUATION_RE.match(text)) or len(_words(text)) <= FOLLOW_UP_GUESS_MAX_WORDS


def covers(raw: str, question: str) -> bool:
    """True when the raw turn already contains (nearly) all of the
    reconstructed question — i.e. an answer started from the raw turn is
    answering the right thing."""
    want = [w for w in _words(question) if len(w) > 2]
    if not want:
        return True
    have = set(_words(raw))
    return sum(1 for w in want if w in have) / len(want) >= 0.8


def is_echo(candidate_text: str, interviewer_text: str) -> bool:
    """True when most of the candidate line was just said by the interviewer
    — the mic picked up the speakers despite echo cancellation."""
    cand = [w for w in _words(candidate_text) if len(w) > 2]
    if not cand:
        return False
    heard = {w for w in _words(interviewer_text) if len(w) > 2}
    overlap = sum(1 for w in cand if w in heard) / len(cand)
    return overlap >= ECHO_OVERLAP_THRESHOLD


@dataclass
class _Speculation:
    turn_index: int
    transcript: str
    candidate_id: str
    task: asyncio.Task[None] | None = None
    verdict: Classification | None = None
    emitted: bool = False  # question_candidate sent
    raw: bool = False  # emitted with the raw turn text, before the verdict
    raw_follow_up: bool = False  # the raw candidate was sent as a follow-up
    confirmed: bool = False  # EndOfTurn arrived for this turn
    delivered: bool = False  # question_detected sent


class TurnCoordinator:
    def __init__(
        self,
        session_id: str,
        detector: QuestionDetector,
        *,
        emit: Emit,
        append_final: AppendFinal,
        recent_entries: RecentEntries,
        force_end_interviewer: ForceEnd,
        speculate: bool = True,
    ) -> None:
        self.session_id = session_id
        self._detector = detector
        self._emit = emit
        self._append_final = append_final
        self._recent_entries = recent_entries
        self._force_end_interviewer = force_end_interviewer
        self._speculate = speculate

        self._turn_active = False
        self._turn_index = -1
        self._turn_transcript = ""
        self._last_word_at: float | None = None
        self._spec: _Speculation | None = None
        self._forced_turn: int | None = None
        self._checkpoint: asyncio.Task[None] | None = None
        self._checkpoint_qmarks = 0
        self._interviewer_recent: list[tuple[float, str]] = []
        # Candidate speech of the turn in progress (not yet final). Passed
        # to the classifier: "the candidate started answering" is strong
        # evidence the question was complete.
        self._candidate_live = ""
        # Words of `_candidate_live` already spoken when the current
        # interviewer turn began. Flux resends the candidate's cumulative
        # transcript until their turn closes, so only words past this mark
        # are new speech.
        self._candidate_baseline = 0
        self._state = "idle"
        self._closed = False

    # ─── interviewer stream ────────────────────────────────────────────────

    async def on_interviewer(self, ev: FluxTurnEvent) -> None:
        if self._closed:
            return
        if ev.event == "StartOfTurn":
            self._begin_turn(ev)
            await self._set_state("listening")
        elif ev.event == "Update":
            # Flux keeps sending (empty) Updates through silence, already
            # carrying the NEXT turn index — only speech opens a turn.
            if not ev.transcript:
                return
            if not self._turn_active:
                self._begin_turn(ev)
            if ev.transcript and ev.transcript != self._turn_transcript:
                self._turn_transcript = ev.transcript
                self._last_word_at = ev.received_at
                await self._emit(self._transcript_row(ev.transcript, "interviewer", final=False))
                self._maybe_arm_checkpoint(ev.turn_index, ev.transcript)
        elif ev.event == "EagerEndOfTurn":
            await self._on_eager(ev)
        elif ev.event == "TurnResumed":
            await self._retract("turn_resumed")
            await self._set_state("listening")
        elif ev.event == "EndOfTurn":
            await self._on_end_of_turn(ev)

    def _begin_turn(self, ev: FluxTurnEvent) -> None:
        self._candidate_baseline = len(_words(self._candidate_live))
        self._turn_active = True
        self._turn_index = ev.turn_index
        self._turn_transcript = ""
        self._checkpoint_qmarks = 0
        self._cancel_checkpoint()

    async def _on_eager(self, ev: FluxTurnEvent) -> None:
        text = ev.transcript
        if not self._speculate or not self._worth_judging(text):
            return
        if looks_dangling(text):
            log.info("turn.eager_skip_dangling", session_id=self.session_id, tail=text[-40:])
            return
        await self._retract("superseded")
        spec = _Speculation(
            turn_index=ev.turn_index, transcript=text, candidate_id=uuid.uuid4().hex
        )
        latency.mark(spec.candidate_id, "last_word", self._last_word_at)
        latency.mark(spec.candidate_id, "eager", ev.received_at)
        self._spec = spec
        # A classifier round trip costs ~1 s even on a fast model, so for a
        # turn that reads like a question, start answering the raw turn NOW
        # and let the verdict confirm, correct or drop it.
        if looks_like_ask(text) and not self._is_duplicate(text):
            spec.emitted = spec.raw = True
            spec.raw_follow_up = guess_follow_up(text, self._thread_active())
            latency.mark(spec.candidate_id, "candidate")
            await self._emit(
                {
                    "type": "question_candidate",
                    "candidate_id": spec.candidate_id,
                    "question": text,
                    "confidence": 0.0,
                    "is_follow_up": spec.raw_follow_up,
                    "kind": "follow_up" if spec.raw_follow_up else "new_question",
                    "provisional": True,
                }
            )
        spec.task = asyncio.create_task(self._run_speculation(spec))

    async def _run_speculation(self, spec: _Speculation) -> None:
        await self._set_state("detecting")
        verdict = await self._judge(spec.transcript)
        latency.mark(spec.candidate_id, "judged")
        spec.verdict = verdict
        if self._spec is not spec:
            return  # retracted or superseded while judging
        if (
            verdict is None
            or not verdict.answerable
            or verdict.question is None
            or self._is_duplicate(verdict.question)
        ):
            await self._drop_raw(spec, "not_a_question")
            if spec.confirmed:
                self._spec = None
                await self._set_state("idle")
            return
        if spec.raw and not self._raw_still_valid(spec, verdict):
            # The raw answer is answering the wrong thing (a follow-up needs
            # the thread; a question spanning earlier turns needs them) —
            # restart it under a new id with the real question.
            await self._drop_raw(spec, "corrected")
            spec.candidate_id = uuid.uuid4().hex
            latency.mark(spec.candidate_id, "last_word", self._last_word_at)
        if spec.confirmed:
            await self._deliver(spec.candidate_id, verdict, spec.turn_index)
            spec.delivered = True
            self._spec = None
            await self._set_state("idle")
            return
        # New candidate, or the raw one again with the reconstructed question
        # (same id → the client just relabels the answer already streaming).
        spec.emitted = True
        latency.mark(spec.candidate_id, "candidate")
        await self._emit(self._question_event("question_candidate", spec.candidate_id, verdict))

    def _raw_still_valid(self, spec: _Speculation, verdict: Classification) -> bool:
        """Can the answer started from the raw turn stand? It must be routed
        the same way (thread vs new), and a new question must be fully in
        the raw text — a follow-up is answered with the thread as context,
        so its reconstruction naturally adds words the raw turn lacks."""
        assert verdict.question is not None
        if verdict.is_follow_up != spec.raw_follow_up:
            return False
        return verdict.is_follow_up or covers(spec.transcript, verdict.question)

    def _thread_active(self) -> bool:
        last_at = getattr(self._detector, "_last_question_at", 0.0)
        return bool(getattr(self._detector, "_last_question", None)) and (
            time.time() - last_at <= FOLLOW_UP_WINDOW_S
        )

    async def _drop_raw(self, spec: _Speculation, reason: str) -> None:
        if not (spec.raw and spec.emitted and not spec.delivered):
            spec.raw = False
            return
        log.info("turn.raw_dropped", session_id=self.session_id, reason=reason)
        await self._emit({"type": "question_retracted", "candidate_id": spec.candidate_id})
        latency.discard(spec.candidate_id)
        spec.emitted = spec.raw = False

    async def _on_end_of_turn(self, ev: FluxTurnEvent) -> None:
        # trigger: model (Flux decided) | manual (ForceEndTurn) | timeout.
        log.info(
            "turn.end",
            session_id=self.session_id,
            turn=ev.turn_index,
            trigger=ev.trigger,
            eot_confidence=round(ev.end_of_turn_confidence, 2),
        )
        self._turn_active = False
        self._cancel_checkpoint()
        text = ev.transcript or self._turn_transcript
        if text:
            row = self._transcript_row(text, "interviewer", final=True)
            await self._append_final(row)
            await self._emit(row)
            self._remember_interviewer(text)

        spec = self._spec
        if spec is not None and spec.turn_index == ev.turn_index and spec.transcript == text:
            spec.confirmed = True
            latency.mark(spec.candidate_id, "eot", ev.received_at)
            if spec.task is not None and spec.task.done():
                if spec.emitted and spec.verdict is not None and not spec.delivered:
                    await self._deliver(spec.candidate_id, spec.verdict, spec.turn_index)
                    spec.delivered = True
                self._spec = None
                await self._set_state("idle")
            # else: _run_speculation delivers when the verdict lands.
            return
        if spec is not None:
            await self._retract("transcript_changed")

        if not self._worth_judging(text):
            await self._set_state("idle")
            return
        cid = uuid.uuid4().hex
        latency.mark(cid, "last_word", self._last_word_at)
        latency.mark(cid, "eot", ev.received_at)
        await self._set_state("detecting")
        verdict = await self._judge(text)
        latency.mark(cid, "judged")
        if verdict is not None and verdict.answerable and verdict.question is not None:
            if not self._is_duplicate(verdict.question):
                await self._deliver(cid, verdict, ev.turn_index)
        else:
            latency.discard(cid)
        await self._set_state("idle")

    # ─── candidate stream (mic) ────────────────────────────────────────────

    async def on_candidate(self, ev: FluxTurnEvent) -> None:
        if self._closed:
            return
        if ev.event == "StartOfTurn":
            # A fresh candidate turn: its transcript restarts from zero.
            self._candidate_live = ""
            self._candidate_baseline = 0
        if ev.event in ("StartOfTurn", "Update", "EagerEndOfTurn") and ev.transcript:
            self._candidate_live = ev.transcript
            await self._emit(self._transcript_row(ev.transcript, "candidate", final=False))
            await self._maybe_force_end(ev.transcript)
        elif ev.event == "EndOfTurn":
            self._candidate_live = ""
            self._candidate_baseline = 0
            if not ev.transcript:
                return
            row = self._transcript_row(ev.transcript, "candidate", final=True)
            await self._append_final(row)
            await self._emit(row)

    async def _maybe_force_end(self, candidate_text: str) -> None:
        if not self._turn_active or self._forced_turn == self._turn_index:
            return
        if (
            self._last_word_at is not None
            and time.time() - self._last_word_at < INTERVIEWER_PAUSE_FOR_FORCE_S
        ):
            return  # interviewer still mid-sentence
        # Judge only what the candidate said after the interviewer started.
        new_words = _words(candidate_text)[self._candidate_baseline :]
        if len(new_words) < CANDIDATE_FLOOR_MIN_WORDS:
            return
        new_text = " ".join(new_words)
        if _looks_backchannel(new_text):
            return
        if is_echo(new_text, self._recent_interviewer_text()):
            log.info("turn.candidate_echo_ignored", session_id=self.session_id)
            return
        self._forced_turn = self._turn_index
        log.info("turn.force_end", session_id=self.session_id, turn=self._turn_index)
        await self._force_end_interviewer()

    # ─── question checkpoint (asked, then kept talking) ────────────────────

    def _maybe_arm_checkpoint(self, turn_index: int, transcript: str) -> None:
        qmarks = transcript.count("?")
        if qmarks <= self._checkpoint_qmarks:
            return
        self._checkpoint_qmarks = qmarks
        self._cancel_checkpoint()
        self._checkpoint = asyncio.create_task(self._checkpoint_after(turn_index))

    async def _checkpoint_after(self, turn_index: int) -> None:
        try:
            await asyncio.sleep(settings.question_detection_ceiling_ms / 1000)
        except asyncio.CancelledError:
            return
        if not self._turn_active or self._turn_index != turn_index or self._spec is not None:
            return
        text = self._turn_transcript
        log.info("turn.checkpoint", session_id=self.session_id, turn=turn_index)
        cid = uuid.uuid4().hex
        latency.mark(cid, "last_word", self._last_word_at)
        verdict = await self._judge(text)
        if (
            verdict is not None
            and verdict.answerable
            and verdict.question is not None
            and not self._is_duplicate(verdict.question)
            and self._turn_index == turn_index
        ):
            await self._deliver(cid, verdict, turn_index)
        else:
            latency.discard(cid)

    def _cancel_checkpoint(self) -> None:
        task = self._checkpoint
        self._checkpoint = None
        if task is not None and not task.done() and task is not asyncio.current_task():
            task.cancel()

    # ─── shared ────────────────────────────────────────────────────────────

    def _worth_judging(self, text: str) -> bool:
        if not text.strip():
            return False
        if _looks_backchannel(text):
            log.info("turn.skip_backchannel", session_id=self.session_id, text=text[:40])
            return False
        return True

    async def _judge(self, turn_text: str) -> Classification | None:
        """Classify `turn_text` as the latest interviewer turn, with the
        recent transcript (both roles) as context."""
        try:
            entries = await self._recent_entries(
                float(settings.question_detection_transcript_window_s)
            )
        except Exception:  # noqa: BLE001
            entries = []
        # The EndOfTurn row may already be stored; don't list it twice.
        if (
            entries
            and entries[-1].get("source") == "interviewer"
            and str(entries[-1].get("text") or "").strip() == turn_text.strip()
        ):
            entries = entries[:-1]
        rows = [*entries, {"text": turn_text, "source": "interviewer"}]
        latest = len(rows) - 1
        live = self._candidate_live.strip()
        if live and not is_echo(live, turn_text):
            rows.append({"text": live, "source": "candidate"})
        try:
            return await self._detector.classify(utterances_from_entries(rows, latest_from=latest))
        except Exception as exc:  # noqa: BLE001
            log.error("turn.judge_failed", session_id=self.session_id, error=str(exc))
            # Same signal as the timer path: without it the UI shows the raw
            # candidate, then retracts it with no hint that the model failed.
            await self._detector.report_call_failed()
            return None

    def _is_duplicate(self, question: str) -> bool:
        if self._detector._is_recent_duplicate(question):
            log.info("turn.skip_dup", session_id=self.session_id)
            return True
        return False

    async def _deliver(self, candidate_id: str, verdict: Classification, turn_index: int) -> None:
        assert verdict.question is not None
        self._detector.remember_question(verdict.question)
        latency.mark(candidate_id, "confirmed")
        await self._emit(self._question_event("question_detected", candidate_id, verdict))

    async def _retract(self, reason: str) -> None:
        spec = self._spec
        self._spec = None
        if spec is None:
            return
        if spec.task is not None and not spec.task.done():
            spec.task.cancel()
        if spec.emitted and not spec.delivered:
            log.info("turn.retract", session_id=self.session_id, reason=reason)
            await self._emit({"type": "question_retracted", "candidate_id": spec.candidate_id})
        latency.discard(spec.candidate_id)

    def _question_event(
        self, kind: str, candidate_id: str, verdict: Classification
    ) -> dict[str, Any]:
        return {
            "type": kind,
            "candidate_id": candidate_id,
            "question": verdict.question,
            "confidence": verdict.confidence,
            "is_follow_up": verdict.is_follow_up,
            "kind": verdict.kind,
        }

    def _transcript_row(self, text: str, source: str, *, final: bool) -> dict[str, Any]:
        return {
            "type": "transcript",
            "is_final": final,
            "text": text,
            "confidence": 1.0,
            "speaker": None,
            "source": source,
            "timestamp": time.time(),
        }

    def _remember_interviewer(self, text: str) -> None:
        now = time.time()
        self._interviewer_recent.append((now, text))
        self._interviewer_recent = [
            (t, s) for t, s in self._interviewer_recent if now - t <= ECHO_LOOKBACK_S
        ]

    def _recent_interviewer_text(self) -> str:
        now = time.time()
        past = " ".join(s for t, s in self._interviewer_recent if now - t <= ECHO_LOOKBACK_S)
        return f"{past} {self._turn_transcript}"

    async def _set_state(self, state: str) -> None:
        if state == self._state:
            return
        self._state = state
        await self._emit({"type": "qd_state", "state": state})

    async def close(self) -> None:
        self._closed = True
        self._cancel_checkpoint()
        spec = self._spec
        self._spec = None
        if spec is not None and spec.task is not None and not spec.task.done():
            spec.task.cancel()
