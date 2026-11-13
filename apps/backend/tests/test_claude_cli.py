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


async def test_run_claude_cli_with_images_lists_labels(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    _patch(monkeypatch, seen)

    await claude_cli.run_claude_cli_with_images(
        images=[JPEG, PNG],
        prompt="Describe.",
        system="sys",
        labels=["Figure 1 (bar chart: Sales)", ""],
    )

    stdin = seen["proc"].stdin.data.decode()
    assert "screen-1.jpg: Figure 1 (bar chart: Sales)" in stdin
    assert "screen-2.png: unlabelled" in stdin
    assert stdin.endswith("Describe.")


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


async def test_cli_passes_effort_when_given(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    _patch(monkeypatch, seen)
    await claude_cli.run_claude_cli_with_images(
        images=[JPEG], prompt="Describe.", system="sys", effort="medium"
    )
    cmd = seen["cmd"]
    assert cmd[cmd.index("--effort") + 1] == "medium"
    await claude_cli.run_claude_cli_with_images(images=[JPEG], prompt="Describe.", system="sys")
    assert "--effort" not in seen["cmd"]


async def test_cli_drops_effort_for_models_that_reject_it(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    _patch(monkeypatch, seen)
    await claude_cli.run_claude_cli_with_images(
        images=[JPEG], prompt="Describe.", system="sys", model="claude-haiku-4-5", effort="medium"
    )
    assert "--effort" not in seen["cmd"]
    await claude_cli.run_claude_cli_with_images(
        images=[JPEG], prompt="Describe.", system="sys", model="claude-haiku-5-5", effort="medium"
    )
    assert seen["cmd"][seen["cmd"].index("--effort") + 1] == "medium"


def test_accepts_effort_follows_the_model() -> None:
    from app.services.claude_api import accepts_effort

    assert accepts_effort("claude-haiku-5-5")
    assert accepts_effort(None)  # the CLI's own default model
    assert not accepts_effort("claude-haiku-4-5")
    assert not accepts_effort("claude-sonnet-4-5-20250929")


def _only_read_tool(cmd: list[str]) -> None:
    # The CLI runs with --dangerously-skip-permissions, so the tool set itself
    # must be restricted: Read is the only tool it gets.
    assert cmd[cmd.index("--tools") + 1] == "Read"
    assert cmd[cmd.index("--tools") + 2].startswith("--")


async def test_vision_path_restricts_tools_to_read(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    _patch(monkeypatch, seen)
    await claude_cli.run_claude_cli_vision(image_bytes=PNG, prompt="P", system="sys")
    _only_read_tool(seen["cmd"])
    assert Path(seen["cwd"]).name.startswith("friday-vision-")


async def test_answer_with_images_restricts_tools_to_read(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import answer as answer_mod

    seen: dict[str, Any] = {}
    _patch(monkeypatch, seen)
    monkeypatch.setattr(answer_mod, "claude_transport", lambda: "cli")
    out = [t async for t in answer_mod._stream_anthropic("sys", "q", "q", (), images=[PNG])]
    assert out == ["the answer"]
    _only_read_tool(seen["cmd"])


async def test_empty_cli_image_answer_raises_so_the_fallback_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import answer as answer_mod

    async def empty(**_kw: Any) -> str:
        return ""

    monkeypatch.setattr(answer_mod, "claude_transport", lambda: "cli")
    monkeypatch.setattr(claude_cli, "run_claude_cli_with_images", empty)
    with pytest.raises(RuntimeError, match="empty"):
        _ = [t async for t in answer_mod._stream_anthropic("sys", "q", "q", (), images=[PNG])]
