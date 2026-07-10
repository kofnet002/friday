from app.services.coding_extraction import _parse_extraction_json


def test_parse_extraction_repairs_unquoted_keys_and_trailing_commas() -> None:
    result = _parse_extraction_json(
        '{is_coding_problem: true, problem_statement: "Two sum", confidence: 0.9,}'
    )
    assert result.is_coding_problem is True
    assert result.problem_statement == "Two sum"
