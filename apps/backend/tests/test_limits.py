"""Cost-guardrail unit tests."""

from __future__ import annotations

import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest


@pytest.fixture
def isolated_db() -> Iterator[Path]:
    """Point the live settings instance at a fresh sqlite file for the test.

    We mutate the singleton rather than replacing it so every module that
    imported `settings` (db.py, limits.py, etc.) sees the override.
    """
    from app.settings import settings

    tmp = tempfile.TemporaryDirectory()
    original_path = settings.sqlite_path
    settings.sqlite_path = str(Path(tmp.name) / "limits-test.db")
    try:
        yield Path(tmp.name)
    finally:
        settings.sqlite_path = original_path
        tmp.cleanup()


@pytest.mark.asyncio
async def test_token_budget_under_limit(isolated_db: Path) -> None:
    from app.db import init_db, log_usage
    from app.services.limits import check_token_budget

    await init_db()
    await log_usage(
        session_id="s1",
        kind="coding_solution",
        provider="gemini",
        model="gemini-2.5-flash",
        input_tokens=100,
        output_tokens=200,
    )

    result = await check_token_budget("s1")
    assert result.ok is True
    assert result.used == 300


@pytest.mark.asyncio
async def test_token_budget_blocks_at_limit(isolated_db: Path) -> None:
    from app.db import init_db, log_usage
    from app.services.limits import check_token_budget
    from app.settings import settings

    original_limit = settings.session_token_limit
    settings.session_token_limit = 500
    try:
        await init_db()
        await log_usage(
            session_id="s2",
            kind="coding_solution",
            provider="openai",
            model="gpt-5",
            input_tokens=400,
            output_tokens=200,
        )
        result = await check_token_budget("s2")
        assert result.ok is False
        assert result.message is not None
        assert "limit" in result.message.lower()
        assert result.used == 600
    finally:
        settings.session_token_limit = original_limit


@pytest.mark.asyncio
async def test_token_budget_no_session_id() -> None:
    from app.services.limits import check_token_budget

    result = await check_token_budget(None)
    assert result.ok is True
