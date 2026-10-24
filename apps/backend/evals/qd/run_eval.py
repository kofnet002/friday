"""Question-detection eval: scripted transcripts → real coordinator + classifier.

Replays each case in evals/qd/cases.json as Flux turn events through the
real TurnCoordinator and the real QuestionDetector classifier (live model
calls — this spends a little money; Flash-Lite runs the whole set for well
under a cent). Transcript storage and usage recording are in-memory, so the
eval never touches Redis or the session database.

    cd apps/backend
    uv run python -m evals.qd.run_eval                       # default QD model
    uv run python -m evals.qd.run_eval --model gpt-4o-mini   # compare models
    uv run python -m evals.qd.run_eval --case follow-up-why  # one case
    uv run python -m evals.qd.run_eval --repeat 3            # flakiness check
    uv run python -m evals.qd.run_eval --pace 4.5            # Gemini free tier (~15 RPM)

Exit code is non-zero when any case fails, so it can gate prompt changes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.providers.deepgram_flux import FluxTurnEvent
from app.services import question_detection as qd_mod
from app.services.question_detection import QuestionDetector
from app.services.turn_detection import TurnCoordinator, looks_dangling

CASES_PATH = Path(__file__).with_name("cases.json")


@dataclass
class CaseResult:
    case_id: str
    passed: bool
    fired: list[dict[str, Any]]
    problems: list[str]
    judge_ms: list[float] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    @property
    def status(self) -> str:
        if self.errors:
            return "ERROR"
        return "PASS" if self.passed else "FAIL"


def _norm(text: str) -> str:
    """Case- and hyphen-insensitive ("worst-case" matches "worst case")."""
    return " ".join(text.lower().replace("-", " ").split())


def _ev(event: str, text: str, turn: int, trigger: str | None = None) -> FluxTurnEvent:
    return FluxTurnEvent(
        event=event,
        turn_index=turn,
        transcript=text,
        end_of_turn_confidence=0.9,
        audio_window_start=0.0,
        audio_window_end=0.0,
        trigger=trigger,
    )


async def run_case(case: dict[str, Any], model: str | None, pace: float = 0.0) -> CaseResult:
    rows: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    thread = case.get("thread")

    async def emit(e: dict[str, Any]) -> None:
        events.append(e)

    async def append_final(row: dict[str, Any]) -> None:
        rows.append(row)

    async def recent(_w: float) -> list[dict[str, Any]]:
        return list(rows)

    async def force_end() -> None:
        return None

    async def no_question(*_a: Any, **_k: Any) -> None:
        return None

    async def last_answer(_sid: str) -> dict[str, str] | None:
        return {"q": thread["question"], "a": thread.get("answer", "")} if thread else None

    detector = QuestionDetector("eval", no_question)
    if model:
        # Any model id — the eval may compare models the UI doesn't offer.
        detector._model_override = model
    if thread:
        detector.remember_question(thread["question"])

    judge_ms: list[float] = []
    errors: list[str] = []
    real_classify = detector.classify

    async def timed_classify(*a: Any, **k: Any) -> qd_mod.Classification:
        if pace:
            await asyncio.sleep(pace)
        t0 = time.perf_counter()
        try:
            return await real_classify(*a, **k)
        except Exception as exc:
            # Provider failure (quota, bad key) — not a detection verdict.
            errors.append(str(exc)[:160])
            raise
        finally:
            judge_ms.append((time.perf_counter() - t0) * 1000)

    detector.classify = timed_classify  # type: ignore[method-assign]

    coord = TurnCoordinator(
        "eval",
        detector,
        emit=emit,
        append_final=append_final,
        recent_entries=recent,
        force_end_interviewer=force_end,
    )
    # In-memory: no Redis for the thread, no usage rows.
    setattr(qd_mod, "get_last_answer", last_answer)  # noqa: B010 - test seam
    setattr(qd_mod, "record_qd_call", no_question)  # noqa: B010 - test seam

    turns = case["turns"]
    turn_index = 0
    for i, turn in enumerate(turns):
        text = turn["text"]
        if turn["role"] == "candidate":
            await coord.on_candidate(_ev("StartOfTurn", "", 0))
            await coord.on_candidate(_ev("Update", text, 0))
            await coord.on_candidate(_ev("EndOfTurn", text, 0))
            continue
        await coord.on_interviewer(_ev("StartOfTurn", "", turn_index))
        await coord.on_interviewer(_ev("Update", text, turn_index))
        if not looks_dangling(text):
            await coord.on_interviewer(_ev("EagerEndOfTurn", text, turn_index))
            await asyncio.sleep(0)
        nxt = turns[i + 1] if i + 1 < len(turns) else None
        trigger = "model"
        if nxt is not None and nxt["role"] == "candidate":
            # The candidate starts talking before the interviewer's turn is
            # confirmed — what really happens when they answer right away.
            await coord.on_candidate(_ev("Update", nxt["text"], 0))
            trigger = "manual"
        await coord.on_interviewer(_ev("EndOfTurn", text, turn_index, trigger))
        # Let any in-flight speculative judgement land.
        for _ in range(3000):  # up to 60 s — covers --pace + slow models
            if coord._spec is None:
                break
            await asyncio.sleep(0.02)
        turn_index += 1
    await coord.close()

    fired = [e for e in events if e["type"] == "question_detected"]
    problems: list[str] = []
    expected = case.get("expect", [])
    for j, exp in enumerate(expected):
        if j >= len(fired):
            problems.append(f"MISSED #{j + 1}: expected {exp['kind']} {exp.get('contains')}")
            continue
        got = fired[j]
        q = _norm(got.get("question") or "")
        kinds = exp["kind"] if isinstance(exp["kind"], list) else [exp["kind"]]
        if got.get("kind") not in kinds:
            problems.append(
                f"#{j + 1} kind {got.get('kind')} != {exp['kind']}: {got.get('question')!r}"
            )
        missing = [kw for kw in exp.get("contains", []) if _norm(kw) not in q]
        if missing:
            problems.append(f"#{j + 1} missing {missing}: {got.get('question')!r}")
    for extra in fired[len(expected) :]:
        problems.append(f"FALSE POSITIVE: {extra.get('kind')} {extra.get('question')!r}")
    if detector._fallback_active or detector._openai_unhealthy:
        errors.append("QD model unavailable (quota fallback engaged)")
    return CaseResult(case["id"], not problems, fired, problems, judge_ms, errors)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", help="QD model (default: QUESTION_DETECTION_MODEL)")
    parser.add_argument("--case", action="append", help="run only these case ids")
    parser.add_argument("--repeat", type=int, default=1, help="run each case N times")
    parser.add_argument("--json", action="store_true", help="print machine-readable results")
    parser.add_argument(
        "--pace", type=float, default=0.0, help="seconds to wait before each classifier call"
    )
    args = parser.parse_args()

    cases = json.loads(CASES_PATH.read_text())["cases"]
    if args.case:
        cases = [c for c in cases if c["id"] in set(args.case)]
    results: list[CaseResult] = []
    for case in cases:
        for _ in range(args.repeat):
            results.append(await run_case(case, args.model, args.pace))

    failed = [r for r in results if r.status != "PASS"]
    errored = [r for r in results if r.status == "ERROR"]
    latencies = [ms for r in results for ms in r.judge_ms]
    if args.json:
        print(json.dumps([r.__dict__ for r in results], indent=2, default=str))
    else:
        for r in results:
            print(f"{r.status:5} {r.case_id}")
            for p in r.errors if r.errors else r.problems:
                print(f"      {p}")
        print()
        print(f"{len(results) - len(failed)}/{len(results)} passed", end="")
        print(f" ({len(errored)} errored — provider failures, rerun)" if errored else "")
        if latencies:
            p50 = statistics.median(latencies)
            p95 = sorted(latencies)[max(0, int(len(latencies) * 0.95) - 1)]
            print(
                f"classifier latency: p50 {p50:.0f} ms, p95 {p95:.0f} ms ({len(latencies)} calls)"
            )
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
