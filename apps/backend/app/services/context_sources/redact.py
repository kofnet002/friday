"""Best-effort secret redaction for ingested project material.

Transcripts and repos routinely contain `.env` dumps, bearer tokens and API
keys. None of that should be stored in the brief DB or sent to a model, so
every source passes through `redact()` before it is saved."""

from __future__ import annotations

import re

_PLACEHOLDER = "[REDACTED]"

# Provider-shaped tokens (prefix + long random tail).
_TOKEN_PATTERNS = [
    r"sk-ant-[A-Za-z0-9_\-]{20,}",
    r"sk-(?:proj-|live-|test-)?[A-Za-z0-9_\-]{20,}",
    r"AIza[0-9A-Za-z_\-]{30,}",
    r"gh[pousr]_[A-Za-z0-9]{30,}",
    r"github_pat_[A-Za-z0-9_]{30,}",
    r"xox[abprs]-[A-Za-z0-9\-]{10,}",
    r"AKIA[0-9A-Z]{16}",
    r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}",  # JWT
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
]
_TOKEN_RE = re.compile("|".join(f"(?:{p})" for p in _TOKEN_PATTERNS))

# KEY=value / KEY: value where the name looks secret-ish. Keeps the name so
# the brief can still say "configured via ANTHROPIC_API_KEY".
_ASSIGN_RE = re.compile(
    r"""(?ix)
    \b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|DSN)[A-Z0-9_]*)
    (\s*[:=]\s*)
    (["']?)([^\s"'`,;]{6,})\3
    """
)
# Bearer / Basic auth headers.
_AUTH_RE = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9_\-.=+/]{16,}")
# Credentials embedded in URLs: scheme://user:pass@host
_URL_CRED_RE = re.compile(r"(?i)\b([a-z][a-z0-9+.\-]*://[^\s:/@]+:)[^\s@/]+@")


def redact(text: str) -> str:
    text = _TOKEN_RE.sub(_PLACEHOLDER, text)
    text = _ASSIGN_RE.sub(lambda m: f"{m.group(1)}{m.group(2)}{_PLACEHOLDER}", text)
    text = _AUTH_RE.sub(lambda m: f"{m.group(1)} {_PLACEHOLDER}", text)
    text = _URL_CRED_RE.sub(lambda m: f"{m.group(1)}{_PLACEHOLDER}@", text)
    return text
