"""Logging setup.

- Console renderer in dev, JSON renderer when FRIDAY_JSON_LOGS=1
- Rotating file handler under ~/Library/Logs/friday/backend.log
  (10 MB per file, keep 5 files)
- Secrets-redaction processor that masks API-key shapes anywhere they
  appear in event keys, values, or stringified exceptions.
"""

from __future__ import annotations

import logging
import os
import re
import sys
from collections.abc import MutableMapping
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any

import structlog


# Patterns we recognize as secrets. Each match is replaced with a marker
# that preserves a small tail so logs stay debuggable ("sk-…last4"-style).
_KEY_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"sk-(?:proj-)?[A-Za-z0-9_\-]{20,}"),  # OpenAI
    re.compile(r"AIza[A-Za-z0-9_\-]{30,}"),  # Gemini
    re.compile(r"\b[a-f0-9]{40}\b"),  # Deepgram (40-hex token)
    re.compile(r"\bBearer\s+[A-Za-z0-9_\-\.=]+", re.IGNORECASE),
]


def _redact_str(value: str) -> str:
    redacted = value
    for pat in _KEY_PATTERNS:
        redacted = pat.sub(lambda m: _mask(m.group(0)), redacted)
    return redacted


def _mask(token: str) -> str:
    if len(token) <= 8:
        return "<redacted>"
    return f"{token[:4]}…<redacted:{len(token)}>…{token[-4:]}"


def _redact_any(value: Any) -> Any:
    if isinstance(value, str):
        return _redact_str(value)
    if isinstance(value, dict):
        return {k: _redact_any(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        cls = type(value)
        return cls(_redact_any(v) for v in value)
    return value


def _redact_processor(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """structlog processor: redact API-key shapes in every value (incl. exception text)."""
    redacted: dict[str, Any] = {}
    for key, value in event_dict.items():
        redacted[key] = _redact_any(value)
    return redacted


def _logs_dir() -> Path:
    override = os.getenv("FRIDAY_LOG_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library" / "Logs" / "friday"


def configure_logging() -> None:
    log_dir = _logs_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "backend.log"

    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    try:
        file_handler = RotatingFileHandler(
            log_file,
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        handlers.append(file_handler)
    except OSError:
        # Read-only home or sandboxed: skip file logging gracefully.
        pass

    level_name = os.getenv("FRIDAY_LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    logging.basicConfig(
        format="%(message)s",
        level=level,
        handlers=handlers,
        force=True,
    )

    json_mode = os.getenv("FRIDAY_JSON_LOGS") == "1"
    renderer: Any = (
        structlog.processors.JSONRenderer()
        if json_mode
        else structlog.dev.ConsoleRenderer(colors=True)
    )

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            _redact_processor,  # last before render so it sees everything
            renderer,
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        cache_logger_on_first_use=True,
    )


log = structlog.get_logger()
