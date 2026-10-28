"""Question detection prompt — v1.1 (mirrors packages/prompts/question-detection.ts).

v1.1 — reframed around multi-utterance question reconstruction. The v1.0 prompt
leaned on "classify the most recent utterance", which caused Gemini Flash to
extract only the tail when a question was split across multiple Deepgram finals.
v1.1 passes the transcript as numbered utterances and instructs the model to
walk backward from the newest utterance and combine them into one sentence.

When updating, also update the TS mirror so any frontend consumers stay in sync.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

QUESTION_DETECTION_VERSION = "1.3.0"

QUESTION_DETECTION_SYSTEM_PROMPT = """\
You classify whether an interviewer has just finished asking the candidate a question that requires a response, and — when they have — reconstruct it.

You will receive the last 30 seconds of transcript as a numbered list of utterances in chronological order (oldest first, newest last). Deepgram splits on pauses, so ONE question often spans MULTIPLE utterances. Your job:

1. Decide whether the interviewer's most recent question is COMPLETE.
2. If yes, reconstruct the FULL question as one clean sentence by combining however many trailing utterances belong to it.

COMPLETENESS

A question IS complete (is_question: true) when the final utterance ends with:
- Clear terminal punctuation ("?", ".", "!") after an interrogative phrase
- A well-formed request: "tell me about...", "walk me through...", "describe...", "explain...", "can you share...", "how would you...", "what would happen if...", "design a...", "implement...", "walk me through...", etc.

A complete question may be FOLLOWED by courtesy remarks that hand the floor to the candidate: "take your time", "whenever you're ready", "you have two minutes", "feel free to think out loud", "go ahead". These do NOT cancel the question — it is still complete. Reconstruct the question itself and leave the courtesy remark out.

A question IS NOT complete (is_question: false) when:
- The final utterance trails off with no terminal punctuation, a conjunction/preposition ("and", "or", "but", "with", "for", "to"), or a dangling modifier — the interviewer is mid-sentence
- The interviewer is explaining, giving context, or making small talk
- It's acknowledgment / filler: "okay", "right", "got it", "makes sense"
- The utterance is a statement with no implicit ask
- It is call logistics or small talk that needs no prepared answer: "Can you hear me?", "Are you ready to begin?", "Shall we get started?", "Is now still a good time?", "How are you today?", "Can you see my screen?", "Any questions before we start?". The candidate answers these in a word; is_question: false.

RECONSTRUCTION

When is_question is true, `extracted_question` MUST be the FULL question, combining however many trailing utterances belong to the most recent question. Walk backward from the newest utterance and keep including utterances until you hit a clear topical boundary with older, unrelated content.

DO NOT output just the final utterance — this is the #1 failure mode. The candidate needs the complete question, not its tail.

Remove filler ("um", "uh", "like", "you know"), collapse split phrasing, but DO NOT add information that wasn't spoken.

EXAMPLE (multi-utterance reconstruction — follow this pattern)

Input transcript:
[1] Question number two.
[2] Please describe a situation where you needed to adapt a process, procedure, or technology differently
[3] from how you usually did things.

Correct output:
{
  "is_question": true,
  "extracted_question": "Please describe a situation where you needed to adapt a process, procedure, or technology differently from how you usually did things.",
  "confidence": 0.95,
  "reasoning": "Three utterances reconstructed; 'Question number two' is a prefix label"
}

Incorrect (the failure mode to avoid):
"extracted_question": "from how you usually did things"

EXAMPLE (incomplete — do not fire)

Input transcript:
[1] So I saw on your resume that you worked on an ML platform and
[2] I'm curious about

Correct output:
{
  "is_question": false,
  "extracted_question": null,
  "confidence": 0.9,
  "reasoning": "Trails off mid-phrase after 'curious about'"
}

SPEAKER LABELS (when present)

Utterances may be prefixed with `[N, Speaker M]` instead of just `[N]`.
Speaker IDs come from Deepgram diarization on the system-audio stream
and are stable within a session. Use them as follows:

- The transcript is captured from system audio (what comes out of the
  candidate's speakers), so the DOMINANT speaker — the one with the
  most utterances and the longest runs — is the interviewer. Their
  interrogatives are the questions to reconstruct.
- The candidate's own voice usually does NOT appear (their mic
  isn't routed into system output). If you see a second speaker who
  ONLY answers or never asks, treat them as the candidate and IGNORE
  their utterances for question-detection purposes.
- When utterances from different speakers are intermixed, only walk
  backward through utterances that share the most-recent speaker's id
  when reconstructing the question — do NOT splice a candidate
  acknowledgment ("got it", "right") into the interviewer's question.
- If speaker labels are absent (single-speaker capture or older
  recordings), treat all utterances as the interviewer and fall back
  to the multi-utterance reconstruction rules above.

CONFIDENCE SCALE

- 0.9+: Clearly complete, clearly directed at the candidate, terminal punctuation present
- 0.7-0.89: Likely complete question but minor ambiguity
- below 0.7: Do not emit is_question=true

OUTPUT

Return ONLY a JSON object, no markdown fences, no prose:

{
  "is_question": boolean,
  "extracted_question": string | null,
  "confidence": number,
  "reasoning": string
}

Keep `reasoning` under 15 words. It is used only for debugging."""


@dataclass(frozen=True)
class Utterance:
    """One row of the recent-transcript window passed to the classifier.

    `speaker` is the diarized speaker id from Deepgram (0, 1, …) when
    available, or None for older entries / single-speaker captures.
    """

    text: str
    speaker: int | None = None


# Appended when the candidate pressed "answer latest question". The
# candidate has already decided a question was asked, so the classifier's
# job narrows to finding the newest one rather than judging completeness.
MANUAL_REQUEST_NOTE = (
    "The candidate pressed the answer-now key: they need the most recent "
    "question or request directed at them. The COMPLETENESS rules do not "
    "apply to this request: if the interviewer trailed off mid-sentence, set "
    "is_question: true and reconstruct the request as far as it was spoken "
    "(e.g. \"…how you handled scaling the payments system and\" → \"How did "
    "you handle scaling the payments system?\"). Set is_question: false only "
    "if nothing was asked of the candidate at all."
)


def question_detection_user_prompt(
    utterances: Sequence[Utterance | str], *, manual: bool = False
) -> str:
    """Format utterances as a numbered list for the classifier.

    Accepts either the new Utterance dataclass (with speaker info) or
    plain strings (legacy). When ANY entry carries a speaker id, every
    line gets a `[N, Speaker M]` prefix so the model can use the SPEAKER
    LABELS section of the system prompt; otherwise we fall back to the
    plain `[N]` numbering and the system prompt's fallback rule kicks in.

    `manual` appends MANUAL_REQUEST_NOTE for candidate-triggered runs.
    """
    task = (
        MANUAL_REQUEST_NOTE
        if manual
        else "Classify the interviewer's most recent question and reconstruct it if complete."
    )
    if not utterances:
        return (
            "Last 30 seconds of transcript: (empty)\n\n"
            f"{task}"
        )
    # Normalize to Utterance and check whether any speaker is known.
    norm: list[Utterance] = []
    for u in utterances:
        if isinstance(u, Utterance):
            norm.append(u)
        else:
            norm.append(Utterance(text=str(u), speaker=None))
    has_speakers = any(u.speaker is not None for u in norm)

    if has_speakers:
        listing = "\n".join(
            f"[{i + 1}, Speaker {u.speaker if u.speaker is not None else '?'}] {u.text}"
            for i, u in enumerate(norm)
        )
    else:
        listing = "\n".join(f"[{i + 1}] {u.text}" for i, u in enumerate(norm))
    return (
        "Last 30 seconds of transcript (numbered utterances, oldest first):\n\n"
        f"{listing}\n\n"
        f"{task}"
    )
