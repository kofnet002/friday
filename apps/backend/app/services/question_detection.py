from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

from google import genai
from google.genai import types as genai_types

from app.logging import log
from app.prompts.question_detection import (
    QUESTION_DETECTION_SYSTEM_PROMPT,
    question_detection_user_prompt,
)
from app.redis_client import recent_transcript_entries
from app.settings import settings

QuestionCallback = Callable[[str, float], Awaitable[None]]

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

    Each final transcript schedules a detection run after `silence_ms` of
    inactivity. If another final lands first, the previous timer is cancelled.
    At most one detection is in flight per session at a time.

    Mid-thought guard: if the newest utterance doesn't end cleanly (no terminal
    punctuation, ends with a conjunction, etc.), skip this firing rather than
    burn a Gemini Flash call on an obviously-incomplete question.
    """

    def __init__(self, session_id: str, on_question: QuestionCallback) -> None:
        self.session_id = session_id
        self._on_question = on_question
        self._timer_task: asyncio.Task[None] | None = None
        self._run_task: asyncio.Task[None] | None = None
        self._client = (
            genai.Client(api_key=settings.gemini_api_key)
            if settings.gemini_api_key
            else None
        )

    def notify_final(self) -> None:
        """A final transcript just arrived; (re)arm the silence timer."""
        if self._timer_task and not self._timer_task.done():
            self._timer_task.cancel()
        self._timer_task = asyncio.create_task(self._wait_then_run())

    async def close(self) -> None:
        for task in (self._timer_task, self._run_task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    async def _wait_then_run(self) -> None:
        try:
            await asyncio.sleep(settings.question_detection_silence_ms / 1000)
        except asyncio.CancelledError:
            return
        # Debounce: skip if a previous run is still going.
        if self._run_task and not self._run_task.done():
            return
        self._run_task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        if self._client is None:
            log.warning("question_detection.skip_no_key")
            return
        utterances = await recent_transcript_entries(
            self.session_id, float(settings.question_detection_transcript_window_s)
        )
        if not utterances:
            return

        newest = str(utterances[-1].get("text") or "")
        if _looks_mid_thought(newest):
            log.info(
                "question_detection.skip_mid_thought",
                session_id=self.session_id,
                tail=newest[-40:],
            )
            return

        try:
            result = await self._call_gemini([str(u["text"]) for u in utterances])
        except Exception as exc:  # noqa: BLE001
            log.error("question_detection.error", error=str(exc))
            return

        is_question = bool(result.get("is_question"))
        confidence = float(result.get("confidence") or 0.0)
        extracted = result.get("extracted_question")
        log.info(
            "question_detection.result",
            session_id=self.session_id,
            is_question=is_question,
            confidence=confidence,
            reasoning=result.get("reasoning"),
        )
        if (
            is_question
            and extracted
            and confidence >= settings.question_detection_min_confidence
        ):
            await self._on_question(str(extracted), confidence)

    async def _call_gemini(self, utterances: list[str]) -> dict[str, Any]:
        assert self._client is not None
        user_prompt = question_detection_user_prompt(utterances)
        response = await self._client.aio.models.generate_content(
            model=settings.question_detection_model,
            contents=user_prompt,
            config=genai_types.GenerateContentConfig(
                system_instruction=QUESTION_DETECTION_SYSTEM_PROMPT,
                temperature=0.1,
                max_output_tokens=256,
                response_mime_type="application/json",
            ),
        )
        text = (response.text or "").strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            log.warning("question_detection.bad_json", raw=text[:300])
            return {}
