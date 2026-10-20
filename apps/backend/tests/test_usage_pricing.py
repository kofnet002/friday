import pytest

from app.services.usage import _cost
from app.settings import settings


def test_exact_price_is_used() -> None:
    assert _cost("gpt-4o", 1_000_000, 1_000_000) == pytest.approx(12.5)


def test_uncatalogued_claude_model_falls_back_to_its_tier_price() -> None:
    assert _cost("claude-opus-5-5", 1_000_000, 0) == _cost("claude-opus-4-8", 1_000_000, 0)
    assert _cost("claude-sonnet-5-5", 1_000_000, 0) == _cost("claude-sonnet-4-6", 1_000_000, 0)
    assert _cost("claude-haiku-5-5", 1_000_000, 0) == _cost("claude-haiku-4-5", 1_000_000, 0)


def test_env_pricing_override_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        settings, "model_pricing", '{"claude-opus-5-5": [10, 50], "my-model": [1, 2]}'
    )
    assert _cost("claude-opus-5-5", 1_000_000, 1_000_000) == pytest.approx(60.0)
    assert _cost("my-model", 1_000_000, 1_000_000) == pytest.approx(3.0)


def test_malformed_env_pricing_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "model_pricing", "{not json")
    assert _cost("gpt-4o", 1_000_000, 0) == pytest.approx(2.5)


def test_unknown_model_has_no_cost() -> None:
    assert _cost("totally-unknown", 1_000, 1_000) is None


def test_subscription_runs_are_never_priced() -> None:
    assert _cost("claude-opus-5-5 (subscription)", 1_000_000, 1_000_000) is None
