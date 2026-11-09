from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable, Coroutine, Sequence
from dataclasses import dataclass
from typing import Any, Literal, cast

from google import genai
from google.genai import types as genai_types
from openai import AsyncOpenAI

from app.logging import log
from app.prompts.follow_up_classification import (
    FOLLOW_UP_SYSTEM_PROMPT,
    follow_up_user_prompt,
)
from app.prompts.question_detection import (
    ANSWERABLE_KINDS,
    QUESTION_DETECTION_SYSTEM_PROMPT,
    QuestionKind,
    ThreadContext,
    Utterance,
    question_detection_user_prompt,
)
from app.redis_client import (
    get_last_answer,
    get_qd_fallback,
    recent_transcript_entries,
    set_qd_fallback,
)
from app.services.claude_agent_auth import claude_available
from app.services.claude_api import claude_transport, complete_claude_api
from app.services.usage import record_qd_call
from app.settings import settings

# (question, confidence, is_follow_up)
QuestionCallback = Callable[[str, float, bool], Awaitable[None]]

# Backchannel utterances that trigger the speaker label to flip without
# actually being a meaningful new turn. When the new speaker says only one
# of these, we ignore the speaker-turn trigger and wait for the timers.
BACKCHANNEL_UTTERANCES: frozenset[str] = frozenset(
    {
        "yeah",
        "yes",
        "yep",
        "yup",
        "right",
        "okay",
        "ok",
        "uh-huh",
        "uh huh",
        "mm-hmm",
        "mhm",
        "mm",
        "hmm",
        "sure",
        "gotcha",
        "got it",
        "i see",
        "cool",
        "nice",
        "no",
        "nope",
    }
)
# Speaker-turn trigger requires the prior speaker change to be at least
# this old. Filters out rapid-fire alternations where one party is just
# backchanneling over the other.
SPEAKER_TURN_MIN_GAP_S = 0.6


def _safe_json_dict(text: str, *, log_key: str) -> dict[str, Any]:
    """Parse a JSON object string; return empty dict on any failure."""
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        log.warning(log_key, raw=text[:300])
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _strip_json_fence(text: str) -> str:
    """Drop a ```json … ``` wrapper if the model added one.

    Gemini and OpenAI are pinned to a JSON response mode, so their replies are
    always bare. Claude has no such mode here — the prompts ask for JSON only,
    but a stray fence would otherwise fail the parse silently.
    """
    body = text.strip()
    if not body.startswith("```"):
        return body
    body = body.split("\n", 1)[1] if "\n" in body else ""
    return body.rsplit("```", 1)[0].strip()


@dataclass(frozen=True)
class Classification:
    """Normalized classifier verdict."""

    kind: QuestionKind
    question: str | None
    confidence: float
    reasoning: str | None
    model: str
    # False for a v1-shaped reply (no `kind`) — its follow-up flag still
    # needs the separate classifier.
    has_kind: bool = True

    @property
    def answerable(self) -> bool:
        return (
            self.kind in ANSWERABLE_KINDS
            and bool(self.question)
            and self.confidence >= settings.question_detection_min_confidence
        )

    @property
    def is_follow_up(self) -> bool:
        return self.kind in ("follow_up", "addendum")


_KINDS: frozenset[str] = frozenset(
    {"new_question", "follow_up", "addendum", "small_talk", "none"}
)


def normalize_classification(raw: dict[str, Any], model: str) -> Classification:
    """Map the classifier JSON onto a Classification. Tolerates the v1 shape
    (no `kind`): is_question → new_question, else none — the caller then runs
    the legacy follow-up classifier for v1-shaped answers."""
    kind_raw = raw.get("kind")
    is_question = bool(raw.get("is_question"))
    if kind_raw in _KINDS:
        kind = cast(QuestionKind, kind_raw)
    else:
        kind = "new_question" if is_question else "none"
    extracted = raw.get("extracted_question")
    question = str(extracted).strip() if extracted else None
    try:
        confidence = float(raw.get("confidence") or 0.0)
    except (TypeError, ValueError):
        confidence = 0.0
    reasoning = raw.get("reasoning")
    return Classification(
        kind=kind,
        question=question or None,
        confidence=confidence,
        reasoning=str(reasoning) if reasoning else None,
        model=model,
        has_kind=kind_raw in _KINDS,
    )


def utterances_from_entries(
    entries: Sequence[dict[str, Any]], *, latest_from: int | None = None
) -> list[Utterance]:
    """Build classifier lines from Redis transcript rows. Rows carry `source`
    ("interviewer" / "candidate") on the dual-stream path and a diarized
    `speaker` id on the single-stream path. `latest_from` marks interviewer
    rows from that index onward as the turn being judged."""
    out: list[Utterance] = []
    for i, entry in enumerate(entries):
        sp_raw = entry.get("speaker")
        source = entry.get("source")
        out.append(
            Utterance(
                text=str(entry.get("text") or ""),
                speaker=sp_raw if isinstance(sp_raw, int) else None,
                role=source if source in ("interviewer", "candidate") else None,
                latest=latest_from is not None and i >= latest_from and source != "candidate",
            )
        )
    return out


def _looks_backchannel(text: str) -> bool:
    """True if `text` is essentially a brief filler/agreement — too short
    or too generic to count as the candidate taking the floor.

    Carve-out for short interrogatives: "How so?", "Why?", "Like what?"
    are legitimate follow-up signals from the interviewer; don't filter
    them. We detect by trailing "?" since Deepgram's punctuate=true adds
    it when the prosody is question-like.
    """
    raw = text.strip()
    s = raw.lower().rstrip(".!?,")
    if not s:
        return True
    if s in BACKCHANNEL_UTTERANCES:
        return True
    # Short interrogative escape hatch: any text ending in "?" is not
    # backchannel even if it's only 1-2 tokens.
    if raw.endswith("?"):
        return False
    # Anything ≤ 2 tokens that isn't already a known backchannel still has
    # a high chance of being one ("oh wow", "you know"). Bias toward false
    # negatives — speaker-turn is an aggressive trigger.
    if len(s.split()) <= 2:
        return True
    return False


def _is_quota_error(exc: BaseException) -> bool:
    """True if the exception looks like a Gemini free-tier quota / rate-limit
    error. We match on text so we don't have to import google.api_core just
    for the exception class — google-genai surfaces these as generic
    google.genai.errors.ServerError or APIError with status text in the body.
    """
    s = str(exc)
    return "RESOURCE_EXHAUSTED" in s or " 429" in s or s.startswith("429")

# Lifecycle states reported to the client so the Listen panel can show a
# "Listening / Analyzing" indicator.
QDState = Literal["idle", "listening", "detecting"]
# Coroutine (not just Awaitable) because we pass the result to
# asyncio.create_task for fire-and-forget delivery.
StateCallback = Callable[[QDState], Coroutine[Any, Any, None]]

# Fired once when the detector falls back from Gemini to GPT-4o due to
# Gemini quota exhaustion. The client uses this to surface a small badge so
# the user knows their dropdown pick is being overridden.
FallbackCallback = Callable[[str], Coroutine[Any, Any, None]]

# Fired when both Gemini and the fallback model are unavailable. Lets the
# UI distinguish "QD silently broke" from "QD switched models".
ErrorCallback = Callable[[str], Coroutine[Any, Any, None]]

# Fired when a detected question was dropped because it matched a recently
# fired one. Useful for surfacing "we saw this, didn't re-ask" without
# spamming the answer panel.
DedupCallback = Callable[[str], Coroutine[Any, Any, None]]

# Maximum time we'll wait for in-flight tasks to settle during close()
# before forcibly moving on. Keeps WS teardown from hanging on a slow
# _on_question callback.
CLOSE_TIMEOUT_S = 5.0

# What caused this detection run. The mid-thought guard is only consulted for
# "idle" runs — if the ceiling fired or the speaker changed, we already have
# strong external signal that the question is complete enough to grade.
TriggeredBy = Literal["idle", "ceiling", "speaker_turn"]

# Models the user is allowed to pick for question detection. Kept short on
# purpose — anything outside this set is rejected with a warning. Both
# Gemini (default) and OpenAI options are accepted so a power user can
# pre-emptively pick gpt-4o-mini when Gemini's free-tier quota is
# exhausted, rather than waiting for the first 429.
ALLOWED_QD_MODELS: frozenset[str] = frozenset(
    {
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gpt-4o-mini",
        "gpt-4o",
        # Claude. Unlike the others these need no API key when a Claude Code
        # subscription token is configured — the CLI transport bills the
        # subscription. Haiku is the sane pick here: QD fires every few
        # seconds and the CLI adds seconds of process startup per call, so
        # Opus turns detection into a laggard. Both are offered because the
        # user owns the cost/quality/latency tradeoff.
        "claude-haiku-4-5",
        "claude-opus-5-5",
    }
)


def _is_openai_qd_model(model: str) -> bool:
    return model.startswith("gpt-")


def _is_claude_qd_model(model: str) -> bool:
    return model.startswith("claude-")


def _is_gemini_qd_model(model: str) -> bool:
    return model.startswith("gemini-")

# How recent the prior question must be for follow-up classification to fire.
# Interviewers don't usually wait minutes between a question and its
# follow-up; beyond this window the new question is overwhelmingly a topic
# shift, and skipping the classifier saves the Flash-Lite call.
FOLLOW_UP_WINDOW_S = 90.0
# Confidence threshold for treating a classifier result as a follow-up. Below
# this we fall back to is_follow_up=False — opening a new thread is the safer
# default since the user can always merge later.
FOLLOW_UP_MIN_CONFIDENCE = 0.75

# Trailing tokens that strongly indicate the speaker is mid-thought. If the
# newest utterance ends with one of these, we skip detection this round and
# wait for a later final that completes the phrase.
MID_THOUGHT_TAIL_WORDS = frozenset(
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
        "is",
        "was",
        "are",
        "were",
        "have",
        "has",
        "had",
        "do",
        "does",
        "did",
        "you",
        "your",
        "my",
    }
)
TERMINAL_PUNCT = {".", "?", "!"}


def _looks_mid_thought(text: str) -> bool:
    """True if the utterance looks incomplete — no terminal punctuation, or
    it ends with a conjunction / preposition / auxiliary."""
    s = text.strip()
    if not s:
        return True
    if s[-1] in TERMINAL_PUNCT:
        return False
    last_word = s.rsplit(" ", 1)[-1].rstrip(",;:").lower()
    if last_word in MID_THOUGHT_TAIL_WORDS:
        return True
    # No terminal punctuation and not obviously a complete-short interjection
    # (e.g. "okay", "right") — treat as mid-thought. Deepgram with
    # punctuate=true adds terminal punctuation when it believes the sentence
    # is done, so the absence is a strong signal.
    return True


class QuestionDetector:
    """Debounced question-detection per session.

    Each final transcript arms two timers:

    1. **Idle timer** (`silence_ms`) — resets on every new final. Fires when the
       speaker pauses, matching the classic "wait for silence" heuristic.
    2. **Ceiling timer** (`ceiling_ms`) — armed once on the first unprocessed
       final and never reset. Fires even if the speaker keeps talking without
       pausing, catching the "interviewer asks, then keeps narrating" case.

    A speaker change (e.g. interviewer → candidate) bypasses both timers and
    fires detection immediately on the prior tail.

    At most one detection is in flight per session. The mid-thought guard
    still gates the idle path so we don't burn a Flash call on an obviously
    incomplete utterance — but it's skipped for ceiling/speaker_turn runs
    where the timing itself is the completeness signal.
    """

    def __init__(
        self,
        session_id: str,
        on_question: QuestionCallback,
        on_state: StateCallback | None = None,
        on_fallback: FallbackCallback | None = None,
        on_error: ErrorCallback | None = None,
        on_dedup: DedupCallback | None = None,
    ) -> None:
        self.session_id = session_id
        self._on_question = on_question
        self._on_state = on_state
        self._on_fallback = on_fallback
        self._on_error = on_error
        self._on_dedup = on_dedup
        # Single lock guarding _run_task creation. Speaker-turn and timer
        # paths both create the task; without serialization a two-tick
        # race could spawn two concurrent _run coroutines.
        self._run_lock = asyncio.Lock()
        self._idle_task: asyncio.Task[None] | None = None
        self._ceiling_task: asyncio.Task[None] | None = None
        self._run_task: asyncio.Task[None] | None = None
        # Holds the most recent _start_run spawner so it can't be GC'd
        # mid-await (RUF006). Spawners are short-lived (one lock acquire).
        self._spawn_task: asyncio.Task[None] | None = None
        self._client = (
            genai.Client(api_key=settings.gemini_api_key)
            if settings.gemini_api_key
            else None
        )
        # OpenAI client for the quota-exhaustion fallback path. Lazy-built
        # like the Gemini one so QD still works with only one key set.
        self._openai_client = (
            AsyncOpenAI(api_key=settings.openai_api_key)
            if settings.openai_api_key
            else None
        )
        # Sticky once Gemini returns 429 — every QD + follow-up call routes
        # through the configured fallback model until the user manually
        # picks a different QD model OR the periodic probe re-arms Gemini.
        self._fallback_active: bool = False
        self._fallback_notified: bool = False
        # Counts successful fallback calls. Every N (probe_interval) we
        # try Gemini again to see if quota has recovered. Resets to 0 on
        # set_model() or after a successful probe.
        self._fallback_call_count: int = 0
        # Marks the OpenAI side as unhealthy. When BOTH providers are out,
        # we set this + emit qd_error so the UI knows detection is dead.
        # Cleared when set_model() succeeds.
        self._openai_unhealthy: bool = False
        # Last fired question + when. Used to decide whether to run the
        # follow-up classifier and to feed it the prior-question context.
        # Reset on session close (instance lifetime == ws connection).
        self._last_question: str | None = None
        self._last_question_at: float = 0.0
        # Last speaker label we observed on a final. None until diarization
        # produces its first labelled segment. A change from N to M (both
        # non-None) is the speaker-turn trigger.
        self._last_speaker: int | None = None
        # When the last speaker change fired. Combined with
        # SPEAKER_TURN_MIN_GAP_S to filter rapid alternations from
        # backchannelling.
        self._last_speaker_change_at: float = 0.0
        # Per-session model override. When None, falls back to
        # settings.question_detection_model. Set via set_model().
        self._model_override: str | None = None
        # Last state we reported via on_state. We deduplicate so we don't
        # spam the WS with redundant transitions.
        self._state: QDState = "idle"
        # Separate strong refs for the two fire-and-forget callback chains
        # so a state notification can't get GC'd by a fallback notification
        # arriving in the same tick (RUF006).
        self._state_notify_task: asyncio.Task[None] | None = None
        self._fallback_notify_task: asyncio.Task[None] | None = None
        # Strong ref for the Redis persistence task spawned on activate/clear.
        self._persist_fallback_task: asyncio.Task[None] | None = None

    @property
    def _model(self) -> str:
        return self._model_override or settings.question_detection_model

    def _effective_qd_model(self) -> str:
        """Resolve the model that will actually serve the next QD call.

        - A Gemini pick that has 429'd routes to the configured fallback model.
        - Any other explicit pick is honored exactly as selected.

        The quota fallback only makes sense for a Gemini pick, because Gemini
        is the only model that can 429 us into it. An explicit OpenAI or Claude
        pick has its own credential and its own quota, so overriding it would
        silently downgrade the user's choice — picking `gpt-4o` and quietly
        getting `gpt-4o-mini` is a quality regression nobody asked for.
        """
        if self._fallback_active and _is_gemini_qd_model(self._model):
            return settings.question_detection_fallback_model
        return self._model

    def set_model(self, model: str) -> bool:
        """User picked a different QD model. Returns True if accepted.

        Also clears the quota-fallback flag — the user is making an explicit
        choice, so honor it even if we previously fell back to GPT-4o. If
        Gemini is still rate-limited we'll just fall back again on the next
        call.
        """
        if model not in ALLOWED_QD_MODELS:
            log.warning(
                "question_detection.model_rejected",
                session_id=self.session_id,
                model=model,
            )
            return False
        was_in_fallback = self._fallback_active
        self._model_override = model
        self._fallback_active = False
        self._fallback_notified = False
        self._fallback_call_count = 0
        self._openai_unhealthy = False
        # If we were in fallback, the Redis-persisted state still says so.
        # Without this clear, a subsequent WS reconnect would call
        # restore_persistent_state and reactivate fallback for the new
        # detector even though the user just explicitly retried Gemini.
        if was_in_fallback:
            self._spawn_persist(None)
        log.info(
            "question_detection.model_set",
            session_id=self.session_id,
            model=model,
        )
        return True

    def notify_final(
        self,
        speaker: int | None = None,
        text: str | None = None,
    ) -> None:
        """A final transcript just arrived; arm timers (or fire immediately
        on speaker turn).

        `text` is the utterance from the new speaker — used to filter out
        backchannel turns ("yeah", "uh-huh") that shouldn't trigger
        detection.
        """
        # Speaker-turn fast path: if diarization has labelled both this and
        # the previous final and the labels differ, the interviewer just
        # stopped and someone else (likely the candidate) started — fire
        # detection on the tail without waiting for silence.
        if (
            speaker is not None
            and self._last_speaker is not None
            and speaker != self._last_speaker
        ):
            now = time.time()
            gap = now - self._last_speaker_change_at
            is_backchannel = text is not None and _looks_backchannel(text)
            # Treat short or backchannel turns as noise — let the timers
            # decide instead of firing immediately on "uh-huh".
            if is_backchannel or gap < SPEAKER_TURN_MIN_GAP_S:
                log.info(
                    "question_detection.speaker_turn_skipped",
                    session_id=self.session_id,
                    reason="backchannel" if is_backchannel else "rapid_alternation",
                    text=text[:40] if text else None,
                )
                self._last_speaker = speaker
                self._last_speaker_change_at = now
                # Still arm the normal timers so we don't lose the final.
                self._arm_timers()
                return
            self._last_speaker = speaker
            self._last_speaker_change_at = now
            self._cancel_timers()
            self._start_run("speaker_turn")
            return
        if speaker is not None:
            if self._last_speaker is None:
                # First labelled final — remember when we started so the
                # gap filter has a baseline.
                self._last_speaker_change_at = time.time()
            self._last_speaker = speaker

        self._arm_timers()

    def _start_run(self, triggered_by: TriggeredBy) -> None:
        """Lock-protected `_run_task` creation.

        Both the speaker-turn fast path and the timer paths funnel through
        here. Without the lock, two ticks could see `_run_task` as done
        between their check and their create_task, spawning two concurrent
        detections on the same transcript window.
        """

        async def _spawn() -> None:
            async with self._run_lock:
                existing = self._run_task
                if existing is not None and not existing.done():
                    return
                self._run_task = asyncio.create_task(self._run(triggered_by))

        # Fire-and-forget spawner; held on a field so the GC can't reclaim
        # it mid-await. The spawner task is short (one lock acquisition).
        self._spawn_task = asyncio.create_task(_spawn())

    def _arm_timers(self) -> None:
        """Idle + ceiling arming. Pulled out so the speaker-turn skip path
        can re-use it without duplicating the logic."""

        # Idle timer: resets on every final.
        if self._idle_task and not self._idle_task.done():
            self._idle_task.cancel()
        self._idle_task = asyncio.create_task(
            self._wait_then_run(settings.question_detection_silence_ms, "idle"),
        )
        # Ceiling timer: armed once, survives subsequent finals.
        if self._ceiling_task is None or self._ceiling_task.done():
            self._ceiling_task = asyncio.create_task(
                self._wait_then_run(
                    settings.question_detection_ceiling_ms, "ceiling"
                ),
            )
        self._set_state("listening")

    async def close(self) -> None:
        self._cancel_timers()
        if self._run_task and not self._run_task.done():
            self._run_task.cancel()
        # Bounded await so a slow _on_question callback can't deadlock the
        # WS teardown. We cancel first, then give each task up to
        # CLOSE_TIMEOUT_S to acknowledge.
        for task in (
            self._idle_task,
            self._ceiling_task,
            self._run_task,
            self._spawn_task,
            self._state_notify_task,
            self._fallback_notify_task,
            self._persist_fallback_task,
        ):
            if task is None:
                continue
            try:
                await asyncio.wait_for(task, timeout=CLOSE_TIMEOUT_S)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):  # noqa: BLE001
                pass

    def _cancel_timers(self) -> None:
        for task in (self._idle_task, self._ceiling_task):
            if task and not task.done():
                task.cancel()
        self._idle_task = None
        self._ceiling_task = None

    def _set_state(self, state: QDState) -> None:
        if state == self._state:
            return
        self._state = state
        if self._on_state is None:
            return
        # Fire-and-forget — state notifications aren't load-bearing; we don't
        # want a slow ws.send to back up the detection loop. Held in a field
        # only so the GC can't collect it mid-await.
        self._state_notify_task = asyncio.create_task(self._on_state(state))

    async def report_call_failed(self) -> None:
        """A classifier call raised (bad key, provider outage). Used by the
        Flux turn coordinator, which calls classify() itself."""
        await self._notify_error("call_failed")

    async def _notify_error(self, reason: str) -> None:
        if self._on_error is None:
            return
        try:
            await self._on_error(reason)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "question_detection.error_notify_failed",
                session_id=self.session_id,
                error=str(exc),
            )

    async def _notify_dedup(self, question: str) -> None:
        if self._on_dedup is None:
            return
        try:
            await self._on_dedup(question)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "question_detection.dedup_notify_failed",
                session_id=self.session_id,
                error=str(exc),
            )

    async def _wait_then_run(self, delay_ms: int, triggered_by: TriggeredBy) -> None:
        try:
            await asyncio.sleep(delay_ms / 1000)
        except asyncio.CancelledError:
            return
        # Whichever timer fired first wins; cancel the other so we don't
        # double-run for the same window. The lock inside _start_run is
        # the actual gate that prevents concurrent _run instances.
        self._cancel_timers()
        self._start_run(triggered_by)

    async def _run(self, triggered_by: TriggeredBy = "idle") -> None:
        # Need at least one LLM client to do anything useful. We accept
        # OpenAI-only mode (someone running entirely on GPT-4o) — the
        # fallback path treats absent-Gemini as permanently in fallback.
        claude_pick = _is_claude_qd_model(self._model) and claude_available()
        if self._client is None and not self._fallback_ready() and not claude_pick:
            log.warning("question_detection.skip_no_key")
            return
        if self._client is None and not self._fallback_active and not claude_pick:
            # OpenAI-only deployments don't have a Gemini key to start
            # from; pretend the fallback is already armed so _call_qd_llm
            # routes straight to GPT-4o.
            self._fallback_active = True
        self._set_state("detecting")
        try:
            await self._run_inner(triggered_by)
        finally:
            # Only flip back to listening if more finals are still queued.
            # notify_final sets us to "listening" on the next arrival, so
            # going to "idle" here is the right default.
            self._set_state("idle")

    async def _run_inner(self, triggered_by: TriggeredBy) -> None:
        # SNAPSHOT the effective model at the very top of the run. If a
        # concurrent set_qd_model arrives mid-call, this in-flight detection
        # keeps using the model the user had selected when it started —
        # avoids TOCTOU where _call_gemini reads self._model halfway through.
        model_snapshot = self._effective_qd_model()

        utterances = await recent_transcript_entries(
            self.session_id, float(settings.question_detection_transcript_window_s)
        )
        if not utterances:
            return

        newest = str(utterances[-1].get("text") or "")
        # Mid-thought guard only applies to the idle path. Ceiling and
        # speaker-turn are themselves "the speaker is done with this thought"
        # signals — letting the LLM judge is the whole point.
        if triggered_by == "idle" and _looks_mid_thought(newest):
            log.info(
                "question_detection.skip_mid_thought",
                session_id=self.session_id,
                triggered_by=triggered_by,
                tail=newest[-40:],
            )
            return
        # Instrument non-idle paths when the newest utterance still looks
        # incomplete — useful for tuning the ceiling/backchannel thresholds.
        if triggered_by != "idle" and _looks_mid_thought(newest):
            log.info(
                "question_detection.bypass_mid_thought",
                session_id=self.session_id,
                triggered_by=triggered_by,
                tail=newest[-40:],
            )

        try:
            verdict = await self.classify(
                utterances_from_entries(utterances), model_snapshot=model_snapshot
            )
        except Exception as exc:  # noqa: BLE001
            log.error(
                "question_detection.error",
                session_id=self.session_id,
                model=model_snapshot,
                error=str(exc),
            )
            await self.report_call_failed()
            return
        log.info("question_detection.trigger", session_id=self.session_id, by=triggered_by)
        if not verdict.answerable or verdict.question is None:
            return
        extracted_str = verdict.question
        # Backend-side dedup: ceiling + idle can both fire on the same
        # transcript window in close succession. Drop dups inside the
        # cooldown window.
        if self._is_recent_duplicate(extracted_str):
            log.info(
                "question_detection.skip_dup",
                session_id=self.session_id,
                triggered_by=triggered_by,
            )
            await self._notify_dedup(extracted_str)
            return
        is_follow_up = await self.resolve_follow_up(verdict, model_snapshot)
        self.remember_question(extracted_str)
        await self._on_question(extracted_str, verdict.confidence, is_follow_up)

    # ─── shared classifier API (also used by the Flux turn coordinator) ────

    def remember_question(self, question: str) -> None:
        """Record a fired question for dedup + follow-up context. Called
        BEFORE awaiting delivery so a racing run sees it immediately."""
        self._last_question = question
        self._last_question_at = time.time()

    async def thread_context(self) -> ThreadContext | None:
        """The question currently being answered, if recent enough to be
        followed up on. Prefers the Redis Q+A (written by ws_answer after each
        answer) and falls back to the in-memory last question."""
        if time.time() - self._last_question_at > FOLLOW_UP_WINDOW_S:
            return None
        cached = await get_last_answer(self.session_id)
        last = self._last_question
        # The Redis Q+A is written when an answer FINISHES, so while the
        # newest question is still streaming it holds the previous one.
        if last and (not cached or cached.get("q", "").strip() != last.strip()):
            return ThreadContext(question=last)
        if cached and cached.get("q"):
            return ThreadContext(question=cached["q"], answer_excerpt=cached.get("a", ""))
        return None

    async def classify(
        self,
        utterances: Sequence[Utterance],
        *,
        model_snapshot: str | None = None,
        thread: ThreadContext | None = None,
        use_thread: bool = True,
    ) -> Classification:
        """One classifier call → normalized verdict. Model routing, quota
        fallback and usage recording are the same as the timer path."""
        model = model_snapshot or self._effective_qd_model()
        if thread is None and use_thread:
            thread = await self.thread_context()
        raw, served = await self._call_qd_llm_served(list(utterances), model, thread=thread)
        # `served` differs from `model` when a Gemini quota error routed the
        # call to the fallback model mid-flight; log and stamp the one that
        # actually answered.
        verdict = normalize_classification(raw, served)
        log.info(
            "question_detection.result",
            session_id=self.session_id,
            kind=verdict.kind,
            confidence=verdict.confidence,
            model=served,
            picked=model if served != model else None,
            reasoning=verdict.reasoning,
            question=(verdict.question or "")[:120],
        )
        return verdict

    async def resolve_follow_up(self, verdict: Classification, model_snapshot: str) -> bool:
        """Follow-up flag for an answerable verdict. v2 verdicts carry it in
        `kind`; a v1-shaped reply (no kind) falls back to the separate
        follow-up classifier."""
        if verdict.has_kind or verdict.question is None:
            return verdict.is_follow_up
        return await self._classify_follow_up(verdict.question, model_snapshot)

    def _is_recent_duplicate(self, extracted: str) -> bool:
        prior = self._last_question
        if not prior:
            return False
        if prior.strip().lower() != extracted.strip().lower():
            return False
        age = time.time() - self._last_question_at
        return age < settings.question_detection_dedup_cooldown_s

    async def _classify_follow_up(
        self, new_question: str, model_snapshot: str
    ) -> bool:
        """Decide if `new_question` extends the most recently fired one.

        Reads the prior Q+A from Redis (written by ws_answer after every
        completed answer). Previously this only had the prior *question* to
        work with, which biased the classifier toward false follow-ups.
        """
        # Read both prior Q and A together so even if the in-memory
        # `_last_question` was overwritten by the dedup write above, the
        # follow-up classifier still sees the same prior question.
        cached = await get_last_answer(self.session_id)
        if cached:
            prior_q = cached.get("q", "")
            prior_a = cached.get("a", "")
        else:
            # Fallback to in-memory `_last_question` for the first answer
            # cycle (Redis hasn't been written yet) or when Redis is down.
            prior_q = self._last_question or ""
            prior_a = ""
        if not prior_q:
            return False
        age = time.time() - self._last_question_at
        if age > FOLLOW_UP_WINDOW_S:
            return False
        if prior_q.strip().lower() == new_question.strip().lower():
            return False
        try:
            parsed = await self._call_follow_up_llm(
                prior_q, prior_a, new_question, model_snapshot
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "follow_up.error",
                session_id=self.session_id,
                error=str(exc),
            )
            return False
        if not parsed:
            return False
        is_follow_up = bool(parsed.get("is_follow_up"))
        confidence = float(parsed.get("confidence") or 0.0)
        log.info(
            "follow_up.result",
            session_id=self.session_id,
            is_follow_up=is_follow_up,
            confidence=confidence,
            reasoning=parsed.get("reasoning"),
        )
        return is_follow_up and confidence >= FOLLOW_UP_MIN_CONFIDENCE

    def _activate_fallback(self, reason: str) -> None:
        """Flip the session into the configured fallback model. Idempotent
        — emits the UI-side notification only once."""
        already = self._fallback_active
        self._fallback_active = True
        if already:
            return
        fallback_model = settings.question_detection_fallback_model
        log.warning(
            "question_detection.fallback_active",
            session_id=self.session_id,
            reason=reason,
            fallback_model=fallback_model,
        )
        # Persist for WS-reconnect resilience. A transient network blip
        # shouldn't cost a wasted Gemini retry; the fresh detector instance
        # restores this flag in __init__ via restore_persistent_state().
        # Chained through _spawn_persist so activate→clear pairs land in
        # Redis in order (otherwise a fast clear-after-activate could be
        # overwritten by the slower activate write completing later).
        self._spawn_persist(fallback_model)
        if self._on_fallback is not None and not self._fallback_notified:
            self._fallback_notified = True
            self._fallback_notify_task = asyncio.create_task(
                self._on_fallback(fallback_model),
            )

    def _clear_fallback(self, reason: str) -> None:
        """Lift the fallback flag (probe succeeded / user re-picked)."""
        if not self._fallback_active:
            return
        log.info(
            "question_detection.fallback_cleared",
            session_id=self.session_id,
            reason=reason,
        )
        self._fallback_active = False
        self._fallback_notified = False
        self._fallback_call_count = 0
        self._spawn_persist(None)

    def _spawn_persist(self, model: str | None) -> None:
        """Serialize Redis fallback writes by awaiting the prior task
        before spawning the next one. Without serialization an
        activate→clear pair can land in Redis in either order, leaving
        the wrong state to be restored on reconnect."""
        prior = self._persist_fallback_task

        async def _run() -> None:
            if prior is not None and not prior.done():
                try:
                    await prior
                except Exception:  # noqa: BLE001
                    pass
            await set_qd_fallback(self.session_id, model)

        self._persist_fallback_task = asyncio.create_task(_run())

    async def restore_persistent_state(self) -> None:
        """Pull persisted fallback flag from Redis. Called by ws_transcribe
        right after construction so reconnects don't re-probe Gemini."""
        stashed = await get_qd_fallback(self.session_id)
        if stashed:
            log.info(
                "question_detection.fallback_restored",
                session_id=self.session_id,
                model=stashed,
            )
            self._fallback_active = True
            # Don't mark `_fallback_notified` — the new WS connection's UI
            # should still get the badge on its first detection.

    def _should_probe_gemini(self) -> bool:
        """True when it's time to probe Gemini for quota recovery. Only
        meaningful when we're in fallback and have a Gemini client and
        the user's pick is actually a Gemini model (probing makes no
        sense if they explicitly chose OpenAI)."""
        if not self._fallback_active:
            return False
        if self._client is None:
            return False
        if _is_openai_qd_model(self._model) or _is_claude_qd_model(self._model):
            return False
        interval = settings.question_detection_probe_interval
        if interval <= 0:
            return False
        return self._fallback_call_count >= interval

    async def _call_qd_llm(
        self,
        utterances: list[Utterance],
        model_snapshot: str,
        *,
        thread: ThreadContext | None = None,
    ) -> dict[str, Any]:
        """Run QD against the snapshotted model; the raw classifier JSON."""
        raw, _served = await self._call_qd_llm_served(utterances, model_snapshot, thread=thread)
        return raw

    async def _call_qd_llm_served(
        self,
        utterances: list[Utterance],
        model_snapshot: str,
        *,
        thread: ThreadContext | None = None,
    ) -> tuple[dict[str, Any], str]:
        """Run QD against the snapshotted model. Returns the raw classifier
        JSON and the model that actually served the call.

        Routing rules (resolved at the top of _run, not here, so concurrent
        set_qd_model can't change the model mid-call):
        - Claude model → Claude directly (CLI on a subscription token, or
          the SDK when an API key is set). No further fallback: the pick is
          explicit and Claude has its own quota.
        - OpenAI model → OpenAI directly.
        - Gemini model → Gemini with sticky-fallback-on-429. Periodic
          probes try Gemini again when in fallback (quota may have reset).
        """
        prompt = question_detection_user_prompt(utterances, thread=thread)
        # Probe path: in fallback, but enough calls have succeeded that
        # we should try Gemini again. If it works, lift fallback. Note
        # the probe always tries the user's *preferred* Gemini model
        # (self._model) — not model_snapshot, which is the OpenAI
        # fallback during this call.
        if self._should_probe_gemini():
            # Snapshot the probed model up front so a concurrent
            # set_qd_model can't swap the model out from under us mid-call.
            probe_model = self._model
            try:
                result = await self._call_gemini_with_usage(prompt, probe_model)
                self._clear_fallback("probe_recovered")
                return result, probe_model
            except Exception as exc:  # noqa: BLE001
                if _is_quota_error(exc):
                    # Still rate-limited. Reset the counter so we wait
                    # another N calls before probing again, and continue
                    # through to the OpenAI path below.
                    self._fallback_call_count = 0
                    log.info(
                        "question_detection.probe_still_429",
                        session_id=self.session_id,
                    )
                else:
                    # Non-quota error — log but don't lift fallback.
                    log.warning(
                        "question_detection.probe_error",
                        session_id=self.session_id,
                        error=str(exc),
                    )

        if _is_claude_qd_model(model_snapshot):
            if self._fallback_active and model_snapshot == settings.question_detection_fallback_model:
                # Counts toward the Gemini-recovery probe budget.
                self._fallback_call_count += 1
            return await self._call_claude_qd_with_usage(prompt, model_snapshot), model_snapshot
        if _is_openai_qd_model(model_snapshot):
            return await self._call_openai_qd_with_usage(prompt, model_snapshot), model_snapshot
        if self._client is None:
            # No Gemini configured. _run guarantees some client exists, so
            # route through the fallback model and keep fallback active so
            # future calls skip Gemini.
            self._activate_fallback("no_gemini_key")
            return await self._call_fallback_qd(prompt), settings.question_detection_fallback_model
        try:
            return await self._call_gemini_with_usage(prompt, model_snapshot), model_snapshot
        except Exception as exc:  # noqa: BLE001
            if _is_quota_error(exc) and self._fallback_ready():
                self._activate_fallback("quota")
                return await self._call_fallback_qd(prompt), settings.question_detection_fallback_model
            raise

    def _fallback_ready(self) -> bool:
        """True when the quota-fallback model has a usable credential."""
        if _is_claude_qd_model(settings.question_detection_fallback_model):
            return claude_available()
        return self._openai_client is not None

    async def _call_fallback_qd(self, prompt: str) -> dict[str, Any]:
        """QD on the configured fallback model (Claude or OpenAI)."""
        model = settings.question_detection_fallback_model
        if _is_claude_qd_model(model):
            self._fallback_call_count += 1
            return await self._call_claude_qd_with_usage(prompt, model)
        return await self._call_openai_qd_with_usage(prompt, model)

    async def _call_fallback_follow_up(self, user: str) -> dict[str, Any]:
        model = settings.question_detection_fallback_model
        if _is_claude_qd_model(model):
            self._fallback_call_count += 1
            return await self._call_claude_follow_up_with_usage(user, model)
        return await self._call_openai_follow_up_with_usage(user, model)

    async def _call_follow_up_llm(
        self,
        prior_question: str,
        prior_answer: str,
        new_question: str,
        model_snapshot: str,
    ) -> dict[str, Any]:
        """Same routing as _call_qd_llm but for the follow-up classifier."""
        user = follow_up_user_prompt(prior_question, prior_answer, new_question)
        if _is_claude_qd_model(model_snapshot):
            return await self._call_claude_follow_up_with_usage(user, model_snapshot)
        if _is_openai_qd_model(model_snapshot):
            return await self._call_openai_follow_up_with_usage(
                user, model_snapshot,
            )
        if self._client is None:
            self._activate_fallback("no_gemini_key")
            return await self._call_fallback_follow_up(user)
        try:
            return await self._call_gemini_follow_up_with_usage(
                user, model_snapshot,
            )
        except Exception as exc:  # noqa: BLE001
            if _is_quota_error(exc) and self._fallback_ready():
                self._activate_fallback("quota")
                return await self._call_fallback_follow_up(user)
            raise

    # ─── transport implementations (with usage tracking) ────────────────────

    async def _call_claude_qd_with_usage(self, prompt: str, model: str) -> dict[str, Any]:
        """Question-detection on Claude."""
        text = await self._call_claude_text(
            QUESTION_DETECTION_SYSTEM_PROMPT,
            prompt,
            model,
            kind="question_detection",
            max_tokens=320,
        )
        return _safe_json_dict(text, log_key="question_detection.bad_json")

    async def _call_claude_follow_up_with_usage(
        self, user: str, model: str
    ) -> dict[str, Any]:
        text = await self._call_claude_text(
            FOLLOW_UP_SYSTEM_PROMPT, user, model, kind="follow_up", max_tokens=128
        )
        return _safe_json_dict(text, log_key="follow_up.bad_json")

    async def _call_claude_text(
        self, system: str, user: str, model: str, *, kind: str, max_tokens: int
    ) -> str:
        """One JSON-returning Claude call, on the transport claude_transport() picks.

        The subscription CLI is billed at zero marginal cost — usage is logged
        under ``claude-code:<model>`` so it resolves to no per-token price,
        with a char/4 token estimate purely for visibility. The API transport
        uses the SDK and reports real token counts, at ANTHROPIC_EFFORT (low by
        default) to keep this latency-sensitive classifier fast.
        """
        transport = claude_transport()
        if transport == "cli":
            from app.services.claude_cli import stream_claude_cli_text

            chunks: list[str] = []
            async for text in stream_claude_cli_text(
                prompt=user, system=system, model=model, session_id=self.session_id,
            ):
                if text:
                    chunks.append(text)
            answer = "".join(chunks)
            await record_qd_call(
                session_id=self.session_id,
                provider="claude",
                model=f"claude-code:{model}",
                kind=kind,
                input_tokens=(len(system) + len(user)) // 4,
                output_tokens=max(1, len(answer) // 4),
            )
            return _strip_json_fence(answer)

        if transport is None:
            raise RuntimeError("no Claude credential for question detection")
        answer, input_tokens, output_tokens = await complete_claude_api(
            system=system,
            user=user,
            model=model,
            max_tokens=max_tokens,
            effort=settings.anthropic_effort,
            # A JSON verdict gains nothing from reasoning; on models that
            # allow it, skipping thinking roughly halves latency.
            thinking=False,
        )
        await record_qd_call(
            session_id=self.session_id,
            provider="claude",
            model=model,
            kind=kind,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
        return _strip_json_fence(answer)

    async def _call_gemini_with_usage(self, prompt: str, model: str) -> dict[str, Any]:
        """Question-detection on Gemini. Records cost. May raise on quota."""
        assert self._client is not None
        response = await self._client.aio.models.generate_content(
            model=model,
            contents=prompt,
            config=genai_types.GenerateContentConfig(
                system_instruction=QUESTION_DETECTION_SYSTEM_PROMPT,
                temperature=0.1,
                max_output_tokens=320,
                response_mime_type="application/json",
                # Latency-critical classifier: no thinking on 2.5 Flash/Lite.
                thinking_config=(
                    genai_types.ThinkingConfig(thinking_budget=0)
                    if "pro" not in model
                    else None
                ),
            ),
        )
        await self._record_gemini_usage(response, model, kind="question_detection")
        text = (response.text or "").strip()
        return _safe_json_dict(text, log_key="question_detection.bad_json")

    async def _call_gemini_follow_up_with_usage(
        self, user: str, model: str
    ) -> dict[str, Any]:
        assert self._client is not None
        response = await self._client.aio.models.generate_content(
            model=model,
            contents=user,
            config=genai_types.GenerateContentConfig(
                system_instruction=FOLLOW_UP_SYSTEM_PROMPT,
                temperature=0.1,
                max_output_tokens=128,
                response_mime_type="application/json",
            ),
        )
        await self._record_gemini_usage(response, model, kind="follow_up")
        text = (response.text or "").strip()
        return _safe_json_dict(text, log_key="follow_up.bad_json")

    async def _call_openai_qd_with_usage(self, prompt: str, model: str) -> dict[str, Any]:
        """OpenAI path for QD. Handles OpenAI-side 429 by emitting an
        on_error signal — there's no further fallback available."""
        if self._openai_client is None:
            return {}
        try:
            response = await self._openai_client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": QUESTION_DETECTION_SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.1,
                max_tokens=320,
                response_format={"type": "json_object"},
            )
        except Exception as exc:  # noqa: BLE001
            if _is_quota_error(exc):
                self._openai_unhealthy = True
                log.error(
                    "question_detection.openai_429",
                    session_id=self.session_id,
                    model=model,
                )
                await self._notify_error("both_providers_unavailable")
                return {}
            raise
        self._fallback_call_count += 1
        await self._record_openai_usage(response, model, kind="question_detection")
        if not response.choices:
            return {}
        text = (response.choices[0].message.content or "").strip()
        return _safe_json_dict(text, log_key="question_detection.bad_json")

    async def _call_openai_follow_up_with_usage(
        self, user: str, model: str
    ) -> dict[str, Any]:
        if self._openai_client is None:
            return {}
        try:
            response = await self._openai_client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": FOLLOW_UP_SYSTEM_PROMPT},
                    {"role": "user", "content": user},
                ],
                temperature=0.1,
                max_tokens=128,
                response_format={"type": "json_object"},
            )
        except Exception as exc:  # noqa: BLE001
            if _is_quota_error(exc):
                self._openai_unhealthy = True
                await self._notify_error("both_providers_unavailable")
                return {}
            raise
        # follow-up classifier counts toward the probe budget too
        self._fallback_call_count += 1
        await self._record_openai_usage(response, model, kind="follow_up")
        if not response.choices:
            return {}
        text = (response.choices[0].message.content or "").strip()
        return _safe_json_dict(text, log_key="follow_up.bad_json")

    async def _record_gemini_usage(
        self, response: Any, model: str, *, kind: str
    ) -> None:
        meta = getattr(response, "usage_metadata", None)
        input_tokens = int(getattr(meta, "prompt_token_count", 0) or 0)
        output_tokens_raw = getattr(meta, "candidates_token_count", None)
        output_tokens = (
            int(output_tokens_raw) if output_tokens_raw is not None else None
        )
        await record_qd_call(
            session_id=self.session_id,
            provider="gemini",
            model=model,
            kind=kind,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )

    async def _record_openai_usage(
        self, response: Any, model: str, *, kind: str
    ) -> None:
        usage = getattr(response, "usage", None)
        input_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
        output_tokens_raw = getattr(usage, "completion_tokens", None)
        output_tokens = (
            int(output_tokens_raw) if output_tokens_raw is not None else None
        )
        await record_qd_call(
            session_id=self.session_id,
            provider="openai",
            model=model,
            kind=kind,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
        )
