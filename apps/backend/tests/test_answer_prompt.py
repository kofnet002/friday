from app.prompts.answer_generation import AnswerContext, answer_system_prompt


def test_prompt_answers_most_recent_question_in_raw_transcript() -> None:
    # Force-ask fallback sends raw transcript; the newest question is the
    # one the candidate is being asked right now.
    assert "MOST RECENT" in answer_system_prompt(AnswerContext())


def test_prompt_limits_web_search_to_unknown_facts() -> None:
    prompt = answer_system_prompt(AnswerContext())
    assert "WEB SEARCH" in prompt
    assert "never narrate the search" in prompt.lower()
