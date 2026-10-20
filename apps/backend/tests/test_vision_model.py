import pytest

from app.services import coding_extraction
from app.services.coding_extraction import _selected_vision_model, _vision_chain
from app.settings import settings


@pytest.fixture
def keys(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "openai_api_key", "k")
    monkeypatch.setattr(settings, "gemini_api_key", "k")
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    monkeypatch.setattr(settings, "claude_code_oauth_token", "")
    monkeypatch.setattr(settings, "vision_provider", "")


def test_chain_tries_selected_model_then_provider_default_then_others(keys: None) -> None:
    assert _vision_chain("openai", "gpt-5.5") == [
        ("openai", "gpt-5.5"),
        ("openai", None),
        ("gemini", None),
    ]


def test_chain_without_selection_matches_legacy_order(keys: None) -> None:
    assert _vision_chain("gemini", None) == [("gemini", None), ("openai", None)]


async def test_selected_model_used_when_it_matches_provider(
    keys: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_session(_: str) -> dict[str, str]:
        return {"default_model": "claude-opus-5-5"}

    monkeypatch.setattr(coding_extraction, "get_session", fake_session)
    assert await _selected_vision_model("s", "claude") == "claude-opus-5-5"
    # A model from another provider (e.g. after deepseek→gemini) is ignored.
    assert await _selected_vision_model("s", "gemini") is None


async def test_pinned_vision_provider_ignores_selection(
    keys: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_session(_: str) -> dict[str, str]:
        return {"default_model": "gpt-5.5"}

    monkeypatch.setattr(coding_extraction, "get_session", fake_session)
    monkeypatch.setattr(settings, "vision_provider", "openai")
    assert await _selected_vision_model("s", "openai") is None
