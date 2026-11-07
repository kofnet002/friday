"""Load the project context a session's live answers should carry."""

from __future__ import annotations

from typing import Any

from app.db import get_session_projects, list_project_sources
from app.logging import log
from app.prompts.answer_generation import ProjectContext
from app.settings import settings


def _raw_text(sources: list[dict[str, Any]]) -> str:
    return "\n\n".join(f"### {s['title']} ({s['kind']})\n{s['raw_text']}" for s in sources)


async def load_project_contexts(session_id: str | None) -> tuple[ProjectContext, ...]:
    """Briefs for every attached project; raw source text too, but only when
    ALL attached projects' sources fit `project_raw_budget_chars` together.
    All-or-nothing keeps the system prompt identical across questions in a
    session (prompt caching) and avoids one project crowding out another.

    A project with no brief yet falls back to raw text if it fits the budget
    on its own, so a freshly added project is still usable before its brief
    is generated."""
    if not session_id:
        return ()
    try:
        projects = await get_session_projects(session_id)
        if not projects:
            return ()
        sources = {p["id"]: await list_project_sources(p["id"], with_text=True) for p in projects}
    except Exception as exc:  # never block a live answer on this
        log.warning("project_context.load_failed", session_id=session_id, error=str(exc))
        return ()

    budget = settings.project_raw_budget_chars
    total_raw = sum(s["chars"] for rows in sources.values() for s in rows)
    include_all_raw = total_raw <= budget

    out: list[ProjectContext] = []
    for p in projects:
        rows = sources[p["id"]]
        # Any existing brief is used — including while a regeneration is
        # running or after one failed (the previous brief is still valid).
        brief = p.get("brief") or None
        raw: str | None = None
        if rows and (include_all_raw or (not brief and sum(s["chars"] for s in rows) <= budget)):
            raw = _raw_text(rows)
        if brief or raw:
            out.append(
                ProjectContext(name=p["name"], brief=brief, raw_text=raw, project_id=p["id"])
            )
    return tuple(out)


def project_keyterm_text(contexts: tuple[ProjectContext, ...]) -> str:
    """Text to mine for speech-recognition key terms (names, libraries)."""
    return "\n".join(f"{c.name}\n{c.brief or ''}" for c in contexts)
