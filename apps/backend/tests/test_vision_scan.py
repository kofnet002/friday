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


# --- visual frames kept during extraction ---

from app import session_bus  # noqa: E402
from app.api import vision  # noqa: E402
from app.redis_client import get_current_screen_images, get_screen_image, get_screen_references  # noqa: E402
from app.services.screen_memory import image_key  # noqa: E402
from tests.fake_redis import install_fake_redis  # noqa: E402


def _images(n: int) -> list[str]:
    return [base64.b64encode(f"image-number-{i}-data".encode()).decode() for i in range(n)]


def _problem(**kw) -> ExtractedProblem:
    base = dict(
        is_coding_problem=False,
        is_screen_question=True,
        question="Q?",
        visible_context="A passage about a chart.",
        confidence=0.95,
    )
    base.update(kw)
    return ExtractedProblem(**base)


def _setup(monkeypatch, problem: ExtractedProblem):
    fake = install_fake_redis(monkeypatch)

    async def fake_extract(*_a, **_k):
        return problem

    async def fake_get_redis():
        return fake

    # coding_extraction imported get_redis by name; keep it off a real Redis.
    monkeypatch.setattr("app.services.coding_extraction.get_redis", fake_get_redis)
    monkeypatch.setattr(vision, "extract_problem", fake_extract)
    monkeypatch.setattr(session_bus, "has_subscriber", lambda _sid: True)
    return fake


@pytest.fixture(autouse=True)
def _fresh_scan_cache():
    vision._scan_extractions._tasks.clear()


async def test_visual_frames_are_kept_as_current_images(monkeypatch):
    imgs = _images(3)
    _setup(monkeypatch, _problem(visual_frames=[1]))
    await vision.extract(ExtractRequest(session_id="s", images_base64=imgs))
    assert await get_current_screen_images("s") == [image_key(imgs[1])]


async def test_speculative_text_read_keeps_current_images(monkeypatch):
    imgs = _images(3)
    problem = _problem(visual_frames=[1])
    _setup(monkeypatch, problem)
    await vision.extract(ExtractRequest(session_id="s", images_base64=imgs))
    problem.visual_frames = []
    await vision.extract(ExtractRequest(session_id="s", images_base64=_images(2), speculative=True))
    assert await get_current_screen_images("s") == [image_key(imgs[1])]


async def test_final_text_read_clears_current_images(monkeypatch):
    imgs = _images(3)
    problem = _problem(visual_frames=[1])
    _setup(monkeypatch, problem)
    await vision.extract(ExtractRequest(session_id="s", images_base64=imgs))
    problem.visual_frames = []
    await vision.extract(ExtractRequest(session_id="s", images_base64=_images(2)))
    assert await get_current_screen_images("s") == []
    assert await get_screen_image("s", image_key(imgs[1])) is None


async def test_reference_with_visuals_keeps_its_images(monkeypatch):
    imgs = _images(2)
    _setup(monkeypatch, _problem(is_reference_material=True, visual_frames=[0]))
    await vision.extract(ExtractRequest(session_id="s", images_base64=imgs))
    refs = await get_screen_references("s")
    assert len(refs) == 1 and refs[0].image_keys == [image_key(imgs[0])]


async def test_text_only_page_stores_no_images(monkeypatch):
    fake = _setup(monkeypatch, _problem(visual_frames=[]))
    await vision.extract(ExtractRequest(session_id="s", images_base64=_images(2)))
    assert not [k for k in fake.store if ":screen_image:" in k]


async def test_single_frame_data_url_is_stored_stripped(monkeypatch):
    img = _images(1)[0]
    fake = _setup(monkeypatch, _problem(visual_frames=[0]))
    await vision.extract(
        ExtractRequest(session_id="s", image_base64="data:image/png;base64," + img, force=True)
    )
    assert fake.store[f"session:s:screen_image:{image_key(img)}"] == img


def test_null_visual_frames_become_empty():
    assert _problem(visual_frames=None).visual_frames == []
