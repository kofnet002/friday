from app.models.coding import ExtractedProblem


def test_legacy_extraction_payload_gets_safe_screen_defaults():
    problem = ExtractedProblem(is_coding_problem=True, confidence=0.9)
    assert problem.is_screen_question is False
    assert problem.question is None
    assert problem.screen_code is None
    assert problem.completeness == "uncertain"
    assert problem.missing_sections == []


def test_screen_question_and_visible_code_are_preserved():
    problem = ExtractedProblem(
        is_coding_problem=False,
        is_screen_question=True,
        question="How would you design a rate limiter?",
        screen_code="class Limiter: ...",
        completeness="partial",
        missing_sections=["constraints"],
        confidence=0.8,
    )
    assert problem.is_screen_question
    assert problem.question == "How would you design a rate limiter?"
    assert problem.screen_code == "class Limiter: ..."
    assert problem.completeness == "partial"
    assert problem.missing_sections == ["constraints"]


def test_invalid_completeness_is_rejected():
    try:
        ExtractedProblem(is_coding_problem=False, completeness="guess", confidence=0.1)
    except Exception as exc:
        assert "completeness" in str(exc)
    else:
        raise AssertionError("invalid completeness should be rejected")
