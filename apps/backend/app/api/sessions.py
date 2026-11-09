from __future__ import annotations

import io
import json
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.db import (
    append_qa,
    fork_session,
    get_session,
    latest_session,
    list_coding_solutions,
    list_qa,
    list_sessions,
    session_overview,
    session_usage_summary,
    upsert_session,
)
from app.redis_client import recent_transcript_entries
from app.services.limits import audio_minutes_by_session, check_audio_budget
from app.settings import settings

router = APIRouter(prefix="/api/sessions")


class CreateSessionPayload(BaseModel):
    session_id: str
    job_title: str | None = None
    company: str | None = None
    language: str | None = "en"
    extra_instructions: str | None = None
    interview_type: str | None = None
    default_provider: str | None = None


@router.post("")
async def create_session(payload: CreateSessionPayload) -> dict[str, Any]:
    await upsert_session(
        payload.session_id,
        job_title=payload.job_title,
        company=payload.company,
        language=payload.language,
        extra_instructions=payload.extra_instructions,
        interview_type=payload.interview_type,
        default_provider=payload.default_provider,
    )
    row = await get_session(payload.session_id)
    return {"ok": True, "session": row}


@router.patch("/{session_id}")
async def patch_session(
    session_id: str, payload: CreateSessionPayload
) -> dict[str, Any]:
    if payload.session_id != session_id:
        raise HTTPException(status_code=400, detail="session_id mismatch")
    await upsert_session(
        session_id,
        job_title=payload.job_title,
        company=payload.company,
        language=payload.language,
        extra_instructions=payload.extra_instructions,
        interview_type=payload.interview_type,
        default_provider=payload.default_provider,
    )
    row = await get_session(session_id)
    return {"ok": True, "session": row}


@router.get("")
async def get_sessions(limit: int = 20) -> dict[str, Any]:
    return {"sessions": await list_sessions(limit=min(max(1, limit), 100))}


@router.get("/overview")
async def get_sessions_overview(limit: int = 20) -> dict[str, Any]:
    """Recent sessions with their usage, for the Setup sessions list."""
    rows = await session_overview(limit=min(max(1, limit), 100))
    audio = await audio_minutes_by_session([r["session_id"] for r in rows])
    for r in rows:
        r["has_resume"] = bool(r["has_resume"])
        r["audio_minutes_used"] = round(audio.get(r["session_id"], 0.0), 2)
    return {
        "sessions": rows,
        "audio_minutes_limit": float(settings.session_audio_minute_limit),
    }


@router.post("/{session_id}/fork")
async def fork(session_id: str) -> dict[str, Any]:
    """New session that keeps this one's setup (role, resume, projects) with
    fresh history and budgets."""
    new_id = str(uuid.uuid4())
    if not await fork_session(session_id, new_id):
        raise HTTPException(status_code=404, detail="session not found")
    return {"session_id": new_id}


@router.get("/latest")
async def get_latest() -> dict[str, Any]:
    return {"session": await latest_session()}


@router.get("/{session_id}/usage")
async def get_session_usage(session_id: str) -> dict[str, Any]:
    """Aggregate LLM spend for a session — used by the descriptive cost pill
    in the floating bar. Cheap query (single GROUP BY against usage_log),
    plus the session's audio budget (one Redis GET)."""
    rows = await session_usage_summary(session_id)
    total_cost = sum((r.get("cost_usd") or 0.0) for r in rows)
    total_calls = sum(int(r.get("calls") or 0) for r in rows)
    total_input = sum(int(r.get("input_tokens") or 0) for r in rows)
    total_output = sum(int(r.get("output_tokens") or 0) for r in rows)
    audio = await check_audio_budget(session_id)
    return {
        "session_id": session_id,
        "rows": rows,
        "total_cost_usd": total_cost,
        "total_calls": total_calls,
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "token_limit": settings.session_token_limit,
        "audio_minutes_used": audio.used,
        "audio_minutes_limit": audio.limit,
    }


@router.get("/{session_id}")
async def get_session_detail(session_id: str) -> dict[str, Any]:
    row = await get_session(session_id)
    if not row:
        raise HTTPException(status_code=404, detail="session not found")
    qa = await list_qa(session_id, limit=50)
    coding = await list_coding_solutions(session_id, limit=50)
    return {
        "session": row,
        "qa": qa,
        "coding_solutions": coding,
    }


@router.get("/{session_id}/export")
async def export_session(session_id: str) -> StreamingResponse:
    row = await get_session(session_id)
    if not row:
        raise HTTPException(status_code=404, detail="session not found")

    qa = await list_qa(session_id, limit=500)
    coding = await list_coding_solutions(session_id, limit=500)
    usage = await session_usage_summary(session_id)
    transcript = await recent_transcript_entries(session_id, window_seconds=24 * 60 * 60)

    md = _render_markdown(row, qa, coding, usage, transcript)
    filename = f"friday-session-{session_id[:8]}.md"
    return StreamingResponse(
        io.BytesIO(md.encode("utf-8")),
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _ts(value: float | None) -> str:
    if not value:
        return "—"
    return datetime.fromtimestamp(value, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def _render_markdown(
    session: dict[str, Any],
    qa: list[dict[str, Any]],
    coding: list[dict[str, Any]],
    usage: list[dict[str, Any]],
    transcript: list[dict[str, Any]],
) -> str:
    out: list[str] = []
    out.append(f"# Friday session — {session['session_id']}")
    out.append("")
    out.append(f"**Created:** {_ts(session.get('created_at'))}")
    if session.get("job_title") or session.get("company"):
        out.append(
            f"**Role:** {session.get('job_title') or '—'} · "
            f"{session.get('company') or '—'}"
        )
    if session.get("interview_type"):
        out.append(f"**Interview type:** {session['interview_type']}")
    if session.get("language"):
        out.append(f"**Language:** {session['language']}")
    if session.get("default_provider"):
        out.append(f"**Default provider:** {session['default_provider']}")
    out.append("")

    if session.get("extra_instructions"):
        out.append("## Extra instructions")
        out.append("")
        out.append(str(session["extra_instructions"]))
        out.append("")

    if session.get("resume_text"):
        out.append("## Resume (excerpt)")
        out.append("")
        text = str(session["resume_text"]).strip()
        if len(text) > 2000:
            text = text[:2000] + "\n\n…(truncated)"
        out.append(text)
        out.append("")

    if transcript:
        out.append("## Transcript")
        out.append("")
        for entry in transcript:
            ts = _ts(entry.get("timestamp"))
            text = str(entry.get("text") or "").strip()
            if text:
                out.append(f"- `{ts}` {text}")
        out.append("")

    if qa:
        out.append("## Q&A")
        out.append("")
        # qa is newest-first; render oldest-first for readability.
        for i, item in enumerate(reversed(qa), 1):
            out.append(f"### Q{i} · {_ts(item.get('created_at'))}")
            out.append("")
            tag = "auto-detected" if item.get("auto_detected") else "manual"
            out.append(f"_Provider: {item['provider']} · {tag}_")
            out.append("")
            out.append("> " + str(item["question"]).replace("\n", "\n> "))
            out.append("")
            out.append(str(item["answer"]))
            out.append("")

    if coding:
        out.append("## Coding problems & solutions")
        out.append("")
        for sol in reversed(coding):
            title = sol.get("title") or "Untitled"
            difficulty = (sol.get("difficulty") or "").upper()
            platform = sol.get("platform") or "—"
            out.append(f"### {title} ({platform} · {difficulty})")
            out.append("")
            out.append(f"_Language: {sol['language']} · Provider: {sol['provider']}_")
            out.append("")
            stmt = sol.get("problem_statement") or ""
            out.append(stmt)
            out.append("")
            if sol.get("examples_json"):
                try:
                    examples = json.loads(sol["examples_json"])
                    out.append("**Examples**")
                    out.append("")
                    for ex in examples:
                        out.append(f"- Input: `{ex.get('input', '')}` → Output: `{ex.get('output', '')}`")
                    out.append("")
                except (TypeError, ValueError):
                    pass
            if sol.get("solution_text"):
                out.append("**Solution**")
                out.append("")
                out.append(str(sol["solution_text"]))
                out.append("")

    if usage:
        out.append("## Usage")
        out.append("")
        out.append("| kind | provider | model | calls | input | output | cost (USD) |")
        out.append("|---|---|---|---:|---:|---:|---:|")
        total_cost = 0.0
        for u in usage:
            cost = u.get("cost_usd") or 0.0
            total_cost += cost
            out.append(
                f"| {u.get('kind')} | {u.get('provider') or '—'} | "
                f"{u.get('model') or '—'} | {u.get('calls')} | "
                f"{u.get('input_tokens') or 0} | "
                f"{u.get('output_tokens') or 0} | "
                f"{cost:.6f} |"
            )
        out.append("")
        out.append(f"**Total estimated cost:** ${total_cost:.4f}")

    out.append("")
    return "\n".join(out)


@router.post("/{session_id}/qa")
async def append_qa_endpoint(
    session_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """Manual Q&A append (used by the renderer when it captured the
    question/answer pair locally — backstop for cases the WS handler missed)."""
    question = str(payload.get("question") or "").strip()
    answer = str(payload.get("answer") or "").strip()
    if not question or not answer:
        raise HTTPException(status_code=400, detail="question and answer required")
    row_id = await append_qa(
        session_id=session_id,
        question=question,
        answer=answer,
        provider=str(payload.get("provider") or "unknown"),
        model=payload.get("model"),
        auto_detected=bool(payload.get("auto_detected", False)),
    )
    return {"ok": True, "id": row_id}
