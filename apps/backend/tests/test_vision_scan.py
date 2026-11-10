import base64

import pytest
from pydantic import ValidationError

from app.api.vision import ExtractRequest, decode_images, mark_scan_incomplete, should_emit_screen_question
from app.models.coding import ExtractedProblem


def test_extract_request_accepts_exactly_one_image_source():
    with pytest.raises(ValidationError):
        ExtractRequest(session_id="s")
    with pytest.raises(ValidationError):
        ExtractRequest(session_id="s", image_base64="A" * 16, images_base64=["A" * 16])


def test_decode_images_accepts_ordered_images_and_enforces_image_cap():
    one = base64.b64encode(b"first-image-data").decode()
    two = base64.b64encode(b"second-image-data").decode()
    assert decode_images([one, two]) == [b"first-image-data", b"second-image-data"]
    with pytest.raises(ValueError, match="12"):
        decode_images([one] * 13)


def test_decode_images_rejects_invalid_or_oversized_data():
    with pytest.raises(ValueError, match="base64"):
        decode_images(["not valid base64!!!"])
    huge = base64.b64encode(b"x" * (32 * 1024 * 1024 + 1)).decode()
    with pytest.raises(ValueError, match="32 MiB"):
        decode_images([huge])


def test_scan_limit_forces_partial_completeness_for_questions_and_coding():
    problem = ExtractedProblem(
        is_coding_problem=False,
        is_screen_question=True,
        question="Explain the system shown.",
        completeness="complete",
        confidence=0.95,
    )
    limited = mark_scan_incomplete(problem)
    assert limited.completeness == "partial"
    assert "remaining page content may not have been captured" in limited.missing_sections


def test_coding_problem_is_not_routed_as_a_written_screen_question():
    coding = ExtractedProblem(
        is_coding_problem=True,
        is_screen_question=True,
        question="Implement this algorithm.",
        confidence=0.95,
    )
    assert should_emit_screen_question(coding) is False
