"""Model → provider resolution.

The catalog lists the models the UI offers by default, but it is NOT an
allowlist: any well-formed model ID is accepted as long as we can tell which
provider serves it. Resolution order:

1. Explicit ``provider:model`` prefix (e.g. ``deepseek:my-finetune``).
2. A catalogued ID.
3. A known vendor prefix (``claude-``, ``gpt-``, ``o3`` …).
4. The caller's provider hint (the provider the UI had selected).
"""

import re
from dataclasses import dataclass
from typing import Literal, get_args

Provider = Literal["gemini", "openai", "deepseek", "claude"]
Effort = Literal["low", "medium", "high", "xhigh", "max"]

PROVIDERS: tuple[Provider, ...] = get_args(Provider)
EFFORTS: tuple[Effort, ...] = get_args(Effort)

MODEL_PROVIDERS: dict[str, Provider] = {
    "gemini-2.5-flash": "gemini",
    "gemini-2.5-pro": "gemini",
    "gpt-4o": "openai",
    "gpt-5.5": "openai",
    "gpt-5.6": "openai",
    "deepseek-chat": "deepseek",
    "claude-opus-5-5": "claude",
    "claude-sonnet-5-5": "claude",
    "claude-haiku-5-5": "claude",
    "claude-opus-4-8": "claude",
    "claude-sonnet-4-6": "claude",
}

# Ordered: first match wins. `ft:` covers OpenAI fine-tunes (ft:gpt-4o:org::id).
_PREFIX_PROVIDERS: tuple[tuple[str, Provider], ...] = (
    ("claude-", "claude"),
    ("gemini-", "gemini"),
    ("deepseek-", "deepseek"),
    ("gpt-", "openai"),
    ("chatgpt-", "openai"),
    ("ft:", "openai"),
    ("o1", "openai"),
    ("o3", "openai"),
    ("o4", "openai"),
)

# Model IDs flow into SDK calls and CLI argv, so keep them to the characters
# real vendor IDs use. Rejects whitespace, shell metacharacters, and junk.
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$")


@dataclass(frozen=True)
class ModelSelection:
    provider: Provider
    model: str


def is_valid_model_id(model: str) -> bool:
    return bool(_MODEL_ID_RE.match(model))


def provider_for_model(model: str, fallback: Provider | None = None) -> Provider | None:
    if not is_valid_model_id(model):
        return None
    known = MODEL_PROVIDERS.get(model)
    if known:
        return known
    lowered = model.lower()
    for prefix, provider in _PREFIX_PROVIDERS:
        if lowered.startswith(prefix):
            return provider
    return fallback


def resolve_model(model: str, *, provider_hint: str | None) -> ModelSelection | None:
    """Resolve a user-selected model ID to (provider, model). None when the ID
    is malformed or no provider can be determined."""
    raw = model.strip()
    if not is_valid_model_id(raw):
        return None
    head, sep, rest = raw.partition(":")
    explicit = _as_provider(head) if sep else None
    if explicit:
        if not is_valid_model_id(rest):
            return None
        return ModelSelection(provider=explicit, model=rest)
    provider = provider_for_model(raw, fallback=_as_provider(provider_hint))
    if provider is None:
        return None
    return ModelSelection(provider=provider, model=raw)


def _as_provider(value: str | None) -> Provider | None:
    for provider in PROVIDERS:
        if provider == value:
            return provider
    return None


def parse_effort(value: object) -> Effort | None:
    """Normalize a reasoning-effort value from a request. Unknown → None
    (provider default), so a bad value degrades instead of erroring."""
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    for effort in EFFORTS:
        if effort == normalized:
            return effort
    return None
