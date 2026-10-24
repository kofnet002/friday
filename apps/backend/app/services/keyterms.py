"""Speech-to-text key terms from the session's setup context.

Deepgram (nova-3 `keyterm`, Flux `keyterm`) boosts recognition of terms it's
told to expect — company names, the candidate's stack, acronyms. Without it,
"Kubernetes" becomes "Cooper Netties" and the question detector is grading a
garbled question. We pull candidates deterministically (no LLM call, no
latency at Start) from the resume, job title, company and extra instructions.
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable
from typing import Any

# Deepgram counts keyterm tokens against a request budget; a few dozen
# high-signal terms beat hundreds of diluted ones.
MAX_KEYTERMS = 40

# Tech-shaped tokens: internal capitals (TypeScript, PostgreSQL, gRPC),
# digits (S3, EC2, K8s, OAuth2), or symbols that ASR mangles (C++, C#,
# Node.js, .NET, CI/CD).
_TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9.+#/-]*[A-Za-z0-9+#]|[A-Za-z]")
_ACRONYM_RE = re.compile(r"^[A-Z][A-Z0-9]{1,6}s?$")

# Capitalized words that are just sentence starts or resume boilerplate.
_STOP = frozenset(
    """
    i a an the and or of to in on for with at by from as is was be my our
    we it led built designed developed managed created worked improved
    reduced increased implemented responsible experience education skills
    summary projects project work present university bachelor master degree
    january february march april may june july august september october
    november december jan feb mar apr jun jul aug sep sept oct nov dec
    senior junior engineer developer team inc llc ltd co usa us uk gpa phd
    bs ms ba ma cv id ok am pm
    """.split()
)


def _is_techy(tok: str) -> bool:
    if any(ch.isdigit() for ch in tok) or any(ch in tok for ch in "+#./"):
        return True
    if _ACRONYM_RE.match(tok):
        return True
    # Internal capital: TypeScript, PostgreSQL, gRPC, iOS, macOS.
    return any(ch.isupper() for ch in tok[1:]) and any(ch.islower() for ch in tok)


def _candidates(text: str) -> Iterable[str]:
    for raw in _TOKEN_RE.findall(text):
        tok = raw.strip(".,;:/-")
        if len(tok) < 2 or tok.lower() in _STOP:
            continue
        if _is_techy(tok):
            yield tok


def extract_keyterms(session: dict[str, Any] | None) -> list[str]:
    """Ranked, de-duplicated key terms for this session (≤ MAX_KEYTERMS).

    Company name and job title come first (they're the most likely to be
    spoken and misheard), then tech-shaped resume/instruction tokens by
    frequency."""
    if not session:
        return []
    terms: list[str] = []
    seen: set[str] = set()

    def add(term: str) -> None:
        term = " ".join(term.split())
        key = term.lower()
        if term and key not in seen and len(term) <= 40:
            seen.add(key)
            terms.append(term)

    company = str(session.get("company") or "").strip()
    if company:
        add(company)
    title = str(session.get("job_title") or "")
    for tok in _candidates(title):
        add(tok)

    counts: Counter[str] = Counter()
    canonical: dict[str, str] = {}
    for field in ("resume_text", "extra_instructions"):
        for tok in _candidates(str(session.get(field) or "")):
            key = tok.lower()
            counts[key] += 1
            canonical.setdefault(key, tok)
    for key, _ in counts.most_common():
        add(canonical[key])
        if len(terms) >= MAX_KEYTERMS:
            break
    return terms[:MAX_KEYTERMS]
