from app.models.catalog import provider_for_model


def test_known_models_resolve_to_their_provider() -> None:
    assert provider_for_model("gpt-5.6") == "openai"
    assert provider_for_model("gemini-2.5-pro") == "gemini"
    assert provider_for_model("claude-sonnet-4-6") == "claude"


def test_unknown_model_is_rejected() -> None:
    assert provider_for_model("gpt-5.6-terra") is None
