from app.prompts.answer_generation import AnswerContext, answer_system_prompt


def test_screen_context_is_omitted_from_legacy_prompt():
    prompt = answer_system_prompt(AnswerContext())
    assert "<visible_screen_context>" not in prompt


def test_screen_context_is_available_as_relevant_source_material():
    prompt = answer_system_prompt(
        AnswerContext(screen_context="Design a rate limiter for 10k requests/second.")
    )
    assert "<visible_screen_context>" in prompt
    assert "Design a rate limiter for 10k requests/second." in prompt
    assert "Use this context only when it is relevant" in prompt
