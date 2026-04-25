"""In-process registry mapping session_id → an async send function.

Used by cross-endpoint events: e.g. the vision endpoint needs to push a
`coding_problem_detected` event down the active `/ws/transcribe` connection
for a given session.

Last-write-wins: a second connection for the same session replaces the first.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

SendFn = Callable[[dict[str, Any]], Awaitable[None]]

_registry: dict[str, SendFn] = {}


def register(session_id: str, send: SendFn) -> None:
    _registry[session_id] = send


def unregister(session_id: str, send: SendFn | None = None) -> None:
    """Remove the registration if it still matches `send` (or unconditionally
    if `send` is None). Prevents a reconnect from clobbering a stale handler."""
    current = _registry.get(session_id)
    if current is None:
        return
    if send is None or current is send:
        _registry.pop(session_id, None)


async def publish(session_id: str, event: dict[str, Any]) -> bool:
    """Send an event to the session's registered handler. Returns True if a
    handler was registered and the send completed without raising."""
    send = _registry.get(session_id)
    if send is None:
        return False
    try:
        await send(event)
        return True
    except Exception:  # noqa: BLE001
        return False
