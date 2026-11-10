"""Launch the packaged backend and verify its HTTP readiness endpoint."""

from __future__ import annotations

import argparse
import os
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen


def available_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--executable",
        type=Path,
        help="smoke-test a specific packaged copy instead of the backend build output",
    )
    args = parser.parse_args()
    repo_root = Path(__file__).resolve().parents[3]
    executable = args.executable or repo_root / "apps/backend/dist/friday-backend/friday-backend"
    if not executable.is_file():
        raise SystemExit(f"Missing {executable}; build the backend binary first.")

    port = available_port()
    with tempfile.TemporaryDirectory(prefix="friday-backend-smoke-") as temp_dir:
        env = {
            **os.environ,
            "SQLITE_PATH": str(Path(temp_dir) / "friday.db"),
            "FRIDAY_BACKEND_PORT": str(port),
        }
        process = subprocess.Popen(
            [str(executable)],
            cwd=repo_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.monotonic() + 30
        try:
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    output, _ = process.communicate()
                    raise SystemExit(
                        f"Packaged backend exited with code {process.returncode}:\n{output}"
                    )
                try:
                    with urlopen(f"http://127.0.0.1:{port}/healthz", timeout=0.5) as response:
                        if response.status == 200:
                            print("Packaged backend readiness check passed.")
                            return
                except (TimeoutError, URLError, OSError):
                    time.sleep(0.1)
            raise SystemExit("Packaged backend did not become ready within 30 seconds.")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
