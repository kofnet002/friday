"""Split a repository's source files into citable chunks.

Each chunk is a function / class / top-level block with its repo-relative
path and 1-based line range, so a live answer can say "this is in
`app/services/project_brief.py:88-121`" and show the lines. Chunks are
indexed in SQLite FTS5 (db.py) and retrieved per question
(services/code_search.py)."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from app.services.context_sources.folder import _walk
from app.services.context_sources.redact import redact

CODE_EXTENSIONS = frozenset(
    {
        ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs",
        ".java", ".kt", ".swift", ".rb", ".php", ".cs", ".cpp", ".cc", ".c",
        ".h", ".hpp", ".m", ".mm", ".scala", ".sql", ".sh", ".vue", ".svelte",
        ".css", ".scss", ".toml", ".yaml", ".yml",
    }
)  # fmt: skip
SKIP_NAMES = frozenset(
    {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "poetry.lock", "Cargo.lock"}
)
MAX_FILE_BYTES = 200_000
MAX_FILES = 3_000
MAX_CHUNKS = 20_000
MIN_CHUNK_LINES = 6
MAX_CHUNK_LINES = 120
WINDOW_LINES = 80
WINDOW_OVERLAP = 10

# Lines that start a new top-level definition, by language family. Only
# column-0 matches count, so nested defs stay inside their parent chunk.
_PY_DEF = re.compile(r"^(?:async\s+def|def|class)\s+\w")
_JS_DEF = re.compile(
    r"^(?:export\s+)?(?:default\s+)?(?:async\s+)?"
    r"(?:function\*?|class|interface|type|enum|const|let|var)\s+[\w$]"
)
_GO_DEF = re.compile(r"^(?:func|type)\s")
_RS_DEF = re.compile(r"^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\b")
_C_LIKE_DEF = re.compile(
    r"^(?:public|private|protected|internal|static|final|abstract|class|interface|"
    r"struct|enum|func|fun|def|object|@interface|@implementation)\b"
)
_DEF_BY_EXT: dict[str, re.Pattern[str]] = {
    ".py": _PY_DEF,
    ".ts": _JS_DEF,
    ".tsx": _JS_DEF,
    ".js": _JS_DEF,
    ".jsx": _JS_DEF,
    ".mjs": _JS_DEF,
    ".cjs": _JS_DEF,
    ".vue": _JS_DEF,
    ".svelte": _JS_DEF,
    ".go": _GO_DEF,
    ".rs": _RS_DEF,
}
# Decorators / doc comments directly above a definition belong to it.
_LEAD_IN = re.compile(r"^(?:@|#\[|//|/\*\*|\*|///)")


@dataclass
class CodeChunk:
    path: str  # repo-relative, forward slashes
    start_line: int  # 1-based, inclusive
    end_line: int  # 1-based, inclusive
    symbol: str  # first line of the chunk (signature), trimmed
    text: str


def _def_pattern(ext: str) -> re.Pattern[str] | None:
    if ext in _DEF_BY_EXT:
        return _DEF_BY_EXT[ext]
    if ext in {".java", ".kt", ".swift", ".cs", ".scala", ".m", ".mm", ".php", ".rb"}:
        return _C_LIKE_DEF
    return None


def _boundaries(lines: list[str], pattern: re.Pattern[str] | None) -> list[int]:
    """0-based start indices of top-level blocks (always includes 0)."""
    starts = [0]
    if pattern is None:
        return starts
    for i, line in enumerate(lines):
        if i and pattern.match(line):
            j = i
            while j - 1 > starts[-1] and _LEAD_IN.match(lines[j - 1]):
                j -= 1
            if j > starts[-1]:
                starts.append(j)
    return starts


def _windows(start: int, end: int) -> list[tuple[int, int]]:
    """Split [start, end) into overlapping windows of WINDOW_LINES."""
    out: list[tuple[int, int]] = []
    i = start
    while i < end:
        j = min(end, i + WINDOW_LINES)
        out.append((i, j))
        if j == end:
            break
        i = j - WINDOW_OVERLAP
    return out


def chunk_file(rel_path: str, text: str) -> list[CodeChunk]:
    lines = text.splitlines()
    if not lines:
        return []
    ext = Path(rel_path).suffix.lower()
    starts = _boundaries(lines, _def_pattern(ext))
    spans = [
        (s, starts[k + 1] if k + 1 < len(starts) else len(lines)) for k, s in enumerate(starts)
    ]

    # Merge tiny blocks (imports, one-line consts) into their successor.
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if merged and merged[-1][1] - merged[-1][0] < MIN_CHUNK_LINES:
            merged[-1] = (merged[-1][0], e)
        else:
            merged.append((s, e))

    chunks: list[CodeChunk] = []
    for s, e in merged:
        # Trim trailing blank lines so line ranges are tight.
        while e > s and not lines[e - 1].strip():
            e -= 1
        if e <= s:
            continue
        pieces = [(s, e)] if e - s <= MAX_CHUNK_LINES else _windows(s, e)
        for ps, pe in pieces:
            body = "\n".join(lines[ps:pe])
            if not body.strip():
                continue
            symbol = next((ln.strip() for ln in lines[ps:pe] if ln.strip()), "")[:120]
            chunks.append(
                CodeChunk(
                    path=rel_path,
                    start_line=ps + 1,
                    end_line=pe,
                    symbol=symbol,
                    text=redact(body),
                )
            )
    return chunks


def _looks_minified(text: str) -> bool:
    lines = text.splitlines() or [""]
    return len(text) / len(lines) > 300


def chunk_repo(root: Path) -> list[CodeChunk]:
    out: list[CodeChunk] = []
    files = [
        f
        for f in _walk(root, limit=MAX_FILES * 10)
        if f.suffix.lower() in CODE_EXTENSIONS and f.name not in SKIP_NAMES
    ][:MAX_FILES]
    for f in files:
        try:
            if f.stat().st_size > MAX_FILE_BYTES:
                continue
            text = f.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if _looks_minified(text):
            continue
        out.extend(chunk_file(f.relative_to(root).as_posix(), text))
        if len(out) >= MAX_CHUNKS:
            return out[:MAX_CHUNKS]
    return out
