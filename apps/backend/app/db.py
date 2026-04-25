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
    interview_type TEXT,
    default_provider TEXT,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS qa_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    auto_detected INTEGER DEFAULT 0,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qa_session ON qa_history(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_log(session_id, created_at);

CREATE TABLE IF NOT EXISTS coding_solutions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    platform TEXT,
    title TEXT,
    difficulty TEXT,
    problem_statement TEXT NOT NULL,
    examples_json TEXT,
    constraints_json TEXT,
    function_signature TEXT,
    language TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    solution_text TEXT NOT NULL,
    confidence REAL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_coding_solutions_session
    ON coding_solutions(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_coding_solutions_fingerprint
    ON coding_solutions(fingerprint);
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
        # Idempotent column adds for existing DBs that pre-date these fields.
        await _ensure_columns(
            db,
            "sessions",
            {"interview_type": "TEXT", "default_provider": "TEXT"},
        )
        await db.commit()


async def _ensure_columns(
    db: aiosqlite.Connection, table: str, columns: dict[str, str]
) -> None:
    async with db.execute(f"PRAGMA table_info({table})") as cursor:
        existing = {row[1] for row in await cursor.fetchall()}
    for name, decl in columns.items():
        if name not in existing:
            await db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


async def upsert_session(
    session_id: str,
    *,
    job_title: str | None = None,
    company: str | None = None,
    language: str | None = None,
    extra_instructions: str | None = None,
    interview_type: str | None = None,
    default_provider: str | None = None,
) -> None:
    async with aiosqlite.connect(_db_path()) as db:
        await db.execute(
            """
            INSERT INTO sessions (session_id, job_title, company, language,
                                  extra_instructions, interview_type,
                                  default_provider, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                job_title = COALESCE(excluded.job_title, sessions.job_title),
                company = COALESCE(excluded.company, sessions.company),
                language = COALESCE(excluded.language, sessions.language),
                extra_instructions = COALESCE(excluded.extra_instructions,
                                              sessions.extra_instructions),
                interview_type = COALESCE(excluded.interview_type,
                                          sessions.interview_type),
                default_provider = COALESCE(excluded.default_provider,
                                            sessions.default_provider)
            """,
            (
                session_id,
                job_title,
                company,
                language or "en",
                extra_instructions,
                interview_type,
                default_provider,
                time.time(),
            ),
        )
        await db.commit()


async def list_sessions(limit: int = 20) -> list[dict[str, Any]]:
    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT session_id, job_title, company, language, interview_type,
                   default_provider, created_at,
                   (resume_text IS NOT NULL AND length(resume_text) > 0) AS has_resume
            FROM sessions
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]


async def latest_session() -> dict[str, Any] | None:
    rows = await list_sessions(limit=1)
    return rows[0] if rows else None


async def append_qa(
    *,
    session_id: str,
    question: str,
    answer: str,
    provider: str,
    model: str | None = None,
    auto_detected: bool = False,
) -> int:
    async with aiosqlite.connect(_db_path()) as db:
        cursor = await db.execute(
            """
            INSERT INTO qa_history (session_id, question, answer, provider,
                                    model, auto_detected, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                question,
                answer,
                provider,
                model,
                1 if auto_detected else 0,
                time.time(),
            ),
        )
        await db.commit()
        return int(cursor.lastrowid or 0)


async def list_qa(session_id: str, limit: int = 50) -> list[dict[str, Any]]:
    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT id, question, answer, provider, model, auto_detected, created_at
            FROM qa_history
            WHERE session_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (session_id, limit),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]


async def session_usage_summary(session_id: str) -> list[dict[str, Any]]:
    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT kind, provider, model,
                   COUNT(*) AS calls,
                   SUM(input_tokens) AS input_tokens,
                   SUM(output_tokens) AS output_tokens,
                   SUM(cost_usd) AS cost_usd
            FROM usage_log
            WHERE session_id = ?
            GROUP BY kind, provider, model
            ORDER BY kind
            """,
            (session_id,),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]


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


async def record_coding_solution(
    *,
    session_id: str,
    fingerprint: str,
    problem: dict[str, Any],
    language: str,
    provider: str,
    model: str | None,
    solution_text: str,
) -> int:
    """Persist a generated coding solution + its problem metadata."""
    import json

    examples = problem.get("examples")
    constraints = problem.get("constraints")
    async with aiosqlite.connect(_db_path()) as db:
        cursor = await db.execute(
            """
            INSERT INTO coding_solutions (
                session_id, fingerprint, platform, title, difficulty,
                problem_statement, examples_json, constraints_json,
                function_signature, language, provider, model,
                solution_text, confidence, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                fingerprint,
                problem.get("platform"),
                problem.get("title"),
                problem.get("difficulty"),
                problem.get("problem_statement") or "",
                json.dumps(examples) if examples else None,
                json.dumps(constraints) if constraints else None,
                problem.get("function_signature"),
                language,
                provider,
                model,
                solution_text,
                problem.get("confidence"),
                time.time(),
            ),
        )
        await db.commit()
        return int(cursor.lastrowid or 0)


async def list_coding_solutions(session_id: str, limit: int = 50) -> list[dict[str, Any]]:
    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT id, fingerprint, platform, title, difficulty, language,
                   provider, model, confidence, created_at
            FROM coding_solutions
            WHERE session_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (session_id, limit),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]


async def log_usage(
    *,
    session_id: str,
    kind: str,
    provider: str | None = None,
    model: str | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    cost_usd: float | None = None,
) -> None:
    async with aiosqlite.connect(_db_path()) as db:
        await db.execute(
            """
            INSERT INTO usage_log (session_id, kind, provider, model,
                                   input_tokens, output_tokens, cost_usd,
                                   created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                kind,
                provider,
                model,
                input_tokens,
                output_tokens,
                cost_usd,
                time.time(),
            ),
        )
        await db.commit()
