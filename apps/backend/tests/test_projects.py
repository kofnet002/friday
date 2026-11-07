"""Project context: ingestion, redaction, brief generation, API, and how
attached projects reach the live answer prompt."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.prompts.answer_generation import AnswerContext, ProjectContext, answer_system_prompt
from app.services import project_brief
from app.services.context_sources import IngestError
from app.services.context_sources import claude_code as cc
from app.services.context_sources.claude_code import condense_transcript
from app.services.context_sources.folder import ingest_folder
from app.services.context_sources.redact import redact
from app.settings import settings


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake $HOME so path confinement and ~/.claude lookups hit tmp."""
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: tmp_path))
    return tmp_path


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    monkeypatch.setattr(settings, "sqlite_path", str(tmp_path / "test.db"))
    from app.main import app

    with TestClient(app) as c:
        yield c


# ------------------------------------------------------------------ redact


def test_redact_strips_provider_tokens_and_secret_assignments() -> None:
    text = (
        "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123\n"
        "export DB_PASSWORD='hunter2hunter2'\n"
        "curl -H 'Authorization: Bearer abcdefghijklmnop1234567890'\n"
        "postgres://admin:s3cretpass@db.internal:5432/app\n"
        "gemini AIzaSyA1234567890abcdefghijklmnopqrstuv\n"
        "the timeout is 300ms and we use Redis"
    )
    out = redact(text)
    for secret in ("sk-ant-api03", "hunter2", "abcdefghijklmnop1234", "s3cretpass", "AIzaSy"):
        assert secret not in out
    # Names and ordinary prose survive so the brief can still reference them.
    assert "ANTHROPIC_API_KEY" in out
    assert "DB_PASSWORD" in out
    assert "the timeout is 300ms and we use Redis" in out


# ------------------------------------------------------------- claude code


def _jsonl(*records: dict[str, Any]) -> list[str]:
    return [json.dumps(r) for r in records]


def test_condense_transcript_keeps_dialogue_and_shrinks_tools() -> None:
    lines = _jsonl(
        {"type": "user", "message": {"content": "Add retries to the Deepgram client"}},
        {
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "thinking", "thinking": "SECRET REASONING"},
                    {"type": "text", "text": "I'll use exponential backoff, not a fixed delay."},
                    {
                        "type": "tool_use",
                        "name": "Edit",
                        "input": {"file_path": "app/providers/deepgram.py"},
                    },
                    {
                        "type": "tool_use",
                        "name": "Bash",
                        "input": {"command": "uv run pytest", "description": "Run tests"},
                    },
                ]
            },
        },
        {
            "type": "user",
            "message": {"content": [{"type": "tool_result", "content": "HUGE TOOL OUTPUT " * 500}]},
        },
        {"type": "user", "isMeta": True, "message": {"content": "meta noise"}},
        {"type": "user", "message": {"content": "<system-reminder>ignore</system-reminder>"}},
    )
    lines.append("not json")
    out = condense_transcript(lines)
    assert "USER: Add retries to the Deepgram client" in out
    assert "CLAUDE: I'll use exponential backoff, not a fixed delay." in out
    assert "[edited: app/providers/deepgram.py]" in out
    assert "[ran: Run tests]" in out
    for dropped in ("SECRET REASONING", "HUGE TOOL OUTPUT", "meta noise", "system-reminder"):
        assert dropped not in out


def test_claude_code_listing_and_ingest(home: Path) -> None:
    proj = home / ".claude" / "projects" / "-Users-me-code-shop"
    proj.mkdir(parents=True)
    (proj / "s1.jsonl").write_text(
        "\n".join(
            _jsonl(
                {
                    "type": "user",
                    "cwd": "/Users/me/code/shop",
                    "message": {"content": "Build cart"},
                },
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "Done."}]}},
            )
        )
    )
    listing = cc.list_claude_code_projects()
    assert listing[0]["name"] == "shop"
    assert listing[0]["path"] == "/Users/me/code/shop"
    assert listing[0]["sessions"][0]["first_prompt"] == "Build cart"

    item = cc.ingest_claude_code("-Users-me-code-shop")
    assert "USER: Build cart" in item.text
    assert item.meta["cwd"] == "/Users/me/code/shop"

    with pytest.raises(IngestError):
        cc.ingest_claude_code("../../etc")


# ------------------------------------------------------------------ folder


def test_folder_ingest_reads_docs_skips_secrets_and_deps(home: Path) -> None:
    repo = home / "repo"
    (repo / "docs").mkdir(parents=True)
    (repo / "node_modules" / "left-pad").mkdir(parents=True)
    (repo / "src").mkdir()
    (repo / "README.md").write_text("# Shop\nA checkout service.")
    (repo / "docs" / "design.md").write_text("We chose Postgres over Mongo for transactions.")
    (repo / "package.json").write_text('{"name": "shop"}')
    (repo / ".env").write_text("STRIPE_KEY=sk_live_xxx")
    (repo / "node_modules" / "left-pad" / "index.js").write_text("module.exports = 1")
    (repo / "src" / "cart.ts").write_text("export const cart = []")

    item = ingest_folder(str(repo))
    assert "A checkout service." in item.text
    assert "Postgres over Mongo" in item.text
    assert '"name": "shop"' in item.text
    assert "src/cart.ts" in item.text  # in the tree…
    assert "export const cart" not in item.text  # …but code bodies aren't inlined
    assert "sk_live_xxx" not in item.text
    assert ".env" not in item.text
    assert "left-pad" not in item.text


def test_folder_ingest_rejects_paths_outside_home(home: Path) -> None:
    with pytest.raises(IngestError):
        ingest_folder("/etc")


# ------------------------------------------------------- folder locate


def test_locate_folder_ranks_by_contents_and_skips_dependency_dirs(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.context_sources import locate

    monkeypatch.setattr(locate, "_spotlight", lambda _name, _home: None)  # force the walk
    real = home / "code" / "shop"
    (real / "src").mkdir(parents=True)
    (real / "package.json").write_text("{}")
    (real / "README.md").write_text("x")
    other = home / "Documents" / "old" / "shop"
    other.mkdir(parents=True)
    (other / "README.md").write_text("x")
    (home / "code" / "node_modules" / "shop").mkdir(parents=True)
    (home / ".Trash" / "shop").mkdir(parents=True)

    found = locate.locate_folder("shop/", ["src", "package.json", "README.md"])
    assert [c.path for c in found] == [str(real.resolve()), str(other.resolve())]
    assert found[0].score == 1.0
    assert found[1].score == pytest.approx(1 / 3, abs=0.01)

    with pytest.raises(IngestError):
        locate.locate_folder("../etc", [])


def test_locate_endpoint(client: Any, home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.context_sources import locate

    monkeypatch.setattr(locate, "_spotlight", lambda _name, _home: None)
    (home / "work" / "api").mkdir(parents=True)
    r = client.post("/api/folders/locate", json={"name": "api", "children": []})
    assert r.status_code == 200
    assert r.json()["candidates"] == [
        {"path": str((home / "work" / "api").resolve()), "score": 1.0}
    ]
    assert client.post("/api/folders/locate", json={"name": "a/b"}).status_code == 400


# -------------------------------------------------------- answer prompt


def test_answer_prompt_includes_projects_and_rules_only_when_attached() -> None:
    bare = answer_system_prompt(AnswerContext())
    assert "PROJECT QUESTIONS" not in bare
    assert "<candidate_projects>" not in bare

    with_project = answer_system_prompt(
        AnswerContext(projects=(ProjectContext(name="Shop", brief="## What & why\nCheckout."),))
    )
    assert "PROJECT QUESTIONS" in with_project
    assert '<project_context name="Shop">' in with_project
    assert "Checkout." in with_project


# ------------------------------------------------------------ API + brief


def _create_with_text(client: Any, text: str = "We use Redis for sessions.") -> str:
    pid = client.post("/api/projects", json={"name": "Shop"}).json()["project"]["id"]
    r = client.post(f"/api/projects/{pid}/sources", json={"kind": "text", "text": text})
    assert r.status_code == 200, r.text
    return str(pid)


def _wait_for_brief(client: Any, pid: str) -> dict[str, Any]:
    for _ in range(100):
        project: dict[str, Any] = client.get(f"/api/projects/{pid}").json()["project"]
        if project["brief_status"] != "generating":
            return project
        time.sleep(0.02)
    raise AssertionError("brief never finished")


def test_project_lifecycle(client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def fake_complete(system: str, user: str, max_tokens: int) -> tuple[str, int, int]:
        calls.append(user)
        return "## What & why\nA shop.", 100, 20

    monkeypatch.setattr(project_brief, "_complete", fake_complete)

    pid = _create_with_text(client, "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 here")
    detail = client.get(f"/api/projects/{pid}").json()
    assert detail["sources"][0]["kind"] == "text"

    # Generate → ready. (The source held a token; it was redacted on ingest,
    # so the model never sees it.)
    r = client.post(f"/api/projects/{pid}/brief", json={})
    assert r.status_code == 200
    project = _wait_for_brief(client, pid)
    assert project["brief_status"] == "ready"
    assert project["brief"] == "## What & why\nA shop."
    assert "sk-ant-api03" not in calls[0]

    # Adding a source marks the brief stale.
    client.post(f"/api/projects/{pid}/sources", json={"kind": "text", "text": "More notes"})
    assert client.get(f"/api/projects/{pid}").json()["project"]["brief_status"] == "stale"

    # Hand edits are protected from regeneration unless forced.
    client.patch(f"/api/projects/{pid}", json={"brief": "my edit"})
    assert client.post(f"/api/projects/{pid}/brief", json={}).status_code == 409
    assert client.post(f"/api/projects/{pid}/brief", json={"force": True}).status_code == 200
    _wait_for_brief(client, pid)

    # Attach to a session; deleting the project detaches it.
    r = client.put("/api/sessions/s1/projects", json={"project_ids": [pid]})
    assert [p["id"] for p in r.json()["projects"]] == [pid]
    assert (
        client.put("/api/sessions/s1/projects", json={"project_ids": ["nope"]}).status_code == 404
    )
    assert client.delete(f"/api/projects/{pid}").status_code == 200
    assert client.get("/api/sessions/s1/projects").json()["projects"] == []


def test_brief_error_is_surfaced(client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(system: str, user: str, max_tokens: int) -> tuple[str, int, int]:
        raise RuntimeError("no credential")

    monkeypatch.setattr(project_brief, "_complete", boom)
    pid = _create_with_text(client)
    client.post(f"/api/projects/{pid}/brief", json={})
    project = _wait_for_brief(client, pid)
    assert project["brief_status"] == "error"
    assert "no credential" in project["brief_error"]


def test_brief_requires_sources(client: Any) -> None:
    pid = client.post("/api/projects", json={"name": "Empty"}).json()["project"]["id"]
    assert client.post(f"/api/projects/{pid}/brief", json={}).status_code == 400


async def test_large_projects_condense_sources_first(
    client: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(project_brief, "SINGLE_CALL_MAX_CHARS", 50)
    pid = _create_with_text(client, "x" * 40)
    client.post(f"/api/projects/{pid}/sources", json={"kind": "text", "text": "y" * 40})
    systems: list[str] = []

    async def fake(system: str, user: str, max_tokens: int) -> tuple[str, int, int]:
        systems.append(system)
        return "notes", 0, 0

    await project_brief.generate_brief(pid, complete=fake)
    assert systems.count(project_brief.SOURCE_NOTES_SYSTEM) == 2
    assert systems[-2:] == [project_brief.PROJECT_BRIEF_SYSTEM, project_brief.BRIEF_VERIFY_SYSTEM]


async def test_verify_pass_failure_keeps_draft(client: Any) -> None:
    pid = _create_with_text(client)

    async def fake(system: str, user: str, max_tokens: int) -> tuple[str, int, int]:
        if system == project_brief.BRIEF_VERIFY_SYSTEM:
            assert "<draft_brief>\nDRAFT\n</draft_brief>" in user
            raise RuntimeError("overloaded")
        return "DRAFT", 0, 0

    assert await project_brief.generate_brief(pid, complete=fake) == "DRAFT"


# ------------------------------------------------- live answer context


async def test_load_project_contexts_budget(client: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.db import set_session_projects, update_project
    from app.services.project_context import load_project_contexts

    pid = _create_with_text(client, "raw notes " * 10)
    await set_session_projects("s2", [pid])

    # No brief yet, small sources → raw text so the project is usable now.
    (ctx,) = await load_project_contexts("s2")
    assert ctx.brief is None and ctx.raw_text and "raw notes" in ctx.raw_text

    await update_project(pid, brief="the brief", brief_status="ready")
    (ctx,) = await load_project_contexts("s2")
    assert ctx.brief == "the brief" and ctx.raw_text

    # Over budget → brief only.
    monkeypatch.setattr(settings, "project_raw_budget_chars", 10)
    (ctx,) = await load_project_contexts("s2")
    assert ctx.brief == "the brief" and ctx.raw_text is None

    # A failed regeneration keeps serving the previous brief.
    await update_project(pid, brief_status="error")
    (ctx,) = await load_project_contexts("s2")
    assert ctx.brief == "the brief"

    assert await load_project_contexts(None) == ()
    assert await load_project_contexts("unattached") == ()


# ------------------------------------------------------------ code citations


def test_chunk_file_splits_on_definitions_and_keeps_decorators() -> None:
    from app.services.context_sources.code_index import chunk_file

    src = "\n".join(
        [
            "import os",
            "import sys",
            "",
            "@decorator",
            "def alpha(x):",
            "    def inner():",
            "        return 1",
            "    return inner() + x",
            "    # padding",
            "    # padding",
            "",
            "class Beta:",
            "    def method(self):",
            "        return 2",
            "    # padding",
            "    # padding",
            "    # padding",
        ]
    )
    chunks = chunk_file("pkg/mod.py", src)
    # Imports are too small on their own and merge into the first def.
    assert [(c.start_line, c.end_line) for c in chunks] == [(1, 11 - 1), (12, 17)]
    assert "@decorator" in chunks[0].text and "def inner" in chunks[0].text
    assert chunks[1].symbol == "class Beta:"
    assert all(c.path == "pkg/mod.py" for c in chunks)


def test_long_blocks_become_overlapping_windows() -> None:
    from app.services.context_sources.code_index import WINDOW_LINES, chunk_file

    body = "def huge():\n" + "\n".join(f"    x{i} = {i}" for i in range(300))
    chunks = chunk_file("big.py", body)
    assert len(chunks) > 1
    assert chunks[0].start_line == 1 and chunks[0].end_line == WINDOW_LINES
    assert chunks[1].start_line < chunks[0].end_line  # overlap
    assert chunks[-1].end_line == 301


def test_match_expression_splits_identifiers_and_drops_stopwords() -> None:
    from app.services.code_search import match_expression

    expr = match_expression("How does generateBrief call the verify_pass?")
    for term in ('"generatebrief"', '"generate"', '"brief"', '"verify_pass"', '"verify"', '"pass"'):
        assert term in expr
    assert '"how"' not in expr and '"does"' not in expr and '"the"' not in expr
    assert match_expression("why is it?") == ""


async def test_folder_source_indexes_code_and_answers_cite_it(client: Any, home: Path) -> None:
    from app.db import set_session_projects
    from app.prompts.answer_generation import answer_user_prompt
    from app.services.code_search import find_code_refs

    repo = home / "shop"
    (repo / "src").mkdir(parents=True)
    (repo / "README.md").write_text("# Shop")
    (repo / "src" / "cart.py").write_text(
        "import decimal\n\n\n"
        "def apply_discount(cart, code):\n"
        "    '''Coupons are capped at 30% to protect margin.'''\n"
        "    pct = min(lookup(code), 30)\n"
        "    return cart.total * (100 - pct) / 100\n"
        "\n\n"
        "def checkout(cart):\n"
        "    return charge(cart)\n"
        "    # padding\n"
        "    # padding\n"
        "    # padding\n"
    )
    pid = client.post("/api/projects", json={"name": "Shop"}).json()["project"]["id"]
    r = client.post(f"/api/projects/{pid}/sources", json={"kind": "folder", "path": str(repo)})
    assert r.status_code == 200, r.text
    source = r.json()["sources"][0]
    assert source["code_chunks"] >= 2
    detail = client.get(f"/api/projects/{pid}").json()
    assert detail["sources"][0]["meta"]["code_chunks"] == source["code_chunks"]

    refs = await find_code_refs([pid], "Why are discount coupons capped?")
    assert refs[0].path == "src/cart.py"
    assert refs[0].start_line == 1 and "apply_discount" in refs[0].code
    assert refs[0].root == str(repo.resolve())

    # Refs go in the per-question user turn, with exact path + lines.
    user = answer_user_prompt("Why are coupons capped?", code_refs=refs)
    assert f'<code_reference path="src/cart.py" lines="1-{refs[0].end_line}">' in user

    # Other projects' code is never returned; deleting the source drops its index.
    assert await find_code_refs(["other"], "discount coupons") == ()
    await set_session_projects("s3", [pid])
    client.delete(f"/api/projects/{pid}/sources/{source['id']}")
    assert await find_code_refs([pid], "discount coupons") == ()


def test_citation_rules_only_with_projects() -> None:
    assert "CITING CODE" not in answer_system_prompt(AnswerContext())
    with_project = answer_system_prompt(
        AnswerContext(projects=(ProjectContext(name="Shop", brief="b"),))
    )
    assert "CITING CODE" in with_project and "📎 Source" in with_project


def test_hint_identifiers_prefer_precise_sentences_over_transcript_blobs() -> None:
    from app.services.code_search import hint_identifiers

    blob = "CLAUDE: " + " ".join(
        ["the app decides api subscription claude call goes `candidate_background` db.py"] * 12
    )
    brief = "Transport is decided in one place: `claude_transport()` in `services/claude_api.py`."
    hints = f"{blob}\n## Architecture\n- {brief}\n"
    idents = hint_identifiers(
        "How does the app decide whether a Claude call goes through the API or the subscription?",
        hints,
    )
    assert "claude_transport" in idents and "claude_api" in idents
    assert "candidate_background" not in idents
