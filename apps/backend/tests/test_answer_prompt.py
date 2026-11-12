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


def test_screen_rules_ask_for_direct_answers_to_on_screen_questions():
    from app.prompts.answer_generation import AnswerContext, answer_system_prompt

    prompt = answer_system_prompt(AnswerContext(screen_context="Q1. Which is O(1)? A) ... B) ..."))
    assert "multiple-choice" in prompt
    assert "reference material" in prompt


def test_grouped_screen_questions_are_answered_together_with_their_numbers():
    prompt = answer_system_prompt(AnswerContext())
    assert "Answer each of these" in prompt
    assert "question's own number" in prompt


def test_unsure_or_cut_off_answers_are_flagged():
    prompt = answer_system_prompt(AnswerContext())
    assert "⚠️ Check:" in prompt
