"""Entry point for the packaged backend binary (PyInstaller).

Dev keeps running `uvicorn app.main:app --reload`; the Electron app spawns
this binary instead. Host/port are fixed because the web UI is built against
127.0.0.1:8000.
"""

import os
import signal
import threading
import time

import uvicorn

from app.main import app

PARENT_POLL_S = 1.0
# Cap uvicorn's wait for open WebSockets on SIGTERM; the watchdog's hard exit
# is the backstop if shutdown still hangs.
GRACEFUL_SHUTDOWN_S = 3
HARD_EXIT_AFTER_S = 6.0


def _watched_parent_pid() -> int | None:
    """The Electron app's pid, passed as FRIDAY_PARENT_PID when it spawns us."""
    raw = os.environ.get("FRIDAY_PARENT_PID", "")
    return int(raw) if raw.isdigit() else None


def _parent_gone(parent_pid: int) -> bool:
    return os.getppid() != parent_pid


def _exit_with_parent(parent_pid: int) -> None:
    """If Friday crashes or is force-quit we get reparented; shut down instead
    of holding :8000 and blocking the next launch."""
    while not _parent_gone(parent_pid):
        time.sleep(PARENT_POLL_S)
    os.kill(os.getpid(), signal.SIGTERM)
    time.sleep(HARD_EXIT_AFTER_S)
    os._exit(1)


def main() -> None:
    parent_pid = _watched_parent_pid()
    if parent_pid is not None:
        threading.Thread(target=_exit_with_parent, args=(parent_pid,), daemon=True).start()
    uvicorn.run(app, host="127.0.0.1", port=8000, timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_S)


if __name__ == "__main__":
    main()
