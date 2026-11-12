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


def test_reference_material_defaults_off():
    assert ExtractedProblem(is_coding_problem=False, confidence=0.9).is_reference_material is False


def test_screen_context_keeps_earlier_reference_after_screen_changes():
    from app.api.vision import compose_screen_context, merge_references

    passage = "Passage: Acme sells widgets in three regions..."
    refs = merge_references([], passage)
    # Re-reading the same passage doesn't duplicate it.
    assert merge_references(refs, passage) == [passage]

    context = compose_screen_context("Q3. Which region grew fastest?", refs)
    assert context.index("Q3. Which region grew fastest?") < context.index(passage)
    assert "Earlier reference material" in context


def test_reference_store_is_bounded_and_drops_oldest():
    from app.api.vision import MAX_REFERENCE_CHARS, merge_references

    refs: list[str] = []
    for i in range(10):
        refs = merge_references(refs, f"passage {i} " + "x" * 3000)
    assert sum(len(r) for r in refs) <= MAX_REFERENCE_CHARS
    assert refs[-1].startswith("passage 9")
    assert not any(r.startswith("passage 0") for r in refs)


def test_extended_or_rescanned_reference_replaces_its_shorter_version():
    from app.api.vision import merge_references

    refs = merge_references([], "Case study: the team migrated")
    refs = merge_references(refs, "Case study: the team migrated to Postgres in 2021.")
    assert refs == ["Case study: the team migrated to Postgres in 2021."]


def test_compose_without_references_is_just_current_screen():
    from app.api.vision import compose_screen_context

    assert compose_screen_context("visible", []) == "visible"
    assert compose_screen_context("", []) == ""


def test_answer_prefers_backend_screen_context_over_renderer_copy():
    from app.api.ws_answer import resolve_screen_context

    stored = "Q1 ...\n\nEarlier reference material on screen: passage"
    # Renderer copy can lag a scan (IPC arrives after the question event) and
    # never includes remembered passages — the stored context wins.
    assert resolve_screen_context({"screen_context": "previous screen"}, stored) == stored
    # Screen capture off: the renderer sends "" — no screen context at all.
    assert resolve_screen_context({"screen_context": ""}, stored) is None
    # Redis unavailable: fall back to the renderer copy.
    assert resolve_screen_context({"screen_context": "renderer copy"}, None) == "renderer copy"
    assert resolve_screen_context({}, stored) == stored
    assert resolve_screen_context({}, None) is None


def test_questions_list_and_primary_question_stay_consistent():
    many = ExtractedProblem(
        is_coding_problem=False,
        is_screen_question=True,
        questions=["Q1 A) x B) y", "Q2 A) p B) q"],
        confidence=0.9,
    )
    assert many.question == "Q1 A) x B) y"

    legacy = ExtractedProblem(
        is_coding_problem=False, is_screen_question=True, question="Only one?", confidence=0.9
    )
    assert legacy.questions == ["Only one?"]

    cleaned = ExtractedProblem(
        is_coding_problem=False,
        is_screen_question=True,
        questions=["Q1", " ", "Q1", "Q2"],
        confidence=0.9,
    )
    assert cleaned.questions == ["Q1", "Q2"]


def test_screen_question_event_carries_every_question():
    from app.api.vision import screen_question_event

    problem = ExtractedProblem(
        is_coding_problem=False,
        is_screen_question=True,
        questions=["Q1", "Q2", "Q3"],
        completeness="complete",
        confidence=0.9,
    )
    event = screen_question_event(problem, is_scan=True)
    assert event["type"] == "screen_question_detected"
    assert event["questions"] == ["Q1", "Q2", "Q3"]
    assert event["question"] == "Q1"
    assert event["source"] == "guided_scan"


def test_reference_saved_event_has_a_short_preview():
    from app.api.vision import reference_saved_event

    passage = "Northwind Logistics operates warehouses in three regions. " * 10
    event = reference_saved_event([passage, "second"], passage)
    assert event["type"] == "screen_reference_saved"
    assert event["count"] == 2
    assert event["preview"].startswith("Northwind Logistics operates")
    assert len(event["preview"]) <= 121


def test_clear_screen_context_endpoint_clears_session_state(monkeypatch):
    from fastapi.testclient import TestClient

    from app.api import vision
    from app.main import app

    cleared: list[str] = []

    async def fake_clear(session_id: str) -> None:
        cleared.append(session_id)

    monkeypatch.setattr(vision, "clear_screen_state", fake_clear)
    response = TestClient(app).delete("/api/vision/screen-context", params={"session_id": "s1"})
    assert response.status_code == 200
    assert response.json() == {"ok": True}
    assert cleared == ["s1"]
