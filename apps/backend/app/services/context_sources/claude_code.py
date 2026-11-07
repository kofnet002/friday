"""Claude Code session transcripts (~/.claude/projects/<dir>/<session>.jsonl).

Several Claude Code profiles can live side by side (one config dir per
account via CLAUDE_CONFIG_DIR: ~/.claude, ~/.claude-work, …); every one
with a projects/ folder is listed, labelled by profile.

The transcript is where the *why* lives: what was asked, what was tried,
what broke and how it got fixed. We keep the human prompts and Claude's
prose, shrink every tool call to one line ("edited app/db.py", "ran pytest"),
and drop tool output and thinking — tool output is most of the bytes and
almost none of the reasoning.
"""

from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.services.context_sources import Ingested, IngestError, cap

# Long assistant messages are usually plans and design rationale — the
# most valuable part of a transcript — so the per-message cap is generous.
MAX_TEXT_PER_MESSAGE = 12_000
MAX_SESSION_CHARS = 200_000


DEFAULT_CONFIG_DIR = ".claude"


def claude_config_dirs() -> dict[str, Path]:
    """Claude Code config dirs with a projects/ folder, keyed by their path
    relative to $HOME (".claude", ".claude-work"). Covers ~/.claude* and
    $CLAUDE_CONFIG_DIR; anything outside $HOME is ignored."""
    home = Path.home().resolve()
    candidates = sorted(home.glob(".claude*"))
    env = os.environ.get("CLAUDE_CONFIG_DIR")
    if env:
        candidates.append(Path(env).expanduser())
    found: dict[str, Path] = {}
    seen: set[Path] = set()
    for c in candidates:
        try:
            real = c.resolve()
        except OSError:
            continue
        if real in seen or home not in real.parents or not (real / "projects").is_dir():
            continue
        seen.add(real)
        found[real.relative_to(home).as_posix()] = real
    return found


def profile_label(config_key: str) -> str:
    """Profile label: .claude -> "default", .claude-work -> "work"."""
    if config_key == DEFAULT_CONFIG_DIR:
        return "default"
    name = config_key.rsplit("/", 1)[-1]
    return name.removeprefix(".claude-").removeprefix(".claude_").lstrip(".") or config_key


def _split_key(project_key: str) -> tuple[str, str]:
    """Split "<config dir>/<project dir>" into its two parts. A bare
    project dir (older clients) means the default ~/.claude."""
    if "/" in project_key:
        config_key, project_dir = project_key.rsplit("/", 1)
        return config_key, project_dir
    return DEFAULT_CONFIG_DIR, project_key


def _decode_dir(name: str) -> str:
    """Claude Code stores /Users/me/code/app as -Users-me-code-app. The
    mapping is lossy (dashes in names), so prefer the `cwd` recorded inside
    the transcript when one is available."""
    return "/" + name.lstrip("-").replace("-", "/")


def _session_cwd_and_summary(path: Path) -> tuple[str | None, str | None]:
    cwd: str | None = None
    first_prompt: str | None = None
    try:
        with path.open(encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 200 or (cwd and first_prompt):
                    break
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not cwd and isinstance(rec.get("cwd"), str):
                    cwd = rec["cwd"]
                if not first_prompt and rec.get("type") == "user":
                    text = _user_text(rec)
                    if text:
                        first_prompt = text[:160]
    except OSError:
        pass
    return cwd, first_prompt


def list_claude_code_projects() -> list[dict[str, Any]]:
    projects: list[dict[str, Any]] = []
    for config_key, config_dir in claude_config_dirs().items():
        projects.extend(_list_profile(config_key, config_dir / "projects"))
    projects.sort(key=lambda p: p["modified_at"], reverse=True)
    return projects


def _list_profile(config_key: str, root: Path) -> list[dict[str, Any]]:
    projects: list[dict[str, Any]] = []
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        sessions = sorted(d.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not sessions:
            continue
        rows = []
        cwd: str | None = None
        for s in sessions[:50]:
            st = s.stat()
            s_cwd, summary = _session_cwd_and_summary(s)
            cwd = cwd or s_cwd
            rows.append(
                {
                    "id": s.stem,
                    "bytes": st.st_size,
                    "modified_at": st.st_mtime,
                    "first_prompt": summary,
                }
            )
        path = cwd or _decode_dir(d.name)
        projects.append(
            {
                "dir": f"{config_key}/{d.name}",
                "profile": profile_label(config_key),
                "path": path,
                "name": Path(path).name,
                "sessions": rows,
                "modified_at": rows[0]["modified_at"],
            }
        )
    return projects


def _user_text(rec: dict[str, Any]) -> str:
    """Human-typed text of a `user` record ('' for tool results / meta)."""
    if rec.get("isMeta") or rec.get("isCompactSummary"):
        return ""
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(
            b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
        )
    else:
        return ""
    text = text.strip()
    # Harness-injected wrappers (command output, reminders, hook output).
    if text.startswith(("<command-", "<local-command", "<system-reminder", "Caveat:")):
        return ""
    return text


def _tool_line(block: dict[str, Any]) -> str:
    name = str(block.get("name") or "tool")
    raw_input = block.get("input")
    inp: dict[str, Any] = raw_input if isinstance(raw_input, dict) else {}
    target = (
        inp.get("file_path")
        or inp.get("path")
        or inp.get("notebook_path")
        or inp.get("pattern")
        or inp.get("url")
        or inp.get("query")
    )
    if name == "Bash":
        desc = inp.get("description") or ""
        cmd = str(inp.get("command") or "").splitlines()[0][:140] if inp.get("command") else ""
        return f"[ran: {desc or cmd}]" if (desc or cmd) else "[ran a shell command]"
    verb = {
        "Edit": "edited",
        "MultiEdit": "edited",
        "Write": "wrote",
        "Read": "read",
        "Grep": "searched",
        "Glob": "listed",
        "WebFetch": "fetched",
        "WebSearch": "searched web",
        "Agent": "delegated",
        "Task": "delegated",
    }.get(name, name)
    if name in ("Agent", "Task"):
        target = inp.get("description") or target
    return f"[{verb}: {target}]" if target else f"[{verb}]"


def condense_transcript(lines: list[str]) -> str:
    """Condense raw JSONL lines into a readable dialogue."""
    out: list[str] = []
    pending_tools: list[str] = []

    def flush_tools() -> None:
        if pending_tools:
            # Collapse runs of tool calls into one line.
            out.append("Claude actions: " + " ".join(pending_tools[:25]))
            if len(pending_tools) > 25:
                out[-1] += f" … (+{len(pending_tools) - 25} more)"
            pending_tools.clear()

    for line in lines:
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = rec.get("type")
        if kind == "summary" and rec.get("summary"):
            flush_tools()
            out.append(f"(Session summary: {rec['summary']})")
        elif kind == "user":
            text = _user_text(rec)
            if text:
                flush_tools()
                out.append(f"USER: {text[:MAX_TEXT_PER_MESSAGE]}")
        elif kind == "assistant":
            content = (rec.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and str(block.get("text", "")).strip():
                    flush_tools()
                    out.append(f"CLAUDE: {block['text'].strip()[:MAX_TEXT_PER_MESSAGE]}")
                elif block.get("type") == "tool_use":
                    pending_tools.append(_tool_line(block))
    flush_tools()
    return "\n\n".join(out)


def _keep_tail(text: str, limit: int) -> str:
    """Over budget → keep the start (the original ask) and the most recent
    part (where the final decisions are)."""
    if len(text) <= limit:
        return text
    head = limit // 4
    tail = limit - head
    return text[:head] + "\n\n[… middle of session omitted …]\n\n" + text[-tail:]


def ingest_claude_code(project_key: str, session_ids: list[str] | None = None) -> Ingested:
    config_key, project_dir = _split_key(project_key)
    config_dir = claude_config_dirs().get(config_key)
    if config_dir is None:
        raise IngestError("unknown Claude Code profile")
    root = (config_dir / "projects").resolve()
    base = (root / project_dir).resolve()
    if base.parent != root or not base.is_dir():
        raise IngestError("unknown Claude Code project")
    files = sorted(base.glob("*.jsonl"), key=lambda p: p.stat().st_mtime)
    if session_ids:
        wanted = set(session_ids)
        files = [f for f in files if f.stem in wanted]
    if not files:
        raise IngestError("no Claude Code sessions selected")

    per_session = max(20_000, MAX_SESSION_CHARS // max(1, len(files)))
    parts: list[str] = []
    cwd: str | None = None
    for f in files:
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        s_cwd, _ = _session_cwd_and_summary(f)
        cwd = cwd or s_cwd
        body = condense_transcript(lines)
        if not body:
            continue
        when = datetime.fromtimestamp(f.stat().st_mtime, tz=UTC).strftime("%Y-%m-%d")
        parts.append(
            f"## Claude Code session {f.stem[:8]} ({when})\n{_keep_tail(body, per_session)}"
        )
    if not parts:
        raise IngestError("selected sessions contain no conversation")

    name = Path(cwd).name if cwd else _decode_dir(project_dir).rsplit("/", 1)[-1]
    text, truncated = cap("\n\n".join(parts))
    return Ingested(
        title=f"Claude Code: {name} ({len(parts)} session{'s' if len(parts) != 1 else ''})",
        text=text,
        meta={
            "dir": project_key,
            "profile": profile_label(config_key),
            "cwd": cwd,
            "sessions": [f.stem for f in files],
            "truncated": truncated,
        },
    )
