import pytest

from app.services import coding_agent
from app.settings import settings


def _flag(cmd: list[str], name: str) -> str | None:
    return cmd[cmd.index(name) + 1] if name in cmd else None


@pytest.fixture(autouse=True)
def defaults(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "agent_model", "sonnet")
    monkeypatch.setattr(settings, "agent_effort", "low")
    monkeypatch.setattr(coding_agent, "_warm_selection", (None, None))


def test_agent_defaults_come_from_settings() -> None:
    cmd = coding_agent._build_command()
    assert _flag(cmd, "--model") == "sonnet"
    assert _flag(cmd, "--effort") == "low"


def test_agent_selection_overrides_settings() -> None:
    cmd = coding_agent._build_command(model="claude-opus-5-5", effort="high")
    assert _flag(cmd, "--model") == "claude-opus-5-5"
    assert _flag(cmd, "--effort") == "high"


def test_prewarm_uses_last_selection() -> None:
    coding_agent._remember_selection("claude-opus-5-5", "high")
    cmd = coding_agent._build_command(*coding_agent._warm_selection)
    assert _flag(cmd, "--model") == "claude-opus-5-5"
