"""A local project folder: docs, manifests, file tree and recent git history.

Deliberately NOT the whole codebase — reviewers ask about intent,
architecture and tradeoffs, which live in READMEs, docs, manifests and commit
messages. The tree gives the model the shape of the code without its bulk.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from app.services.context_sources import Ingested, IngestError, cap, resolve_local_path

SKIP_DIRS = frozenset(
    {
        ".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist",
        "build", "out", ".turbo", ".cache", "coverage", ".mypy_cache",
        ".pytest_cache", ".ruff_cache", "target", ".idea", ".vscode", "vendor",
        ".gradle", "Pods", ".expo", ".svelte-kit", ".nuxt",
    }
)  # fmt: skip
# Never read these, even if they're plain text.
SECRET_NAMES = (".env", ".npmrc", ".pypirc", "id_rsa", "id_ed25519", ".netrc")
SECRET_SUFFIXES = (".pem", ".key", ".p12", ".pfx", ".keystore")

MANIFESTS = (
    "package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml",
    "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json",
    "docker-compose.yml", "docker-compose.yaml", "Dockerfile", "turbo.json",
    "pnpm-workspace.yaml", "CLAUDE.md", "AGENTS.md",
)  # fmt: skip
DOC_EXTENSIONS = (".md", ".markdown", ".rst", ".txt")

MAX_TREE_ENTRIES = 600
MAX_DOC_CHARS = 30_000  # per document
MAX_DOCS_TOTAL = 150_000


def _is_secret(path: Path) -> bool:
    name = path.name.lower()
    return name.startswith(SECRET_NAMES) or name.endswith(SECRET_SUFFIXES)


def _walk(root: Path, limit: int = MAX_TREE_ENTRIES * 4) -> list[Path]:
    out: list[Path] = []
    stack = [root]
    while stack and len(out) < limit:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for entry in entries:
            if entry.is_symlink():
                continue
            if entry.is_dir():
                if entry.name not in SKIP_DIRS and not entry.name.startswith("."):
                    stack.append(entry)
            elif not _is_secret(entry):
                out.append(entry)
    return sorted(out)


def _tree(root: Path, files: list[Path]) -> str:
    rels = [str(f.relative_to(root)) for f in files]
    shown = rels[:MAX_TREE_ENTRIES]
    more = len(rels) - len(shown)
    return "\n".join(shown) + (f"\n… and {more} more files" if more > 0 else "")


def _git(root: Path, *args: str) -> str:
    try:
        # Fixed argv (no shell); `root` is a validated path under $HOME.
        result = subprocess.run(  # noqa: S603
            ["git", "-C", str(root), *args],  # noqa: S607
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def _read(path: Path, limit: int) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return text if len(text) <= limit else text[:limit] + "\n[… truncated …]"


def ingest_folder(raw_path: str, *, include_diff: bool = False) -> Ingested:
    root = resolve_local_path(raw_path)
    if not root.is_dir():
        raise IngestError("folder path is not a directory")
    files = _walk(root)
    if not files:
        raise IngestError("folder has no readable files")

    sections: list[str] = [f"# Project folder: {root.name}\nPath: {root}"]

    branch = _git(root, "rev-parse", "--abbrev-ref", "HEAD")
    log = _git(root, "log", "--oneline", "--no-decorate", "-60")
    if branch or log:
        sections.append(f"## Git\nBranch: {branch or '?'}\n\nRecent commits:\n{log}")

    sections.append(f"## File tree\n{_tree(root, files)}")

    docs_budget = MAX_DOCS_TOTAL
    picked: list[Path] = []
    for f in files:
        rel = f.relative_to(root)
        top_level = len(rel.parts) == 1
        is_manifest = f.name in MANIFESTS and len(rel.parts) <= 3
        is_doc = f.suffix.lower() in DOC_EXTENSIONS and (
            top_level
            or rel.parts[0].lower() in ("docs", "doc", "adr", "design")
            or f.name.lower().startswith("readme")
        )
        if is_manifest or is_doc:
            picked.append(f)
    # READMEs first, then docs, then manifests.
    picked.sort(key=lambda p: (not p.name.lower().startswith("readme"), p.name in MANIFESTS))
    for f in picked:
        if docs_budget <= 0:
            break
        body = _read(f, min(MAX_DOC_CHARS, docs_budget))
        if body.strip():
            docs_budget -= len(body)
            sections.append(f"## {f.relative_to(root)}\n{body}")

    if include_diff:
        base = _git(root, "merge-base", "HEAD", "origin/HEAD") or _git(
            root, "merge-base", "HEAD", "main"
        )
        if base:
            stat = _git(root, "diff", "--stat", base, "HEAD")
            diff = _git(root, "diff", base, "HEAD")
            if stat:
                diff, _ = cap(diff, 120_000)
                sections.append(f"## Changes vs base branch\n{stat}\n\n{diff}")

    text, truncated = cap("\n\n".join(sections))
    return Ingested(
        title=root.name,
        text=text,
        meta={"path": str(root), "files": len(files), "truncated": truncated},
    )
