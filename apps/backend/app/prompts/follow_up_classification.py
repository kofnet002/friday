"""Follow-up classifier — decides whether a newly-detected interview question
extends an existing thread or starts a new one. Runs after question_detection
returns is_question=true, only when a recent prior question exists (the
QuestionDetector tracks the timestamp + content of the last fired event).

Output drives the frontend's routing:
    is_follow_up=true  → followUp(q) — append to the current thread
    is_follow_up=false → askAnswer(q) — open a fresh thread
"""

from __future__ import annotations

FOLLOW_UP_CLASSIFICATION_VERSION = "1.0.0"

FOLLOW_UP_SYSTEM_PROMPT = """\
You are a strict classifier for live interview audio. Given a candidate's
previous Q&A and a newly-detected question from the interviewer, decide
whether the new question is a FOLLOW-UP that extends the same conversational
topic, or a NEW question that opens a different topic.

A follow-up:
- References, narrows, deepens, or pushes back on the previous question or
  answer ("So what about X?", "Can you elaborate on that?", "Why?", "And the
  complexity?", "What if N is huge?", "Tell me more about the tradeoff you
  mentioned").
- May be a one-word or partial probe that only makes sense given the prior
  context ("Why?", "And then?", "Trade-offs?").
- Usually arrives within a minute of the previous answer.

A new question:
- Shifts topic ("Now let's talk about system design", "Tell me about a
  time…", "Why do you want to work here?").
- Could stand alone without the prior context.
- May reuse interview filler ("Next question:", "Moving on,").

CONFIDENCE
- 0.9+: Obvious follow-up (explicit reference) or obvious new topic
- 0.7-0.89: Strong signal but not certain
- below 0.7: Mark is_follow_up=false (the default — opening a new thread is
  the safer fallback because the user can always merge later).

OUTPUT

Return ONLY a JSON object, no markdown fences, no prose:

{
  "is_follow_up": boolean,
  "confidence": number,
  "reasoning": string
}

Keep `reasoning` under 15 words. It is used only for debugging."""


def follow_up_user_prompt(
    prior_question: str,
    prior_answer: str,
    new_question: str,
) -> str:
    # Trim prior_answer to keep the classifier prompt small — we don't need
    # the full answer for this judgement, just enough to anchor topic.
    answer_excerpt = (prior_answer or "").strip()[:500]
    return (
        "<prior_question>\n"
        f"{prior_question.strip()}\n"
        "</prior_question>\n\n"
        "<prior_answer_excerpt>\n"
        f"{answer_excerpt}\n"
        "</prior_answer_excerpt>\n\n"
        "<new_question>\n"
        f"{new_question.strip()}\n"
        "</new_question>\n\n"
        "Classify the new question relative to the prior Q&A."
    )
