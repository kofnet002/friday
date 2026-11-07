"""Find a folder the user dropped in a plain browser tab.

Browsers hide the absolute path of a dropped folder, but the page can read
the folder's name and the names of its entries. Friday's backend runs on
the same Mac, so it can look the folder up: Spotlight (`mdfind`) for
folders with that name under $HOME, with a bounded directory walk as a
fallback, then rank candidates by how many of the dropped folder's entries
they contain. The caller only auto-picks a confident, unambiguous match."""

from __future__ import annotations

import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from app.services.context_sources import IngestError
from app.services.context_sources.folder import SKIP_DIRS

MAX_CANDIDATES = 50
MDFIND_TIMEOUT_S = 3.0
WALK_MAX_DEPTH = 5
WALK_BUDGET_S = 2.0
# Places a project folder never lives, which a walk would waste time in.
_SKIP_TOP = frozenset({"Library", "Applications", "Pictures", "Music", "Movies"})


@dataclass
class FolderCandidate:
    path: str
    score: float  # share of the dropped folder's entries present here (0 to 1)


def _valid_name(name: str) -> bool:
    return bool(name) and name not in {".", ".."} and "/" not in name and "\0" not in name


def _ignored(path: Path, home: Path) -> bool:
    try:
        parts = path.relative_to(home).parts
    except ValueError:
        return True
    if parts and parts[0] in _SKIP_TOP:
        return True
    # A dot-dir or dependency dir anywhere above it (the folder itself may
    # legitimately start with a dot only if the user dropped such a folder).
    return any(p.startswith(".") or p in SKIP_DIRS for p in parts[:-1])


def _spotlight(name: str, home: Path) -> list[Path] | None:
    """Folders named `name` under home, or None when Spotlight isn't usable."""
    mdfind = shutil.which("mdfind")
    if not mdfind:
        return None
    escaped = name.replace("\\", "\\\\").replace("'", "\\'")
    query = f"kMDItemFSName == '{escaped}' && kMDItemContentTypeTree == 'public.folder'"
    try:
        out = subprocess.run(  # noqa: S603 - fixed argv, no shell; name is quoted
            [mdfind, "-onlyin", str(home), query],
            capture_output=True,
            text=True,
            timeout=MDFIND_TIMEOUT_S,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return [Path(line) for line in out.stdout.splitlines() if line.strip()]


def _walk_for(name: str, home: Path) -> list[Path]:
    """Breadth-first search for folders named `name`, bounded by depth and time."""
    deadline = time.monotonic() + WALK_BUDGET_S
    found: list[Path] = []
    frontier = [home]
    for _depth in range(WALK_MAX_DEPTH):
        nxt: list[Path] = []
        for d in frontier:
            if time.monotonic() > deadline:
                return found
            try:
                entries = list(d.iterdir())
            except OSError:
                continue
            for e in entries:
                try:
                    if not e.is_dir() or e.is_symlink():
                        continue
                except OSError:
                    continue
                if e.name == name:
                    found.append(e)
                if e.name.startswith(".") or e.name in SKIP_DIRS:
                    continue
                if d == home and e.name in _SKIP_TOP:
                    continue
                nxt.append(e)
        frontier = nxt
    return found


def _score(path: Path, children: set[str]) -> float:
    if not children:
        return 1.0
    try:
        present = {e.name for e in path.iterdir()}
    except OSError:
        return 0.0
    return len(children & present) / len(children)


def locate_folder(name: str, children: list[str]) -> list[FolderCandidate]:
    """Folders under $HOME named `name`, best match first."""
    name = name.strip().rstrip("/")
    if not _valid_name(name):
        raise IngestError("invalid folder name")
    home = Path.home().resolve()
    hits = _spotlight(name, home)
    if not hits:
        hits = _walk_for(name, home)
    wanted = {c for c in children if c and "/" not in c}
    seen: set[Path] = set()
    out: list[FolderCandidate] = []
    for hit in hits[: MAX_CANDIDATES * 4]:
        try:
            path = hit.resolve()
        except OSError:
            continue
        if path in seen or path.name != name or not path.is_dir() or _ignored(path, home):
            continue
        seen.add(path)
        out.append(FolderCandidate(path=str(path), score=round(_score(path, wanted), 3)))
    out.sort(key=lambda c: (-c.score, len(c.path)))
    return out[:MAX_CANDIDATES]
