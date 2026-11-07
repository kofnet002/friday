"""Ingestors that turn project material into plain text for the brief.

Every ingestor returns an `Ingested` (title, text, meta). Text is redacted for
secrets before it is stored, so nothing downstream (brief generation, live
answer prompts) ever sees an API key that happened to be in a transcript.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Hard cap on what one source can contribute. A long Claude Code session or a
# big repo is condensed well below this; the cap only stops pathological
# inputs from bloating the DB and the brief call.
MAX_SOURCE_CHARS = 400_000


@dataclass
class Ingested:
    title: str
    text: str
    meta: dict[str, Any] = field(default_factory=dict)


class IngestError(ValueError):
    """User-facing ingestion failure (bad path, unsupported file, empty)."""


def resolve_local_path(raw: str) -> Path:
    """Expand and validate a user-supplied local path.

    The backend only ever runs on the candidate's machine, but it is still an
    HTTP server, so reads are confined to the user's home directory."""
    path = Path(raw).expanduser().resolve()
    home = Path.home().resolve()
    if path != home and home not in path.parents:
        raise IngestError("path must be inside your home directory")
    if not path.exists():
        raise IngestError(f"path does not exist: {path}")
    return path


def cap(text: str, limit: int = MAX_SOURCE_CHARS) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    return text[:limit] + "\n\n[… truncated …]", True
