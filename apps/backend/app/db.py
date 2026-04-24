from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import aiosqlite

from app.settings import settings

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    job_title TEXT,
    company TEXT,
    language TEXT DEFAULT 'en',
    extra_instructions TEXT,
    resume_text TEXT,
    created_at REAL NOT NULL
);
"""


def _db_path() -> Path:
    p = Path(settings.sqlite_path)
    if not p.is_absolute():
        p = Path(__file__).resolve().parents[1] / p
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


async def init_db() -> None:
    async with aiosqlite.connect(_db_path()) as db:
        await db.executescript(SCHEMA)
        await db.commit()


async def upsert_session(
    session_id: str,
    *,
    job_title: str | None = None,
    company: str | None = None,
    language: str | None = None,
    extra_instructions: str | None = None,
) -> None:
    async with aiosqlite.connect(_db_path()) as db:
        await db.execute(
            """
            INSERT INTO sessions (session_id, job_title, company, language,
                                  extra_instructions, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                job_title = COALESCE(excluded.job_title, sessions.job_title),
                company = COALESCE(excluded.company, sessions.company),
                language = COALESCE(excluded.language, sessions.language),
                extra_instructions = COALESCE(excluded.extra_instructions,
                                              sessions.extra_instructions)
            """,
            (
                session_id,
                job_title,
                company,
                language or "en",
                extra_instructions,
                time.time(),
            ),
        )
        await db.commit()


async def set_resume_text(session_id: str, resume_text: str) -> None:
    async with aiosqlite.connect(_db_path()) as db:
        await db.execute(
            """
            INSERT INTO sessions (session_id, resume_text, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET resume_text = excluded.resume_text
            """,
            (session_id, resume_text, time.time()),
        )
        await db.commit()


async def get_session(session_id: str) -> dict[str, Any] | None:
    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None
