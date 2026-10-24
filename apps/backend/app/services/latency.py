"""End-to-end question latency timeline.

The number that matters to the candidate is "interviewer stopped talking →
first answer words on screen". Its pieces live on two websockets: the turn
coordinator (/ws/transcribe) knows when speech ended, when the turn was
judged and when the question was confirmed; /ws/answer knows when the first
token streamed. Both mark checkpoints here under the question's
`candidate_id`; once the answer is visible we log one `qd.latency` line with
every stage as milliseconds since the last interviewer word.

Visible = max(confirmed, first_token): a speculative answer streams hidden
until its question is confirmed.

In-process only (both sockets live in the same backend process); entries
expire so abandoned speculations don't accumulate.
"""

from __future__ import annotations

import time

from app.logging import log

_TTL_S = 120.0
_timelines: dict[str, dict[str, float]] = {}


def _prune(now: float) -> None:
    stale = [cid for cid, t in _timelines.items() if now - t.get("_created", now) > _TTL_S]
    for cid in stale:
        _timelines.pop(cid, None)


def mark(candidate_id: str | None, checkpoint: str, at: float | None = None) -> None:
    """Record `checkpoint` for this question (first write wins)."""
    if not candidate_id:
        return
    now = time.time()
    _prune(now)
    timeline = _timelines.setdefault(candidate_id, {"_created": now})
    timeline.setdefault(checkpoint, at if at is not None else now)
    _maybe_report(candidate_id, timeline)


def discard(candidate_id: str | None) -> None:
    if candidate_id:
        _timelines.pop(candidate_id, None)


def _maybe_report(candidate_id: str, timeline: dict[str, float]) -> None:
    if "_reported" in timeline:
        return
    confirmed = timeline.get("confirmed")
    first_token = timeline.get("first_token")
    if confirmed is None or first_token is None:
        return
    timeline["_reported"] = 1.0
    timeline["visible"] = max(confirmed, first_token)
    origin = timeline.get("last_word") or timeline["_created"]
    stages = {
        f"{k}_ms": round((v - origin) * 1000)
        for k, v in sorted(timeline.items(), key=lambda kv: kv[1])
        if not k.startswith("_") and k != "last_word"
    }
    log.info("qd.latency", candidate_id=candidate_id, **stages)
