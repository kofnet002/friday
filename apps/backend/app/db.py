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
    -- Groups follow-up turns back into the conversation that produced
    -- them. NULL on legacy rows / one-shot questions. Set client-side
    -- (UUID) so the server doesn't need to mint one mid-stream.
    thread_id TEXT,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qa_session ON qa_history(session_id, created_at DESC);
-- idx_qa_thread is created in init_db() AFTER _ensure_columns migrates
-- existing databases — putting it here breaks startup on any DB that
-- pre-dates the thread_id column because executescript() runs before
-- the migration and SQLite rejects an index on a missing column.

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

-- Full step-by-step traces of Claude agent runs (tool calls, results,
-- reasoning) so a run can be reviewed after the panel state is gone.
CREATE TABLE IF NOT EXISTS coding_agent_traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_s REAL,
    trace_json TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_session
    ON coding_agent_traces(session_id, created_at DESC);

-- Project context library: named projects the candidate may be asked about
-- (a repo they shipped, a PR under review). Each holds raw sources plus one
-- distilled brief; sessions attach projects so live answers can draw on
-- them. Library-level (not per session) so one project serves many calls.
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    brief TEXT,
    -- none | generating | ready | stale | error
    brief_status TEXT NOT NULL DEFAULT 'none',
    brief_error TEXT,
    -- 1 once the user hand-edits the brief; regeneration then needs force.
    brief_edited INTEGER NOT NULL DEFAULT 0,
    brief_model TEXT,
    created_at REAL NOT NULL,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS project_sources (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- file | text | folder | claude_code
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    origin TEXT,
    raw_text TEXT NOT NULL,
    chars INTEGER NOT NULL,
    meta_json TEXT,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_sources_project
    ON project_sources(project_id, created_at);

-- Citable code chunks from folder sources (function/class-sized, with
-- repo-relative path + line range), full-text indexed so a live answer can
-- pull the few blocks that answer the question in milliseconds. A plain
-- FTS5 table (not external-content): rows are deleted explicitly when their
-- source or project goes away.
CREATE VIRTUAL TABLE IF NOT EXISTS project_code_fts USING fts5(
    path, symbol, body,
    project_id UNINDEXED, source_id UNINDEXED, root UNINDEXED,
    start_line UNINDEXED, end_line UNINDEXED,
    tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS session_projects (
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY (session_id, project_id)
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
        # Idempotent column adds for existing DBs that pre-date these fields.
        await _ensure_columns(
            db,
            "sessions",
            {"interview_type": "TEXT", "default_provider": "TEXT"},
        )
        await _ensure_columns(db, "qa_history", {"thread_id": "TEXT"})
        # Indexes that depend on migrated columns must run AFTER the
        # _ensure_columns step — see the comment in SCHEMA next to the
        # idx_qa_thread placeholder. CREATE INDEX IF NOT EXISTS is a
        # no-op once the index already exists, so this is safe on
        # repeat startups.
        await db.execute(
            "CREATE INDEX IF NOT EXISTS idx_qa_thread ON qa_history(thread_id, created_at)"
        )
        # A brief "generating" at startup was orphaned by a restart (the task
        # lived in the old process) — surface it as retryable, not stuck.
        await db.execute(
            "UPDATE projects SET brief_status = 'error', "
            "brief_error = 'interrupted by restart — generate again' "
            "WHERE brief_status = 'generating'"
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


async def session_overview(limit: int = 20) -> list[dict[str, Any]]:
    """Recent sessions with what they've used: answered questions, LLM spend
    and last activity. Lightweight (no resume text) for the Setup list."""
    async with aiosqlite.connect(_db_path()) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT s.session_id, s.job_title, s.company, s.interview_type,
                   s.created_at,
                   (s.resume_text IS NOT NULL AND length(s.resume_text) > 0) AS has_resume,
                   COALESCE(q.qa_count, 0) AS qa_count,
                   COALESCE(u.cost_usd, 0.0) AS cost_usd,
                   MAX(s.created_at, COALESCE(q.last_at, 0), COALESCE(u.last_at, 0))
                       AS last_active_at
            FROM sessions s
            LEFT JOIN (
                SELECT session_id, COUNT(*) AS qa_count, MAX(created_at) AS last_at
                FROM qa_history GROUP BY session_id
            ) q ON q.session_id = s.session_id
            LEFT JOIN (
                SELECT session_id, SUM(cost_usd) AS cost_usd, MAX(created_at) AS last_at
                FROM usage_log GROUP BY session_id
            ) u ON u.session_id = s.session_id
            ORDER BY last_active_at DESC
            LIMIT ?
            """,
            (limit,),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]


async def fork_session(source_id: str, new_id: str) -> bool:
    """Start `new_id` with `source_id`'s setup: role, instructions, resume and
    attached projects. Usage, history and budgets start from zero. False when
    the source session doesn't exist."""
    async with aiosqlite.connect(_db_path()) as db:
        cursor = await db.execute(
            """
            INSERT INTO sessions (session_id, job_title, company, language,
                                  extra_instructions, resume_text,
                                  interview_type, default_provider, created_at)
            SELECT ?, job_title, company, language, extra_instructions,
                   resume_text, interview_type, default_provider, ?
            FROM sessions WHERE session_id = ?
            """,
            (new_id, time.time(), source_id),
        )
        if cursor.rowcount == 0:
            return False
        await db.execute(
            """
            INSERT OR IGNORE INTO session_projects (session_id, project_id)
            SELECT ?, project_id FROM session_projects WHERE session_id = ?
            """,
            (new_id, source_id),
        )
        await db.commit()
        return True


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
    thread_id: str | None = None,
) -> int:
    async with aiosqlite.connect(_db_path()) as db:
        cursor = await db.execute(
            """
            INSERT INTO qa_history (session_id, question, answer, provider,
                                    model, auto_detected, thread_id,
                                    created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                question,
                answer,
                provider,
                model,
                1 if auto_detected else 0,
                thread_id,
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
            SELECT id, question, answer, provider, model, auto_detected,
                   thread_id, created_at
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


async def record_agent_trace(
    *,
    session_id: str,
    fingerprint: str,
    status: str,
    duration_s: float,
    trace: list[dict[str, Any]],
) -> int:
    """Persist an agent run's full step trace for post-hoc review — the panel
    state is ephemeral, and 'what did the agent actually do?' matters when a
    run misbehaves or a solution needs auditing."""
    import json

    async with aiosqlite.connect(_db_path()) as db:
        cursor = await db.execute(
            """
            INSERT INTO coding_agent_traces (
                session_id, fingerprint, status, duration_s, trace_json, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                fingerprint,
                status,
                duration_s,
                json.dumps(trace, ensure_ascii=False),
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


# ---------------------------------------------------------------------------
# Project context library
# ---------------------------------------------------------------------------

_PROJECT_COLUMNS = (
    "id, name, description, brief, brief_status, brief_error, brief_edited, "
    "brief_model, created_at, updated_at"
)


async def _fk_conn() -> aiosqlite.Connection:
    """Connection with foreign keys ON (SQLite defaults them off) so deleting
    a project cascades to its sources and session links."""
    db = await aiosqlite.connect(_db_path())
    await db.execute("PRAGMA foreign_keys = ON")
    db.row_factory = aiosqlite.Row
    return db


async def create_project(project_id: str, name: str, description: str | None) -> None:
    now = time.time()
    db = await _fk_conn()
    try:
        await db.execute(
            "INSERT INTO projects (id, name, description, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (project_id, name, description, now, now),
        )
        await db.commit()
    finally:
        await db.close()


async def list_projects() -> list[dict[str, Any]]:
    db = await _fk_conn()
    try:
        async with db.execute(
            f"""
            SELECT {_PROJECT_COLUMNS},
                   (SELECT COUNT(*) FROM project_sources s WHERE s.project_id = p.id)
                       AS source_count,
                   (SELECT COALESCE(SUM(chars), 0) FROM project_sources s
                     WHERE s.project_id = p.id) AS source_chars
            FROM projects p
            ORDER BY updated_at DESC
            """
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]
    finally:
        await db.close()


async def get_project(project_id: str) -> dict[str, Any] | None:
    db = await _fk_conn()
    try:
        async with db.execute(
            f"SELECT {_PROJECT_COLUMNS} FROM projects WHERE id = ?", (project_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return dict(row) if row else None
    finally:
        await db.close()


async def update_project(project_id: str, **fields: Any) -> None:
    """Set the given columns (name, description, brief, brief_status, …)."""
    allowed = {
        "name",
        "description",
        "brief",
        "brief_status",
        "brief_error",
        "brief_edited",
        "brief_model",
    }
    cols = {k: v for k, v in fields.items() if k in allowed}
    if not cols:
        return
    assignments = ", ".join(f"{k} = ?" for k in cols)
    db = await _fk_conn()
    try:
        await db.execute(
            f"UPDATE projects SET {assignments}, updated_at = ? WHERE id = ?",
            (*cols.values(), time.time(), project_id),
        )
        await db.commit()
    finally:
        await db.close()


async def delete_project(project_id: str) -> bool:
    db = await _fk_conn()
    try:
        await db.execute("DELETE FROM project_code_fts WHERE project_id = ?", (project_id,))
        cursor = await db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        await db.commit()
        return (cursor.rowcount or 0) > 0
    finally:
        await db.close()


async def add_project_source(
    *,
    source_id: str,
    project_id: str,
    kind: str,
    title: str,
    origin: str | None,
    raw_text: str,
    meta: dict[str, Any] | None = None,
) -> None:
    """Insert a source and mark the project's brief stale (if it had one)."""
    import json

    now = time.time()
    db = await _fk_conn()
    try:
        await db.execute(
            """
            INSERT INTO project_sources (id, project_id, kind, title, origin,
                                         raw_text, chars, meta_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                source_id,
                project_id,
                kind,
                title,
                origin,
                raw_text,
                len(raw_text),
                json.dumps(meta) if meta else None,
                now,
            ),
        )
        await _mark_stale(db, project_id, now)
        await db.commit()
    finally:
        await db.close()


async def _mark_stale(db: aiosqlite.Connection, project_id: str, now: float) -> None:
    await db.execute(
        """
        UPDATE projects
        SET brief_status = CASE WHEN brief_status IN ('ready', 'error')
                                THEN 'stale' ELSE brief_status END,
            updated_at = ?
        WHERE id = ?
        """,
        (now, project_id),
    )


async def list_project_sources(project_id: str, *, with_text: bool = False) -> list[dict[str, Any]]:
    cols = "id, project_id, kind, title, origin, chars, meta_json, created_at"
    if with_text:
        cols += ", raw_text"
    db = await _fk_conn()
    try:
        async with db.execute(
            f"SELECT {cols} FROM project_sources WHERE project_id = ? ORDER BY created_at",
            (project_id,),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]
    finally:
        await db.close()


async def delete_project_source(project_id: str, source_id: str) -> bool:
    db = await _fk_conn()
    try:
        cursor = await db.execute(
            "DELETE FROM project_sources WHERE id = ? AND project_id = ?",
            (source_id, project_id),
        )
        if (cursor.rowcount or 0) > 0:
            await db.execute(
                "DELETE FROM project_code_fts WHERE source_id = ? AND project_id = ?",
                (source_id, project_id),
            )
            await _mark_stale(db, project_id, time.time())
        await db.commit()
        return (cursor.rowcount or 0) > 0
    finally:
        await db.close()


async def set_session_projects(session_id: str, project_ids: list[str]) -> None:
    db = await _fk_conn()
    try:
        await db.execute("DELETE FROM session_projects WHERE session_id = ?", (session_id,))
        await db.executemany(
            "INSERT OR IGNORE INTO session_projects (session_id, project_id) VALUES (?, ?)",
            [(session_id, pid) for pid in project_ids],
        )
        await db.commit()
    finally:
        await db.close()


async def get_session_projects(session_id: str) -> list[dict[str, Any]]:
    """Attached projects with their brief (no raw source text)."""
    db = await _fk_conn()
    try:
        async with db.execute(
            f"""
            SELECT {", ".join("p." + c.strip() for c in _PROJECT_COLUMNS.split(","))}
            FROM session_projects sp JOIN projects p ON p.id = sp.project_id
            WHERE sp.session_id = ?
            ORDER BY p.name
            """,
            (session_id,),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]
    finally:
        await db.close()


async def add_code_chunks(
    *, project_id: str, source_id: str, root: str, chunks: list[Any]
) -> None:
    """Index `CodeChunk`s (services/context_sources/code_index.py)."""
    if not chunks:
        return
    db = await _fk_conn()
    try:
        await db.executemany(
            """
            INSERT INTO project_code_fts (path, symbol, body, project_id, source_id,
                                          root, start_line, end_line)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (c.path, c.symbol, c.text, project_id, source_id, root, c.start_line, c.end_line)
                for c in chunks
            ],
        )
        await db.commit()
    finally:
        await db.close()


async def count_code_chunks(source_id: str) -> int:
    db = await _fk_conn()
    try:
        async with db.execute(
            "SELECT COUNT(*) FROM project_code_fts WHERE source_id = ?", (source_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return int(row[0]) if row else 0
    finally:
        await db.close()


async def search_code_chunks(
    project_ids: list[str], match: str, limit: int
) -> list[dict[str, Any]]:
    """BM25-ranked chunks for an FTS5 `match` expression. Symbol and path
    matches weigh more than body matches (a question naming a function or
    file should land on it)."""
    if not project_ids or not match:
        return []
    marks = ",".join("?" for _ in project_ids)
    db = await _fk_conn()
    try:
        async with db.execute(
            f"""
            SELECT path, symbol, body, project_id, root, start_line, end_line,
                   bm25(project_code_fts, 4.0, 6.0, 1.0) AS rank
            FROM project_code_fts
            WHERE project_code_fts MATCH ? AND project_id IN ({marks})
            ORDER BY rank
            LIMIT ?
            """,
            (match, *project_ids, limit),
        ) as cursor:
            return [dict(r) for r in await cursor.fetchall()]
    finally:
        await db.close()
