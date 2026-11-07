"""Project context library: projects, their sources, briefs, and which
projects a session has attached."""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.db import (
    add_code_chunks,
    add_project_source,
    create_project,
    delete_project,
    delete_project_source,
    get_project,
    get_session_projects,
    list_project_sources,
    list_projects,
    set_session_projects,
    update_project,
)
from app.services.context_sources import Ingested, IngestError, cap
from app.services.context_sources.claude_code import ingest_claude_code, list_claude_code_projects
from app.services.context_sources.code_index import CodeChunk, chunk_repo
from app.services.context_sources.files import ingest_file
from app.services.context_sources.folder import ingest_folder
from app.services.context_sources.locate import locate_folder
from app.services.context_sources.redact import redact
from app.services.project_brief import start_brief

router = APIRouter(prefix="/api")

MAX_UPLOAD_BYTES = 25 * 1024 * 1024


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)


class ProjectPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=4000)
    brief: str | None = Field(default=None, max_length=60_000)


class SourceCreate(BaseModel):
    kind: Literal["text", "folder", "claude_code"]
    title: str | None = Field(default=None, max_length=200)
    # text
    text: str | None = None
    # folder
    path: str | None = None
    include_diff: bool = False
    # claude_code
    project_dir: str | None = None
    session_ids: list[str] | None = None
    # claude_code: also ingest the repo folder the sessions ran in
    include_repo: bool = False


class FolderLocate(BaseModel):
    # A folder dropped in a browser tab: its name and its entries' names
    # (the browser hides the absolute path).
    name: str = Field(min_length=1, max_length=255)
    children: list[str] = Field(default_factory=list, max_length=500)


class BriefRequest(BaseModel):
    force: bool = False


class SessionProjects(BaseModel):
    project_ids: list[str]


def _source_row(row: dict[str, Any]) -> dict[str, Any]:
    meta = row.pop("meta_json", None)
    row["meta"] = json.loads(meta) if meta else {}
    return row


async def _require_project(project_id: str) -> dict[str, Any]:
    project = await get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return project


async def _store(
    project_id: str,
    kind: str,
    item: Ingested,
    origin: str | None,
    code_chunks: list[CodeChunk] | None = None,
) -> dict[str, Any]:
    source_id = uuid.uuid4().hex
    text = redact(item.text)
    if code_chunks is not None:
        item.meta["code_chunks"] = len(code_chunks)
    await add_project_source(
        source_id=source_id,
        project_id=project_id,
        kind=kind,
        title=item.title,
        origin=origin,
        raw_text=text,
        meta=item.meta,
    )
    if code_chunks:
        await add_code_chunks(
            project_id=project_id, source_id=source_id, root=origin or "", chunks=code_chunks
        )
    return {
        "id": source_id,
        "kind": kind,
        "title": item.title,
        "chars": len(text),
        "code_chunks": len(code_chunks or []),
    }


async def _ingest_folder_with_code(
    path: str, include_diff: bool = False
) -> tuple[Ingested, list[CodeChunk]]:
    """Folder summary for the brief + citable code chunks for live answers."""
    item = await asyncio.to_thread(ingest_folder, path, include_diff=include_diff)
    chunks = await asyncio.to_thread(chunk_repo, Path(item.meta["path"]))
    return item, chunks


# ---------------------------------------------------------------- projects


@router.get("/projects")
async def projects_index() -> dict[str, Any]:
    return {"projects": await list_projects()}


@router.post("/projects")
async def projects_create(payload: ProjectCreate) -> dict[str, Any]:
    project_id = uuid.uuid4().hex
    await create_project(project_id, payload.name.strip(), payload.description)
    return {"project": await get_project(project_id)}


@router.get("/projects/{project_id}")
async def projects_show(project_id: str) -> dict[str, Any]:
    project = await _require_project(project_id)
    sources = [_source_row(r) for r in await list_project_sources(project_id)]
    return {"project": project, "sources": sources}


@router.patch("/projects/{project_id}")
async def projects_update(project_id: str, payload: ProjectPatch) -> dict[str, Any]:
    await _require_project(project_id)
    fields: dict[str, Any] = {}
    if payload.name is not None:
        fields["name"] = payload.name.strip()
    if payload.description is not None:
        fields["description"] = payload.description
    if payload.brief is not None:
        fields.update(brief=payload.brief, brief_edited=1, brief_status="ready", brief_error=None)
    await update_project(project_id, **fields)
    return {"project": await get_project(project_id)}


@router.delete("/projects/{project_id}")
async def projects_delete(project_id: str) -> dict[str, Any]:
    if not await delete_project(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    return {"ok": True}


# ----------------------------------------------------------------- sources


@router.post("/projects/{project_id}/sources/file")
async def sources_upload(
    project_id: str,
    file: UploadFile = File(...),  # noqa: B008 — FastAPI dependency idiom
    title: str | None = Form(default=None),
) -> dict[str, Any]:
    await _require_project(project_id)
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file too large (25 MB max)")
    try:
        item = await asyncio.to_thread(
            ingest_file, file.filename or "upload", file.content_type, data
        )
    except IngestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # parser crash on a malformed file
        raise HTTPException(status_code=400, detail=f"failed to parse: {exc}") from exc
    if title:
        item.title = title
    return {"sources": [await _store(project_id, "file", item, file.filename)]}


@router.post("/projects/{project_id}/sources")
async def sources_create(project_id: str, payload: SourceCreate) -> dict[str, Any]:
    await _require_project(project_id)
    stored: list[dict[str, Any]] = []
    try:
        if payload.kind == "text":
            text = (payload.text or "").strip()
            if not text:
                raise IngestError("text is empty")
            text, truncated = cap(text)
            item = Ingested(
                title=payload.title or "Notes", text=text, meta={"truncated": truncated}
            )
            stored.append(await _store(project_id, "text", item, None))
        elif payload.kind == "folder":
            if not payload.path:
                raise IngestError("path is required")
            item, chunks = await _ingest_folder_with_code(payload.path, payload.include_diff)
            if payload.title:
                item.title = payload.title
            stored.append(await _store(project_id, "folder", item, item.meta.get("path"), chunks))
        else:
            if not payload.project_dir:
                raise IngestError("project_dir is required")
            item = await asyncio.to_thread(
                ingest_claude_code, payload.project_dir, payload.session_ids
            )
            if payload.title:
                item.title = payload.title
            # Ingest the repo BEFORE storing anything, so a bad repo path
            # can't leave the project half-updated behind a 400.
            cwd = item.meta.get("cwd")
            repo = await _ingest_folder_with_code(cwd) if payload.include_repo and cwd else None
            stored.append(await _store(project_id, "claude_code", item, payload.project_dir))
            if repo:
                repo_item, repo_chunks = repo
                stored.append(
                    await _store(
                        project_id, "folder", repo_item, repo_item.meta.get("path"), repo_chunks
                    )
                )
    except IngestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"sources": stored}


@router.delete("/projects/{project_id}/sources/{source_id}")
async def sources_delete(project_id: str, source_id: str) -> dict[str, Any]:
    if not await delete_project_source(project_id, source_id):
        raise HTTPException(status_code=404, detail="source not found")
    return {"ok": True}


# ------------------------------------------------------------------- brief


@router.post("/projects/{project_id}/brief")
async def brief_generate(project_id: str, payload: BriefRequest | None = None) -> dict[str, Any]:
    project = await _require_project(project_id)
    force = bool(payload and payload.force)
    if project.get("brief_edited") and not force:
        raise HTTPException(
            status_code=409, detail="brief was edited by hand — pass force to overwrite"
        )
    if not await list_project_sources(project_id):
        raise HTTPException(status_code=400, detail="add at least one source first")
    started = await start_brief(project_id)
    return {"ok": True, "started": started, "project": await get_project(project_id)}


# ------------------------------------------------------------- claude code


@router.get("/claude-code/projects")
async def claude_code_projects() -> dict[str, Any]:
    return {"projects": await asyncio.to_thread(list_claude_code_projects)}


# ---------------------------------------------------------- folder lookup


@router.post("/folders/locate")
async def folders_locate(payload: FolderLocate) -> dict[str, Any]:
    try:
        found = await asyncio.to_thread(locate_folder, payload.name, payload.children)
    except IngestError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"candidates": [{"path": c.path, "score": c.score} for c in found]}


# --------------------------------------------------------- session linking


@router.get("/sessions/{session_id}/projects")
async def session_projects_get(session_id: str) -> dict[str, Any]:
    return {"projects": await get_session_projects(session_id)}


@router.put("/sessions/{session_id}/projects")
async def session_projects_put(session_id: str, payload: SessionProjects) -> dict[str, Any]:
    known = {p["id"] for p in await list_projects()}
    unknown = [pid for pid in payload.project_ids if pid not in known]
    if unknown:
        raise HTTPException(status_code=404, detail=f"unknown project(s): {', '.join(unknown)}")
    await set_session_projects(session_id, list(dict.fromkeys(payload.project_ids)))
    return {"projects": await get_session_projects(session_id)}
