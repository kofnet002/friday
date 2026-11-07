"""Generate a project's brief from its sources (background task).

Small projects go to the model in one call. When the sources together are
too big for one comfortable request, each source is first condensed into
notes (in parallel) and the brief is written from the notes."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

from app.db import get_project, list_project_sources, log_usage, update_project
from app.logging import log
from app.prompts.project_brief import (
    BRIEF_VERIFY_SYSTEM,
    PROJECT_BRIEF_SYSTEM,
    SOURCE_NOTES_SYSTEM,
    brief_user_prompt,
    notes_user_prompt,
    verify_user_prompt,
)
from app.services.claude_api import claude_transport, claude_usage_model, complete_claude_api
from app.services.usage import _cost
from app.settings import settings

# ~150k tokens. Above this the single-call path gets slow and pricey, and
# per-source notes keep the final call focused.
SINGLE_CALL_MAX_CHARS = 600_000
BRIEF_MAX_TOKENS = 6_000
NOTES_MAX_TOKENS = 3_000

# project_id → running task, so a second "generate" click doesn't double-spend.
_running: dict[str, asyncio.Task[None]] = {}

Completer = Callable[[str, str, int], Coroutine[Any, Any, tuple[str, int, int]]]


async def _complete(system: str, user: str, max_tokens: int) -> tuple[str, int, int]:
    transport = claude_transport()
    model = settings.project_brief_model
    if transport == "api":
        return await complete_claude_api(
            system=system,
            user=user,
            model=model,
            max_tokens=max_tokens,
            effort=settings.project_brief_effort,
        )
    if transport == "cli":
        from app.services.claude_cli import stream_claude_cli_text

        chunks = [t async for t in stream_claude_cli_text(prompt=user, system=system, model=model)]
        return "".join(chunks), 0, 0
    raise RuntimeError("no Claude credential configured (ANTHROPIC_API_KEY or Claude Code login)")


async def _log(project_id: str, kind: str, in_tok: int, out_tok: int) -> None:
    model = claude_usage_model(settings.project_brief_model)
    try:
        await log_usage(
            session_id=f"project:{project_id}",
            kind=kind,
            provider="claude",
            model=model,
            input_tokens=in_tok or None,
            output_tokens=out_tok or None,
            cost_usd=_cost(model, in_tok, out_tok) if in_tok else None,
        )
    except Exception as exc:  # usage logging must never fail a brief
        log.warning("project_brief.usage_log_failed", error=str(exc))


async def generate_brief(project_id: str, complete: Completer | None = None) -> str:
    complete = complete or _complete
    project = await get_project(project_id)
    if not project:
        raise ValueError("project not found")
    sources = await list_project_sources(project_id, with_text=True)
    if not sources:
        raise ValueError("add at least one source first")

    triples = [(s["kind"], s["title"], s["raw_text"]) for s in sources]
    total = sum(len(t[2]) for t in triples)
    if total > SINGLE_CALL_MAX_CHARS:

        async def notes(kind: str, title: str, text: str) -> tuple[str, str, str]:
            out, i, o = await complete(
                SOURCE_NOTES_SYSTEM,
                notes_user_prompt(project["name"], kind, title, text),
                NOTES_MAX_TOKENS,
            )
            await _log(project_id, "project_notes", i, o)
            return kind, f"{title} (notes)", out

        triples = list(await asyncio.gather(*(notes(*t) for t in triples)))

    user = brief_user_prompt(project["name"], project.get("description"), triples)
    brief, i, o = await complete(PROJECT_BRIEF_SYSTEM, user, BRIEF_MAX_TOKENS)
    await _log(project_id, "project_brief", i, o)
    brief = brief.strip()
    if not brief:
        raise RuntimeError("model returned an empty brief")
    if settings.project_brief_verify:
        # Fact-check pass: the benchmark showed drafts occasionally drop a
        # condition ("re-spawns when toggled" → "re-spawns if it dies"), and
        # every answer model then repeats the error. A failed or empty check
        # keeps the draft rather than failing the brief.
        try:
            checked, i, o = await complete(
                BRIEF_VERIFY_SYSTEM, verify_user_prompt(user, brief), BRIEF_MAX_TOKENS
            )
            await _log(project_id, "project_brief_verify", i, o)
            if checked.strip():
                brief = checked.strip()
        except Exception as exc:  # keep the unverified draft
            log.warning("project_brief.verify_failed", project_id=project_id, error=str(exc))
    return brief


async def _run(project_id: str) -> None:
    try:
        brief = await generate_brief(project_id)
    except Exception as exc:  # any failure → surfaced as brief_status=error
        log.error("project_brief.error", project_id=project_id, error=str(exc))
        await update_project(project_id, brief_status="error", brief_error=str(exc)[:500])
    else:
        await update_project(
            project_id,
            brief=brief,
            brief_status="ready",
            brief_error=None,
            brief_edited=0,
            brief_model=settings.project_brief_model,
        )
        log.info("project_brief.ready", project_id=project_id, chars=len(brief))
    finally:
        _running.pop(project_id, None)


async def start_brief(project_id: str) -> bool:
    """Kick off generation in the background. False if already running."""
    if project_id in _running and not _running[project_id].done():
        return False
    await update_project(project_id, brief_status="generating", brief_error=None)
    _running[project_id] = asyncio.create_task(_run(project_id))
    return True
