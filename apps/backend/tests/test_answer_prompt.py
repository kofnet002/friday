from app.prompts.answer_generation import AnswerContext, answer_system_prompt, answer_user_prompt


def test_prompt_answers_most_recent_question_in_raw_transcript() -> None:
    # Force-ask fallback sends raw transcript; the newest question is the
    # one the candidate is being asked right now.
    assert "MOST RECENT" in answer_system_prompt(AnswerContext())


def test_prompt_limits_web_search_to_unknown_facts() -> None:
    prompt = answer_system_prompt(AnswerContext())
    assert "WEB SEARCH" in prompt
    assert "never narrate the search" in prompt.lower()


# ─── screen context: code on screen, question asked out loud ────────────────

BUGGY = "1  def avg(xs):\n2      return sum(xs) / len(xs) - 1"


def test_user_prompt_includes_what_is_on_screen() -> None:
    prompt = answer_user_prompt("What's wrong with this function?", screen_context=BUGGY)
    assert "<on_screen>" in prompt
    assert BUGGY in prompt
    # Screen first, question last: the question stays the final thing read.
    assert prompt.index("<on_screen>") < prompt.index("<question>")


def test_user_prompt_without_screen_has_no_block() -> None:
    assert "<on_screen>" not in answer_user_prompt("Tell me about yourself.")


def test_system_prompt_ties_spoken_references_to_the_screen() -> None:
    prompt = answer_system_prompt(AnswerContext())
    assert "SCREEN CONTEXT" in prompt
    assert "<on_screen>" in prompt
    assert "line numbers" in prompt


def test_answer_section_is_written_to_be_spoken() -> None:
    # The candidate reads ⭐ Answer aloud live; note-style fragments, symbols
    # and bold labels make it obvious they are reading.
    prompt = answer_system_prompt(AnswerContext())
    assert "SPOKEN DELIVERY" in prompt
    assert "contractions" in prompt
    assert "heard once" in prompt
    assert "phrase or short sentence the candidate can expand on" not in prompt
