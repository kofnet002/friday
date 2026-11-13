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
    refs = merge_references([], passage, [])
    # Re-reading the same passage doesn't duplicate it.
    assert [r.text for r in merge_references(refs, passage, [])] == [passage]

    context = compose_screen_context("Q3. Which region grew fastest?", refs)
    assert context.index("Q3. Which region grew fastest?") < context.index(passage)
    assert "Earlier reference material" in context


def test_reference_store_is_bounded_and_drops_oldest():
    from app.api.vision import MAX_REFERENCE_CHARS, merge_references
    from app.services.screen_memory import ScreenReference

    refs: list[ScreenReference] = []
    for i in range(10):
        refs = merge_references(refs, f"passage {i} " + "x" * 3000, [])
    assert sum(len(r.text) for r in refs) <= MAX_REFERENCE_CHARS
    assert refs[-1].text.startswith("passage 9")
    assert not any(r.text.startswith("passage 0") for r in refs)


def test_extended_or_rescanned_reference_replaces_its_shorter_version():
    from app.api.vision import merge_references

    refs = merge_references([], "Case study: the team migrated", [])
    refs = merge_references(refs, "Case study: the team migrated to Postgres in 2021.", [])
    assert [r.text for r in refs] == ["Case study: the team migrated to Postgres in 2021."]


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
    from app.services.screen_memory import ScreenReference

    passage = "Northwind Logistics operates warehouses in three regions. " * 10
    event = reference_saved_event(
        [ScreenReference("1", passage, [], 1.0), ScreenReference("2", "second", [], 2.0)], passage
    )
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


def test_visual_frames_default_empty():
    assert ExtractedProblem(is_coding_problem=False, confidence=0.9).visual_frames == []


def test_valid_visual_frames_drops_out_of_range_and_duplicates():
    p = ExtractedProblem(is_coding_problem=False, confidence=0.9, visual_frames=[3, 0, 0, -1, 7])
    assert p.valid_visual_frames(4) == [0, 3]


def test_extraction_prompt_asks_for_tables_charts_and_visual_frames():
    from app.prompts.coding_extraction import (
        CODING_EXTRACTION_SYSTEM_PROMPT as P,
        CODING_EXTRACTION_VERSION,
    )

    assert '"visual_frames": number[]' in P
    assert "Markdown table" in P
    assert "[unreadable]" in P
    assert '"visual_frame_labels": string[]' in P
    assert CODING_EXTRACTION_VERSION == "1.8.0"


def test_visual_frame_labels_align_with_visual_frames():
    def make(frames, labels):
        return ExtractedProblem(
            is_coding_problem=False,
            confidence=0.9,
            visual_frames=frames,
            visual_frame_labels=labels,
        )

    assert make([0, 2], ["Figure 1"]).visual_frame_labels == ["Figure 1", ""]
    assert make([1], ["Figure 2", "extra"]).visual_frame_labels == ["Figure 2"]
    assert make([1], None).visual_frame_labels == [""]
    assert make(None, None).visual_frame_labels == []
    # A bad caption never fails the whole read.
    assert make([0, 1, 2], [None, 7, "  Figure 3 "]).visual_frame_labels == ["", "", "Figure 3"]
    assert make([0], "not a list").visual_frame_labels == [""]
    # Labels follow their frame through dedupe / range filtering.
    p = make([3, 0, 0, 9], ["Fig D", "Fig A", "dup", "out"])
    assert p.labelled_visual_frames(4) == [(0, "Fig A"), (3, "Fig D")]


# --- passage viewer endpoints ---

import base64  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.redis_client import (  # noqa: E402
    get_screen_context,
    put_screen_images,
    set_screen_context,
    set_screen_current_text,
    set_screen_references,
)
from app.services.screen_memory import ScreenReference, compose_screen_context  # noqa: E402
from tests.fake_redis import install_fake_redis  # noqa: E402

_JPEG = b"\xff\xd8\xff\xe0" + b"fakejpegbody"


@pytest.fixture
def viewer(monkeypatch):
    fake = install_fake_redis(monkeypatch)
    return TestClient(app), fake


def _seed(sid="s1"):
    async def go():
        (key,) = await put_screen_images(
            sid, [base64.b64encode(_JPEG).decode()], ["Figure 1 (bar chart: Sales)"]
        )
        refs = [
            ScreenReference(id="legacy1", text="Old passage text"),
            ScreenReference(id="ref2", text="Chart passage", image_keys=[key], saved_at=5.0),
        ]
        await set_screen_references(sid, refs)
        await set_screen_current_text(sid, "Current screen")
        await set_screen_context(sid, compose_screen_context("Current screen", refs))
        return key

    return go()


def test_list_returns_legacy_and_object_refs(viewer):
    import asyncio

    client, _ = viewer
    key = asyncio.run(_seed())
    body = client.get("/api/vision/screen-context", params={"session_id": "s1"}).json()
    assert [r["id"] for r in body["references"]] == ["legacy1", "ref2"]
    assert body["references"][0]["images"] == []
    assert body["references"][1] == {
        "id": "ref2",
        "text": "Chart passage",
        "images": [{"key": key, "label": "Figure 1 (bar chart: Sales)"}],
        "saved_at": 5.0,
    }


def test_image_endpoint_serves_bytes_and_404s(viewer):
    import asyncio

    client, _ = viewer
    key = asyncio.run(_seed())
    r = client.get(f"/api/vision/screen-image/{key}", params={"session_id": "s1"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert r.content == _JPEG
    assert client.get("/api/vision/screen-image/nope", params={"session_id": "s1"}).status_code == 404


def test_delete_removes_passage_image_and_text(viewer):
    import asyncio

    client, _ = viewer
    key = asyncio.run(_seed())
    r = client.delete("/api/vision/screen-reference/ref2", params={"session_id": "s1"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "count": 1}
    assert client.get(f"/api/vision/screen-image/{key}", params={"session_id": "s1"}).status_code == 404
    ctx = asyncio.run(get_screen_context("s1"))
    assert ctx is not None
    assert "Chart passage" not in ctx
    assert "Old passage text" in ctx
    assert "Current screen" in ctx
    missing = client.delete("/api/vision/screen-reference/zzz", params={"session_id": "s1"})
    assert missing.status_code == 404


def test_screen_images_are_never_cached(viewer):
    import asyncio

    client, _ = viewer
    key = asyncio.run(_seed())
    r = client.get(f"/api/vision/screen-image/{key}", params={"session_id": "s1"})
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-store"
    assert r.headers["pragma"] == "no-cache"


def test_image_key_must_be_32_hex_chars(viewer):
    import asyncio

    client, fake = viewer
    key = asyncio.run(_seed())
    # Only image keys we mint (32 lowercase hex) are looked up at all.
    fake.store["session:s1:screen_image:notakey"] = base64.b64encode(_JPEG).decode()
    for bad in ("notakey", key.upper(), key[:-1], key + "0", "*"):
        r = client.get(f"/api/vision/screen-image/{bad}", params={"session_id": "s1"})
        assert r.status_code == 404, bad


def test_viewer_endpoints_reject_malformed_session_ids(viewer):
    import asyncio

    client, fake = viewer
    asyncio.run(_seed())
    before = dict(fake.store)
    for sid in ("*", "s?", "s1:screen_image", "a b", "x" * 65, ""):
        params = {"session_id": sid}
        assert client.delete("/api/vision/screen-context", params=params).status_code == 422
        assert client.get("/api/vision/screen-context", params=params).status_code == 422
    assert fake.store == before
    # A real (uuid4) session id is accepted.
    sid = "0b7d3c8e-4a52-4f0e-9a1d-3f6c2b1e9d70"
    assert client.get("/api/vision/screen-context", params={"session_id": sid}).status_code == 200
