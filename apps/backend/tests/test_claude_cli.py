import asyncio
import json
import os
from pathlib import Path
from typing import Any

import pytest

from app.services import claude_cli

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
JPEG = b"\xff\xd8\xff" + b"\x00" * 16


def _exists(path: str) -> bool:
    return Path(path).exists()


class _FakeStdin:
    def __init__(self) -> None:
        self.data = b""

    def write(self, data: bytes) -> None:
        self.data += data

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        return None


class _FakeStream:
    def __init__(self, lines: list[bytes]) -> None:
        self._lines = lines

    def __aiter__(self) -> "_FakeStream":
        return self

    async def __anext__(self) -> bytes:
        if not self._lines:
            raise StopAsyncIteration
        return self._lines.pop(0)

    async def read(self, n: int = -1) -> bytes:
        return b""


class _FakeProc:
    returncode = 0

    def __init__(self, result: str) -> None:
        self.stdin = _FakeStdin()
        self.stdout = _FakeStream(
            [json.dumps({"type": "result", "result": result}).encode() + b"\n"]
        )
        self.stderr = _FakeStream([])

    async def wait(self) -> int:
        return 0


def _patch(monkeypatch: pytest.MonkeyPatch, seen: dict[str, Any]) -> None:
    monkeypatch.setattr(claude_cli, "claude_cli_ready", lambda _sid: None)
    monkeypatch.setattr(claude_cli, "resolve_agent_env", lambda _sid: {})

    async def fake_exec(*cmd: str, cwd: str, **_kw: Any) -> _FakeProc:
        proc = _FakeProc("the answer")
        seen["cmd"] = list(cmd)
        seen["cwd"] = cwd
        seen["files"] = sorted(os.listdir(cwd))
        seen["proc"] = proc
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)


async def test_run_claude_cli_with_images_writes_all_files(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    _patch(monkeypatch, seen)

    out = await claude_cli.run_claude_cli_with_images(
        images=[JPEG, PNG], prompt="Describe.", system="sys", model=None, session_id=None
    )

    assert out == "the answer"
    assert seen["files"] == ["screen-1.jpg", "screen-2.png"]
    stdin = seen["proc"].stdin.data.decode()
    assert "screen-1.jpg" in stdin and "screen-2.png" in stdin
    assert stdin.endswith("Describe.")
    assert not _exists(seen["cwd"])


async def test_vision_wrapper_keeps_single_image_behavior(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    _patch(monkeypatch, seen)

    out = await claude_cli.run_claude_cli_vision(image_bytes=PNG, prompt="P", system="sys")

    assert out == "the answer"
    assert seen["files"] == ["screen.png"]
    assert (
        seen["proc"].stdin.data.decode()
        == "Read the image file screen.png in the current directory. P"
    )
