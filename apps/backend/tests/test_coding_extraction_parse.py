from app.services.coding_extraction import _parse_extraction_json


def test_parse_extraction_repairs_unquoted_keys_and_trailing_commas() -> None:
    result = _parse_extraction_json(
        '{is_coding_problem: true, problem_statement: "Two sum", confidence: 0.9,}'
    )
    assert result.is_coding_problem is True
    assert result.problem_statement == "Two sum"


def test_parse_extraction_accepts_a_general_screen_question() -> None:
    result = _parse_extraction_json(
        '{"is_coding_problem": false, "is_screen_question": true, '
        '"question": "When API requests work in Postman but fail in the browser, what could be the issue?", '
        '"confidence": 0.96}'
    )
    assert result.is_screen_question is True
    assert result.question and result.question.startswith("When API requests")
