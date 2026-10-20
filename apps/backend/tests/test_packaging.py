"""Behaviour the packaged (PyInstaller) backend relies on."""

import sys
from pathlib import Path

import pytest

from app import settings as settings_module
from app.services import code_runner


def test_env_file_defaults_to_repo_root(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FRIDAY_ENV_FILE", raising=False)
    assert settings_module.env_file_path() == settings_module.ROOT_ENV


def test_env_file_override_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    target = tmp_path / "friday.env"
    monkeypatch.setenv("FRIDAY_ENV_FILE", str(target))
    assert settings_module.env_file_path() == target


def test_source_checkout_verifies_with_own_interpreter(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert code_runner._python_interpreter() == [sys.executable, "-I"]


def test_frozen_binary_verifies_with_system_python(monkeypatch: pytest.MonkeyPatch) -> None:
    # In a PyInstaller build sys.executable is the backend itself — running
    # it on a harness would boot a second server instead of the solution.
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(code_runner.shutil, "which", lambda name: f"/opt/homebrew/bin/{name}")
    assert code_runner._python_interpreter() == ["/opt/homebrew/bin/python3", "-I"]


def test_frozen_binary_ignores_xcode_stub_without_clt(monkeypatch: pytest.MonkeyPatch) -> None:
    # Without the Command Line Tools /usr/bin/python3 only pops an install
    # dialog — treat it as "no python" so verification skips cleanly.
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(code_runner.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(code_runner, "_command_line_tools_installed", lambda: False)
    assert code_runner._python_interpreter() is None
    monkeypatch.setattr(code_runner, "_command_line_tools_installed", lambda: True)
    assert code_runner._python_interpreter() == ["/usr/bin/python3", "-I"]


def test_harness_env_hides_the_keys_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRIDAY_ENV_FILE", "/support/.env")
    monkeypatch.setenv("PATH", "/usr/bin")
    env = code_runner._harness_env()
    assert "FRIDAY_ENV_FILE" not in env
    assert env["PATH"] == "/usr/bin"


async def test_frozen_binary_without_python_skips_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(code_runner.shutil, "which", lambda _name: None)
    result = await code_runner.run_solution_tests(
        solution_markdown="```python\ndef f(x):\n    return x\n```",
        examples=[{"input": "x = 1", "output": "1"}],
        language="python",
    )
    assert result.ran is False
    assert result.skip_reason is not None and "python3" in result.skip_reason


def test_parent_watchdog_only_fires_when_parent_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import server

    monkeypatch.setattr(server.os, "getppid", lambda: 4242)
    assert server._parent_gone(4242) is False
    # Reparented to launchd: the Electron app that spawned us is gone.
    monkeypatch.setattr(server.os, "getppid", lambda: 1)
    assert server._parent_gone(4242) is True


def test_parent_watchdog_disabled_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import server

    monkeypatch.delenv("FRIDAY_PARENT_PID", raising=False)
    assert server._watched_parent_pid() is None
    monkeypatch.setenv("FRIDAY_PARENT_PID", "4242")
    assert server._watched_parent_pid() == 4242
    monkeypatch.setenv("FRIDAY_PARENT_PID", "not-a-pid")
    assert server._watched_parent_pid() is None
