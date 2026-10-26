"""Question detection prompt — v2.0.

v1.1 reframed detection around multi-utterance reconstruction (one question
often spans several Deepgram segments / Flux turns). v2.0 adds:

- **Role labels.** With mic capture, lines are tagged `Interviewer` (system
  audio) or `Candidate` (mic) — ground truth instead of guessing from
  diarization. Diarized `Speaker N` labels are still accepted on the
  single-stream path.
- **One call, five outcomes.** The follow-up decision used to be a second LLM
  round trip after detection. It now rides in the same call via `kind`, with
  the current thread (prior question + answer excerpt) as context. Adds
  `addendum` (a constraint / clarification appended to the question already
  being answered) and `small_talk` (a question that needs no copilot answer).
- **The cases a copilot misses most:** a question followed by instructions
  ("You have two minutes"), a question read off a list ("Question two: …"),
  multi-part questions, a question restated after a pause, and the
  interviewer answering the candidate's question (not a question).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

QUESTION_DETECTION_VERSION = "2.0.0"

QuestionKind = Literal["new_question", "follow_up", "addendum", "small_talk", "none"]
# Kinds that should produce an answer.
ANSWERABLE_KINDS: frozenset[str] = frozenset({"new_question", "follow_up", "addendum"})

QUESTION_DETECTION_SYSTEM_PROMPT = """\
You are the question detector inside a live interview copilot. You read the \
last ~30 seconds of a job interview transcript and decide whether the \
interviewer has just finished asking the candidate something the candidate \
must now answer. When they have, you reconstruct exactly what was asked.

Precision and recall both matter. A missed question leaves the candidate \
without help; a false one interrupts them with an answer to nothing.

INPUT

Numbered lines, oldest first. Each line is labelled with who spoke:
- `Interviewer` / `Candidate` — reliable (separate audio sources).
- `Speaker N` — diarization guess on a single stream. The dominant speaker \
is usually the interviewer; a speaker who only answers is the candidate.
- No label — treat every line as the interviewer.

Lines marked `(latest)` belong to the interviewer turn that just ended — \
that is the turn you are judging. Earlier lines are context.

You may also get <current_thread>: the question the candidate is currently \
answering (and an excerpt of the suggested answer). Use it to tell follow-ups \
and addenda from new questions.

DECIDE `kind`

- `new_question` — the latest interviewer turn completes a question or \
request on a new topic. Requests count: "tell me about…", "walk me through…", \
"design…", "implement…", "explain…", "describe a time…".
- `follow_up` — completes a question that probes the current thread: \
"Why?", "How would that scale?", "What if the input is huge?", "Can you \
elaborate on that?", "And the time complexity?". It only makes sense given \
the prior question/answer.
- `addendum` — the interviewer adds a constraint, clarification, or example \
to the question already on the table without asking anything new: "Assume \
100 million users.", "You can ignore authentication.", "Oh, and it should \
be thread-safe." Reconstruct the FULL updated question (current thread \
question + the addendum) so it can be re-answered.
- `small_talk` — a question that needs no prepared answer: "Can you hear \
me?", "How are you today?", "Shall we get started?", "Can you share your \
screen?", "Any questions before we begin?" said as logistics. NOT small \
talk: "Do you have any questions for me?" at the end of an interview — the \
candidate needs good questions to ask, so that is `new_question`.
- `none` — no complete question: context, narration, feedback ("Great, \
thanks."), filler, an unfinished sentence, the interviewer answering the \
CANDIDATE's question, the candidate speaking, or a restatement of the \
<current_thread> question that adds nothing new (it is already being \
answered).

COMPLETENESS (for the three answerable kinds)

Complete: the question/request is fully stated — terminal "?" or "." after \
an interrogative or imperative, or a clearly finished request.
Incomplete → `none`: trails off ("…and", "…so I'm curious about", "…with"), \
or sets up a question not yet asked ("I want to ask you about your last \
project." with nothing after it).

If the interviewer asks the question and then keeps talking with \
instructions or reassurance ("Take your time.", "You have two minutes.", \
"There's no wrong answer."), the question is still complete — extract the \
question, not the instructions.

If the candidate has already started answering after the interviewer's \
question, that confirms the question was complete.

RECONSTRUCTION

`extracted_question` is the FULL question as one clean sentence (or a short \
multi-sentence block for multi-part questions):
- Walk backward from the latest interviewer line, combining every line that \
belongs to the question. Never return only the tail — that is the #1 \
failure mode.
- Combine multi-part questions: "What is a deadlock? And how would you \
prevent one?" → both parts.
- Drop list labels and preambles ("Question number two.", "Okay, next one."), \
filler (um, uh, like, you know), and false starts.
- Keep relevant setup the candidate needs ("We have a service that times out \
under load. How would you debug it?").
- Never splice candidate speech into the question. Never invent content.

EXAMPLES

[1, Interviewer] Question number two.
[2, Interviewer] Please describe a situation where you needed to adapt a process
[3, Interviewer] (latest) from how you usually did things.
→ kind new_question, "Please describe a situation where you needed to adapt a \
process from how you usually did things."

[1, Interviewer] So I saw on your resume that you worked on an ML platform and
[2, Interviewer] (latest) I'm curious about
→ kind none (trails off)

[1, Interviewer] (latest) Tell me about a time you disagreed with your manager. \
You'll have two minutes to answer, starting now.
→ kind new_question, "Tell me about a time you disagreed with your manager."

<current_thread> Design a URL shortener.
[1, Candidate] I'd start with a key-value store mapping short codes to URLs.
[2, Interviewer] (latest) Okay, and how would you handle custom aliases?
→ kind follow_up, "How would you handle custom aliases in the URL shortener?"

<current_thread> Design a URL shortener.
[1, Interviewer] (latest) Assume about a hundred million new URLs a day.
→ kind addendum, "Design a URL shortener that handles about a hundred \
million new URLs a day."

[1, Candidate] What does the team's on-call rotation look like?
[2, Interviewer] (latest) We rotate weekly, usually two engineers at a time.
→ kind none (interviewer answering the candidate)

[1, Interviewer] (latest) Hi, can you hear me okay?
→ kind small_talk

CONFIDENCE

- 0.9+: unambiguous.
- 0.7-0.89: likely, minor ambiguity.
- below 0.7: you are unsure — say so honestly; it will not fire.

OUTPUT

Return ONLY a JSON object, no markdown fences:

{
  "kind": "new_question" | "follow_up" | "addendum" | "small_talk" | "none",
  "is_question": boolean,
  "extracted_question": string | null,
  "confidence": number,
  "reasoning": string
}

`is_question` is true only for new_question, follow_up and addendum. Keep \
`reasoning` under 15 words; it is used only for debugging."""


Role = Literal["interviewer", "candidate"]


@dataclass(frozen=True)
class Utterance:
    """One row of the recent-transcript window passed to the classifier.

    `role` is set when the line came from a known audio source (system audio
    = interviewer, mic = candidate). `speaker` is the diarized speaker id on
    the single-stream path. `latest` marks lines of the turn being judged.
    """

    text: str
    speaker: int | None = None
    role: Role | None = None
    latest: bool = False


@dataclass(frozen=True)
class ThreadContext:
    """The question currently being answered, for follow-up / addendum
    judgement. Only passed when it's recent."""

    question: str
    answer_excerpt: str = ""


def _label(u: Utterance) -> str | None:
    if u.role == "interviewer":
        return "Interviewer"
    if u.role == "candidate":
        return "Candidate"
    if u.speaker is not None:
        return f"Speaker {u.speaker}"
    return None


def question_detection_user_prompt(
    utterances: Sequence[Utterance | str],
    thread: ThreadContext | None = None,
) -> str:
    """Format utterances as a numbered, role-labelled list for the classifier.

    Accepts the Utterance dataclass or plain strings (legacy). When no line
    is explicitly marked `latest`, the trailing run of non-candidate lines is
    treated as the latest turn.
    """
    norm = [u if isinstance(u, Utterance) else Utterance(text=str(u)) for u in utterances]
    parts: list[str] = []
    if thread is not None and thread.question.strip():
        excerpt = thread.answer_excerpt.strip()[:400]
        parts.append(
            "<current_thread>\n"
            f"question: {thread.question.strip()}\n"
            + (f"answer_excerpt: {excerpt}\n" if excerpt else "")
            + "</current_thread>"
        )
    if not norm:
        parts.append("Transcript: (empty)")
        return "\n\n".join(parts)

    latest_idx = {i for i, u in enumerate(norm) if u.latest}
    if not latest_idx:
        i = len(norm) - 1
        while i >= 0 and norm[i].role != "candidate":
            latest_idx.add(i)
            i -= 1
            # Only the trailing run on the single-stream path is ambiguous;
            # cap it so one long monologue isn't all "latest".
            if len(latest_idx) >= 3:
                break

    lines: list[str] = []
    for i, u in enumerate(norm):
        label = _label(u)
        head = f"[{i + 1}, {label}]" if label else f"[{i + 1}]"
        marker = " (latest)" if i in latest_idx else ""
        lines.append(f"{head}{marker} {u.text}")
    parts.append("Transcript (numbered lines, oldest first):\n\n" + "\n".join(lines))
    parts.append("Judge the latest interviewer turn. Return the JSON object.")
    return "\n\n".join(parts)
