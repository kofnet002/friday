"""The language the candidate picks must win over the starter code vision read
off the screen (e.g. the page's editor still showed Python)."""

from app.prompts.coding_solution import (
    CodingSolutionContext,
    coding_solution_system_prompt,
    coding_solution_user_prompt,
)

PY_STARTER = "from typing import List\n\ndef merge(xs: List[int]) -> List[int]:\n    pass"


def test_system_prompt_puts_the_chosen_language_above_the_starter() -> None:
    prompt = coding_solution_system_prompt(CodingSolutionContext(language="JavaScript"))
    assert "Always write the code in JavaScript" in prompt
    assert "port" in prompt
    assert "mergeBookings" in prompt
    assert "the starter code wins —" not in prompt


def test_user_prompt_flags_a_starter_in_another_language() -> None:
    problem = {"problem_statement": "Merge it.", "function_signature": PY_STARTER,
               "language_hint": "Python"}
    prompt = coding_solution_user_prompt(problem, language="JavaScript")
    assert "Starter code (Python)" in prompt
    assert "Port it to JavaScript" in prompt
    assert "camelCase" in prompt


def test_user_prompt_same_language_needs_no_port_note() -> None:
    problem = {"problem_statement": "Merge it.", "function_signature": PY_STARTER,
               "language_hint": "python"}
    assert "Port it" not in coding_solution_user_prompt(problem, language="Python")


def test_user_prompt_without_language_is_unchanged() -> None:
    problem = {"problem_statement": "Merge it.", "function_signature": PY_STARTER}
    assert "**Starter code:**" in coding_solution_user_prompt(problem)
