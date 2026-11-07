"""Find the code blocks that answer a live question.

Runs on every answer for a session with attached projects, so it must be
fast and must never fail the answer: one FTS5 query (single-digit ms),
no model calls. Retrieved chunks go into the USER turn, not the system
prompt — they change per question, and the system prompt must stay
byte-identical for prompt caching."""

from __future__ import annotations

import math
import re

from app.db import search_code_chunks
from app.logging import log
from app.prompts.answer_generation import CodeRef

MAX_REFS = 4
MAX_PER_FILE = 2
MAX_TOTAL_CHARS = 9_000
MAX_REF_CHARS = 3_000
CANDIDATES = 24
MAX_TERMS = 24

_STOPWORDS = frozenset(
    """
    a about above after again all also am an and any are as at be because been before
    being below between both but by can could did do does doing done down during each
    else even ever every few for from further get got had has have having he her here
    hers him his how however i if in into is it its itself just let like made make many
    may me might more most much must my need no nor not now of off on once only or other
    our out over own please really same say said see she should show so some such tell
    than that the their them then there these they thing things this those through to
    too under until up us use used using very via walk want was way we well were what
    when where which while who whom why will with within without would yes yet you your
    yours actually kind sort basically okay ok right sure question explain describe talk
    work works working worked something anything happen happens happened mean means
    """.split()
)
_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
_CAMEL = re.compile(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+")
# Code-shaped tokens in prose: backticked spans, snake_case, camelCase,
# CONSTANT_CASE, dotted file names.
_BACKTICK = re.compile(r"`([^`\n]{2,80})`")
_IDENT = re.compile(
    r"\b(?:[A-Za-z]+_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]+"
    r"|[\w-]+\.(?:py|tsx?|jsx?|swift|go|rs|rb|java|kt))\b"
)
# Test / eval / fixture code repeats the vocabulary of the real code and
# crowds it out; it is only wanted when the question is about testing.
_TEST_PATH = re.compile(
    r"(?:^|/)(?:tests?|__tests__|spec|evals?|fixtures?)/|(?:^|/)test_|[._-](?:test|spec)\."
)
_TESTY_QUESTION = re.compile(r"\b(?:test|tests|tested|testing|eval|evals|spec|coverage|ci)\b", re.I)
HINT_SEGMENTS = 4
MAX_SEGMENT_TOKENS = 60
# Sentence / bullet / line boundaries in Markdown-ish prose.
_SEGMENT = re.compile(r"\n+|(?<=[.!?])\s+(?=[A-Z`*(])")


def match_expression(text: str) -> str:
    """FTS5 OR-query from the meaningful words / identifiers in `text`.
    Identifiers are also split (snake_case, camelCase) so "generateBrief"
    and "generate_brief" match either spelling."""
    terms: list[str] = []
    seen: set[str] = set()

    def add(term: str) -> None:
        t = term.lower()
        if len(t) >= 3 and t not in _STOPWORDS and t not in seen:
            seen.add(t)
            terms.append(t)

    for tok in _TOKEN.findall(text):
        add(tok)
        for part in tok.split("_"):
            for sub in _CAMEL.findall(part):
                add(sub)
    return " OR ".join(f'"{t}"' for t in terms[:MAX_TERMS])


def _stem(word: str) -> str:
    return word.lower()[:5]


def hint_identifiers(question: str, hints: str) -> str:
    """Identifiers that the project's own write-up associates with the
    question's topic.

    Spoken questions rarely use code names ("how does it decide API vs
    subscription?"), but the brief maps concepts to identifiers ("…in one
    place, `claude_transport()` in `services/claude_api.py`"). Score each
    brief line by overlap with the question's words, take the best few, and
    return the code-shaped tokens they mention."""
    q_terms = {_stem(t) for t in _TOKEN.findall(question) if t.lower() not in _STOPWORDS}
    if not q_terms or not hints:
        return ""
    scored: list[tuple[float, str]] = []
    for segment in _SEGMENT.split(hints):
        tokens = _TOKEN.findall(segment)
        # Long blobs (a whole transcript message on one line) match every
        # question a little; precise short statements are what map a topic
        # to its identifiers.
        if not tokens or len(tokens) > MAX_SEGMENT_TOKENS:
            continue
        overlap = len(q_terms & {_stem(t) for t in tokens})
        if overlap >= 2:
            scored.append((overlap / math.sqrt(len(tokens)), segment))
    scored.sort(key=lambda x: -x[0])
    idents: list[str] = []
    for _, line in scored[:HINT_SEGMENTS]:
        for span in _BACKTICK.findall(line):
            idents.extend(_TOKEN.findall(span))
        idents.extend(_IDENT.findall(line))
    return " ".join(dict.fromkeys(idents))


async def _search(
    project_ids: list[str], text: str, *, keep_tests: bool
) -> list[dict[str, object]]:
    match = match_expression(text)
    if not match:
        return []
    rows = await search_code_chunks(project_ids, match, CANDIDATES)
    return [r for r in rows if keep_tests or not _TEST_PATH.search(str(r["path"]))]


async def find_code_refs(
    project_ids: list[str], question: str, hints: str = ""
) -> tuple[CodeRef, ...]:
    """Best code blocks for `question`. `hints` is the attached projects'
    brief/notes text, used to translate the question into identifiers."""
    if not project_ids:
        return ()
    keep_tests = bool(_TESTY_QUESTION.search(question))
    try:
        # Identifier-led results first (precise), then plain keyword results.
        rows = await _search(
            project_ids, hint_identifiers(question, hints), keep_tests=keep_tests
        ) + await _search(project_ids, question, keep_tests=keep_tests)
    except Exception as exc:  # never block a live answer on retrieval
        log.warning("code_search.failed", error=str(exc))
        return ()

    refs: list[CodeRef] = []
    per_file: dict[str, int] = {}
    seen: set[tuple[str, int]] = set()
    total = 0
    for r in rows:
        path = str(r["path"])
        key = (path, int(str(r["start_line"])))
        if key in seen or per_file.get(path, 0) >= MAX_PER_FILE:
            continue
        seen.add(key)
        body = str(r["body"])
        start, end = int(str(r["start_line"])), int(str(r["end_line"]))
        if len(body) > MAX_REF_CHARS:
            # Keep whole lines so the cited range stays exact.
            kept = body[:MAX_REF_CHARS].rsplit("\n", 1)[0]
            end = start + kept.count("\n")
            body = kept
        if total + len(body) > MAX_TOTAL_CHARS:
            continue
        refs.append(
            CodeRef(
                path=path,
                start_line=start,
                end_line=end,
                code=body,
                root=str(r["root"] or ""),
            )
        )
        per_file[path] = per_file.get(path, 0) + 1
        total += len(body)
        if len(refs) >= MAX_REFS:
            break
    return tuple(refs)
