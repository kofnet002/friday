"""Replay interview audio through the live pipeline and time every question.

Streams WAV audio in real time through Deepgram Flux (one stream per
source) into the real TurnCoordinator + classifier, exactly as a session
would — then prints each detected question with its latency, measured from
the END OF THE INTERVIEWER'S LAST WORD (Flux word timestamps, so it is the
true "they stopped talking" moment, not when the transcript arrived):

    eager      Flux EagerEndOfTurn — speculation starts
    candidate  question_candidate emitted (answer starts streaming, hidden)
    eot        Flux EndOfTurn — turn confirmed
    detected   question_detected emitted (answer revealed)
    visible    first answer words on screen = max(detected, first token) —
               only with --answer-provider, which streams real answers the
               way the client does (start on candidate, drop on retract)

Inputs (16 kHz is not required; any PCM WAV is resampled):
    --interviewer a.wav [--candidate b.wav]   separate tracks, or
    --stereo call.wav                         left = interviewer, right = candidate

    cd apps/backend
    uv run python -m evals.qd.replay --interviewer interview.wav
    uv run python -m evals.qd.replay --stereo mock.wav --expect mock.json

`--expect` takes {"questions": ["...", ...]} and reports which were found
(fuzzy word overlap ≥ 60%). Costs real Deepgram minutes + classifier calls.
"""

from __future__ import annotations

import argparse
import asyncio
import audioop
import json
import re
import sys
import time
import wave
from pathlib import Path
from typing import Any

from app.prompts.answer_generation import AnswerContext
from app.providers.deepgram_flux import FluxSession, FluxTurnEvent
from app.services import question_detection as qd_mod
from app.services.answer import Provider, stream_answer
from app.services.question_detection import QuestionDetector
from app.services.turn_detection import TurnCoordinator

RATE = 16_000
CHUNK_S = 0.08  # Flux recommends 80 ms frames
CHUNK_BYTES = int(RATE * CHUNK_S) * 2


def load_pcm(path: Path, channel: int | None = None) -> bytes:
    """Read a WAV as 16 kHz mono Int16 PCM. `channel` picks one side of a
    stereo file; otherwise channels are mixed."""
    with wave.open(str(path), "rb") as w:
        nch, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        data = w.readframes(w.getnframes())
    if width != 2:
        data = audioop.lin2lin(data, width, 2)
    if nch == 2:
        if channel is None:
            data = audioop.tomono(data, 2, 0.5, 0.5)
        else:
            data = audioop.tomono(
                data, 2, 1.0 if channel == 0 else 0.0, 1.0 if channel == 1 else 0.0
            )
    elif nch != 1:
        raise SystemExit(f"{path}: {nch} channels unsupported")
    if rate != RATE:
        data, _ = audioop.ratecv(data, 2, 1, rate, RATE, None)
    return data


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9']+", text.lower()) if len(w) > 2}


async def replay(
    interviewer_pcm: bytes,
    candidate_pcm: bytes | None,
    model: str | None,
    tail_s: float,
    answer_provider: Provider | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    t0 = 0.0  # wall clock of audio t=0
    last_word_end: dict[int, float] = {}  # interviewer turn → audio seconds
    timeline: dict[str, dict[str, float]] = {}  # candidate_id → stage → wall
    questions: list[dict[str, Any]] = []
    turn_of_candidate: dict[str, int] = {}
    current_turn = {"i": 0}
    answers: dict[str, asyncio.Task[None]] = {}
    first_token: dict[str, float] = {}

    async def run_answer(cid: str, question: str) -> None:
        transcript = " ".join(r["text"] for r in rows[-6:])
        ctx = AnswerContext(language="en", recent_transcript=transcript)
        assert answer_provider is not None
        async for _tok in stream_answer(answer_provider, question, ctx):
            first_token.setdefault(cid, time.time())

    async def emit(e: dict[str, Any]) -> None:
        now = time.time()
        if answer_provider is not None:
            cid = e.get("candidate_id")
            if e["type"] == "question_candidate" and cid and cid not in answers:
                answers[cid] = asyncio.create_task(run_answer(cid, e["question"]))
            elif e["type"] == "question_detected" and cid and cid not in answers:
                answers[cid] = asyncio.create_task(run_answer(cid, e["question"]))
            elif e["type"] == "question_retracted" and cid in answers:
                answers.pop(cid).cancel()
        if e["type"] in ("question_candidate", "question_detected"):
            cid = e["candidate_id"]
            stage = "candidate" if e["type"] == "question_candidate" else "detected"
            timeline.setdefault(cid, {})[stage] = now
            turn_of_candidate.setdefault(cid, current_turn["i"])
            if stage == "detected":
                questions.append({**e, "turn": turn_of_candidate[cid]})
        elif e["type"] == "question_retracted":
            print(f"  ↺ retracted {e['candidate_id'][:6]}")

    async def append_final(row: dict[str, Any]) -> None:
        rows.append(row)
        who = "  you" if row["source"] == "candidate" else "intvw"
        print(f"[{time.time() - t0:6.1f}s] {who}: {row['text']}")

    async def recent(_w: float) -> list[dict[str, Any]]:
        return list(rows)

    async def no_op(*_a: Any, **_k: Any) -> None:
        return None

    async def no_answer(_sid: str) -> None:
        return None

    setattr(qd_mod, "get_last_answer", no_answer)  # noqa: B010 - test seam
    setattr(qd_mod, "record_qd_call", no_op)  # noqa: B010 - test seam
    detector = QuestionDetector("replay", no_op)
    if model:
        detector._model_override = model

    interviewer: FluxSession | None = None

    async def force_end() -> None:
        if interviewer is not None:
            await interviewer.force_end_turn()

    coord = TurnCoordinator(
        "replay",
        detector,
        emit=emit,
        append_final=append_final,
        recent_entries=recent,
        force_end_interviewer=force_end,
    )

    eager_at: dict[int, float] = {}
    eot_at: dict[int, float] = {}

    async def on_interviewer(ev: FluxTurnEvent) -> None:
        # Attribute questions to the turn that last (eagerly) ended — Flux's
        # silent Updates after EndOfTurn already carry the next turn index.
        if ev.event in ("EagerEndOfTurn", "EndOfTurn") or (ev.event == "Update" and ev.transcript):
            current_turn["i"] = ev.turn_index
        if ev.words and ev.words[-1].end is not None:
            last_word_end[ev.turn_index] = ev.words[-1].end
        if ev.event == "EagerEndOfTurn":
            eager_at.setdefault(ev.turn_index, ev.received_at)
        elif ev.event == "EndOfTurn":
            eot_at[ev.turn_index] = ev.received_at
        await coord.on_interviewer(ev)

    async def on_err(msg: str) -> None:
        print("flux error:", msg, file=sys.stderr)

    interviewer = FluxSession(label="interviewer", on_event=on_interviewer, on_error=on_err)
    candidate = (
        FluxSession(label="candidate", on_event=coord.on_candidate, on_error=on_err, eager=False)
        if candidate_pcm
        else None
    )
    await interviewer.connect()
    if candidate is not None:
        await candidate.connect()

    silence = b"\x00" * CHUNK_BYTES
    total = max(len(interviewer_pcm), len(candidate_pcm or b""))
    total += int(tail_s * RATE) * 2  # trailing silence so the last turn can end
    t0 = time.time()
    for i, off in enumerate(range(0, total, CHUNK_BYTES)):
        await interviewer.send(interviewer_pcm[off : off + CHUNK_BYTES].ljust(CHUNK_BYTES, b"\x00"))
        if candidate is not None and candidate_pcm is not None:
            chunk = candidate_pcm[off : off + CHUNK_BYTES] or silence
            await candidate.send(chunk.ljust(CHUNK_BYTES, b"\x00"))
        # Real time: pace sends against the wall clock.
        await asyncio.sleep(max(0.0, t0 + (i + 1) * CHUNK_S - time.time()))
    await asyncio.sleep(3.0)
    for task in list(answers.values()):
        try:
            await asyncio.wait_for(task, 30)
        except Exception:  # noqa: BLE001
            pass
    await coord.close()
    await interviewer.finish()
    if candidate is not None:
        await candidate.finish()

    results = []
    for q in questions:
        turn = q["turn"]
        spoke_end = t0 + last_word_end.get(turn, 0.0)
        stages = timeline.get(q["candidate_id"], {})

        def ms(at: float | None, spoke_end: float = spoke_end) -> int | None:
            return None if at is None else round((at - spoke_end) * 1000)

        results.append(
            {
                "question": q["question"],
                "kind": q["kind"],
                "eager_ms": ms(eager_at.get(turn)),
                "candidate_ms": ms(stages.get("candidate")),
                "eot_ms": ms(eot_at.get(turn)),
                "detected_ms": ms(stages.get("detected")),
                "first_token_ms": ms(first_token.get(q["candidate_id"])),
                "visible_ms": (
                    ms(max(stages["detected"], first_token[q["candidate_id"]]))
                    if q["candidate_id"] in first_token and "detected" in stages
                    else None
                ),
            }
        )
    return results


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--interviewer", type=Path)
    src.add_argument("--stereo", type=Path, help="left = interviewer, right = candidate")
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--model", help="QD model override")
    parser.add_argument("--expect", type=Path, help='{"questions": [...]} to score recall')
    parser.add_argument("--tail", type=float, default=4.0, help="seconds of trailing silence")
    parser.add_argument(
        "--answer-provider",
        choices=["gemini", "openai", "deepseek", "claude"],
        help="also stream real answers and report when they become visible",
    )
    args = parser.parse_args()

    if args.stereo:
        interviewer_pcm = load_pcm(args.stereo, channel=0)
        candidate_pcm: bytes | None = load_pcm(args.stereo, channel=1)
    else:
        interviewer_pcm = load_pcm(args.interviewer)
        candidate_pcm = load_pcm(args.candidate) if args.candidate else None

    results = await replay(
        interviewer_pcm, candidate_pcm, args.model, args.tail, args.answer_provider
    )
    print()
    for r in results:
        print(f"Q [{r['kind']}] {r['question']}")
        print(
            "   since last word: "
            + ", ".join(
                f"{k[:-3]} {v} ms" for k, v in r.items() if k.endswith("_ms") and v is not None
            )
        )
    if args.expect:
        expected = json.loads(args.expect.read_text())["questions"]
        found = 0
        for exp in expected:
            ew = _words(exp)
            hit = any(len(ew & _words(r["question"])) / max(1, len(ew)) >= 0.6 for r in results)
            found += hit
            print(f"{'✓' if hit else '✗'} {exp}")
        print(f"recall {found}/{len(expected)}; {len(results)} questions fired")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
