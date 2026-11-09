from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.db import get_session, set_resume_text, upsert_session
from app.logging import log
from app.services.context_sources.files import extract_docx as _extract_docx
from app.services.context_sources.files import extract_pdf as _extract_pdf

router = APIRouter(prefix="/api/context")


class SessionContextPayload(BaseModel):
    session_id: str
    job_title: str | None = None
    company: str | None = None
    language: str | None = "en"
    extra_instructions: str | None = None


@router.post("")
async def set_context(payload: SessionContextPayload) -> dict[str, Any]:
    await upsert_session(
        payload.session_id,
        job_title=payload.job_title,
        company=payload.company,
        language=payload.language,
        extra_instructions=payload.extra_instructions,
    )
    return {"ok": True, "session_id": payload.session_id}


@router.get("/{session_id}")
async def fetch_context(session_id: str) -> dict[str, Any]:
    row = await get_session(session_id)
    if not row:
        return {"session_id": session_id, "exists": False}
    resume_text: str | None = row.get("resume_text")
    return {
        "session_id": session_id,
        "exists": True,
        "job_title": row.get("job_title"),
        "company": row.get("company"),
        "language": row.get("language") or "en",
        "extra_instructions": row.get("extra_instructions"),
        "resume_excerpt": (resume_text[:400] + "…") if resume_text and len(resume_text) > 400 else resume_text,
        "resume_chars": len(resume_text) if resume_text else 0,
        "interview_type": row.get("interview_type"),
        "default_provider": row.get("default_provider"),
    }


@router.post("/resume")
async def upload_resume(
    session_id: str = Form(...),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    name = (file.filename or "").lower()
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    try:
        if name.endswith(".pdf") or (file.content_type or "").endswith("pdf"):
            text = _extract_pdf(data)
        elif name.endswith(".docx") or "word" in (file.content_type or ""):
            text = _extract_docx(data)
        else:
            raise HTTPException(status_code=415, detail="upload .pdf or .docx")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        log.error("resume.parse_error", filename=name, error=str(exc))
        raise HTTPException(status_code=400, detail=f"failed to parse: {exc}") from exc

    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="no text extracted")

    await set_resume_text(session_id, text)
    return {"ok": True, "session_id": session_id, "chars": len(text)}
