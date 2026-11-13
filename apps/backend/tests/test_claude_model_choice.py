from app.services.claude_api import CLAUDE_MODEL_CHOICES, normalize_claude_model
from app.services.coding_solution import resolved_model
from app.services.usage import PRICING


def test_screen_mode_offers_current_claude_models():
    assert CLAUDE_MODEL_CHOICES == (
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "claude-fable-5-2",
    )


def test_unknown_or_missing_model_is_rejected():
    assert normalize_claude_model("claude-sonnet-5-5") == "claude-sonnet-5-5"
    assert normalize_claude_model("gpt-4o") is None
    assert normalize_claude_model(None) is None
    assert normalize_claude_model("claude-opus-5-5-20260401") is None


def test_selected_claude_model_wins_for_solves_and_refines():
    assert resolved_model("claude", claude_model="claude-haiku-5-5") == "claude-haiku-5-5"
    assert (
        resolved_model("claude", deep=True, claude_model="claude-fable-5-2") == "claude-fable-5-2"
    )
    # Other providers ignore it.
    assert resolved_model("gemini", claude_model="claude-haiku-5-5") != "claude-haiku-5-5"


def test_every_choice_is_priced():
    for model in CLAUDE_MODEL_CHOICES:
        assert model in PRICING


def test_screen_answers_can_use_the_screen_panel_model():
    from app.services.answer import claude_answer_model
    from app.settings import settings

    assert claude_answer_model().endswith(settings.anthropic_answer_model)
    assert claude_answer_model("claude-haiku-5-5").endswith("claude-haiku-5-5")
