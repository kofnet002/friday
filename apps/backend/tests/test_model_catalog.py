from app.models.catalog import parse_effort, provider_for_model, resolve_model


def test_known_models_resolve_to_their_provider() -> None:
    assert provider_for_model("gpt-5.6") == "openai"
    assert provider_for_model("gemini-2.5-pro") == "gemini"
    assert provider_for_model("claude-sonnet-4-6") == "claude"
    assert provider_for_model("claude-opus-5-5") == "claude"


def test_uncatalogued_models_resolve_by_prefix() -> None:
    assert provider_for_model("gpt-5.6-terra") == "openai"
    assert provider_for_model("o3-mini") == "openai"
    assert provider_for_model("ft:gpt-4o:acme::abc123") == "openai"
    assert provider_for_model("gemini-3-pro-preview") == "gemini"
    assert provider_for_model("claude-fable-5-1") == "claude"
    assert provider_for_model("deepseek-reasoner") == "deepseek"


def test_unknown_prefix_uses_provider_hint() -> None:
    assert provider_for_model("my-custom-model") is None
    assert provider_for_model("my-custom-model", fallback="openai") == "openai"


def test_explicit_provider_prefix_wins_and_is_stripped() -> None:
    selection = resolve_model("deepseek:my-finetune", provider_hint="gemini")
    assert selection is not None
    assert selection.provider == "deepseek"
    assert selection.model == "my-finetune"


def test_resolve_model_rejects_malformed_ids() -> None:
    assert resolve_model("", provider_hint="openai") is None
    assert resolve_model("gpt 5; rm -rf", provider_hint="openai") is None
    assert resolve_model("x" * 200, provider_hint="openai") is None


def test_resolve_model_without_inferable_provider_or_hint_is_rejected() -> None:
    assert resolve_model("my-custom-model", provider_hint=None) is None


def test_parse_effort_accepts_known_levels_only() -> None:
    assert parse_effort("high") == "high"
    assert parse_effort(" XHigh ") == "xhigh"
    assert parse_effort("") is None
    assert parse_effort(None) is None
    assert parse_effort("turbo") is None


def test_explicit_provider_prefix_with_empty_model_is_rejected() -> None:
    assert resolve_model("claude:", provider_hint="openai") is None
