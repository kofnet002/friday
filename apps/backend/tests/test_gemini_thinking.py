from app.services.answer import _gemini_thinking_config
from app.services.coding_solution import _gemini_thinking_budget


def test_gemini_flash_disables_thinking() -> None:
    assert _gemini_thinking_config("gemini-2.5-flash").thinking_budget == 0
    assert _gemini_thinking_budget("gemini-2.5-flash") == 0


def test_gemini_pro_uses_automatic_thinking() -> None:
    assert _gemini_thinking_config("gemini-2.5-pro").thinking_budget == -1
    assert _gemini_thinking_budget("gemini-2.5-pro") == -1
