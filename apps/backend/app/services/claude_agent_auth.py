"""Credential resolution for the in-app agentic coding mode.

The agent shells out to the local `claude` CLI. This module decides which
credential that subprocess runs under and builds its environment.

Auth model (see docs/agentic-coding.md): the agent bills against the Claude
SUBSCRIPTION via CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`), not the
pay-per-token Anthropic API. When a subscription token is present we strip
ANTHROPIC_API_KEY from the child env so the CLI can't silently fall back to
metered API access (ANTHROPIC_API_KEY outranks the OAuth token in Claude
Code's auth precedence, so leaving it would defeat the whole point).

`session_id` is the seam for a future multi-user build: today every run uses
the single global token, but each user must eventually bring their OWN token —
one subscription cannot be shared across users without breaching Anthropic's
terms. `_token_for_session` is the one place that lookup would change.
"""

from __future__ import annotations

import os
import shutil

from app.services.claude_api import claude_transport
from app.settings import settings


def _token_for_session(session_id: str | None) -> str:
    """Return the subscription OAuth token to run this session's agent under.

    Multi-user seam: replace the global lookup with a per-user store keyed by
    session_id (each user pastes their own `claude setup-token` output). For
    now every session resolves to the single configured token."""
    return settings.claude_code_oauth_token


def claude_available() -> bool:
    """True when a Claude credential matching CLAUDE_TRANSPORT is configured.

    Either a subscription OAuth token (CLI path) or a metered API key (SDK
    path). Used by provider chains to decide whether "claude" is a real
    option — which of the two runs is decided by claude_api.claude_transport.
    """
    return claude_transport() is not None


def claude_cli_ready(session_id: str | None = None) -> str | None:
    """Return why the local `claude` CLI can't be driven, or None if it can.

    Independent of AGENT_ENABLED: this gates any CLI use (the agent tool loop
    AND the subscription-backed single-shot solve), which only need the binary
    on PATH plus a credential."""
    if shutil.which(settings.claude_cli_path) is None:
        return (
            f"claude CLI not found on PATH ({settings.claude_cli_path!r}) — "
            "install Claude Code or set CLAUDE_CLI_PATH"
        )
    if not _token_for_session(session_id) and not settings.anthropic_api_key:
        return (
            "no Claude credentials — run `claude setup-token` and set "
            "CLAUDE_CODE_OAUTH_TOKEN (see docs/agentic-coding.md)"
        )
    return None


def agent_unavailable_reason(session_id: str | None = None) -> str | None:
    """Return a human-readable reason the agent can't run, or None if it can.

    Checked up front by the WS handler so the panel shows a clear setup hint
    instead of a subprocess crash mid-stream."""
    if not settings.agent_enabled:
        return "agent mode is disabled (set AGENT_ENABLED=true)"
    return claude_cli_ready(session_id)


def resolve_agent_env(session_id: str | None = None) -> dict[str, str]:
    """Build the environment for the `claude` subprocess.

    Inherits the parent env, then pins the credential. A subscription token
    takes priority and forces subscription billing; only if none is configured
    do we fall back to an API key (metered)."""
    env = dict(os.environ)
    # Pin the CLI to a specific profile (e.g. ~/.claude-raymond) so the app
    # uses that profile's login/subscription rather than the default ~/.claude.
    if settings.claude_config_dir:
        env["CLAUDE_CONFIG_DIR"] = os.path.expanduser(settings.claude_config_dir)
    token = _token_for_session(session_id)
    if token:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = token
        # Force subscription billing — see module docstring.
        env.pop("ANTHROPIC_API_KEY", None)
    elif settings.anthropic_api_key:
        env["ANTHROPIC_API_KEY"] = settings.anthropic_api_key
    return env
