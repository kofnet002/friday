"""Scroll-scan extraction: several screenshots of one page → one problem, plus
suppression of watcher re-reads that only show a slice of a known problem."""

from __future__ import annotations

import base64
import os
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from app.api import vision
from app.api.vision import ExtractRequest
from app.models.coding import ExtractedProblem
from app.prompts.coding_extraction import (
    EXTRACTION_MAX_OUTPUT_TOKENS,
    EXTRACTION_SCAN_MAX_IMAGES,
    EXTRACTION_SCAN_MAX_OUTPUT_TOKENS,
)
from app.services import claude_cli, coding_extraction
from app.services.coding_extraction import extraction_plan, is_fragment_of
from app.settings import settings

JPEG = b"\xff\xd8\xff\xe0" + b"jpeg-bytes-" * 4
PNG = b"\x89PNG\r\n\x1a\n" + b"png-bytes-" * 4


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


STATEMENT = (
    "Given an array of integers nums and an integer target, return indices of the two"
    " numbers such that they add up to target. You may assume that each input would have"
    " exactly one solution, and you may not use the same element twice. You can return the"
    " answer in any order."
)


def make_problem(**overrides: Any) -> ExtractedProblem:
    base: dict[str, Any] = {
        "is_coding_problem": True,
        "title": "1. Two Sum",
        "problem_statement": STATEMENT,
        "examples": [
            {"input": "nums = [2,7,11,15], target = 9", "output": "[0,1]", "explanation": None},
            {"input": "nums = [3,2,4], target = 6", "output": "[1,2]", "explanation": None},
        ],
        "constraints": ["2 <= nums.length <= 10^4", "-10^9 <= nums[i] <= 10^9"],
        "function_signature": "class Solution:\n    def twoSum(self, nums, target):",
        "confidence": 0.95,
    }
    base.update(overrides)
    return ExtractedProblem.model_validate(base)


# ─── request validation ──────────────────────────────────────────────────────


def test_request_requires_exactly_one_image_source() -> None:
    with pytest.raises(ValidationError):
        ExtractRequest(session_id="s")
    with pytest.raises(ValidationError):
        ExtractRequest(session_id="s", image_base64=b64(JPEG), images_base64=[b64(JPEG)])


def test_request_caps_scan_frames() -> None:
    too_many = [b64(JPEG)] * (EXTRACTION_SCAN_MAX_IMAGES + 1)
    with pytest.raises(ValidationError):
        ExtractRequest(session_id="s", images_base64=too_many)
    with pytest.raises(ValidationError):
        ExtractRequest(session_id="s", images_base64=[])


def test_request_scan_flag() -> None:
    assert ExtractRequest(session_id="s", images_base64=[b64(JPEG)] * 3).is_scan
    assert not ExtractRequest(session_id="s", image_base64=b64(JPEG)).is_scan


# ─── prompt plan ─────────────────────────────────────────────────────────────


def test_single_frame_plan_is_unchanged() -> None:
    plan = extraction_plan(1)
    assert "MULTI-SCREENSHOT" not in plan.system
    assert plan.max_output_tokens == EXTRACTION_MAX_OUTPUT_TOKENS


def test_cropped_scan_plan_explains_frame_layout() -> None:
    plan = extraction_plan(5, cropped=True)
    assert "Screenshot 1 is the WHOLE screen" in plan.system
    assert "Screenshots 2-5" in plan.system
    assert "WHOLE screen" not in extraction_plan(5).system


async def test_route_forwards_crop_flag_for_scans_only(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[bool] = []

    async def fake_extract(images: list[bytes], sid: str, provider: Any = None, *, cropped: bool):
        seen.append(cropped)
        return make_problem()

    h = RouteHarness(monkeypatch, make_problem())
    monkeypatch.setattr(vision, "extract_problem", fake_extract)
    await vision.extract(
        ExtractRequest(session_id="s", images_base64=[b64(JPEG)] * 3, scan_cropped=True)
    )
    await vision.extract(
        ExtractRequest(session_id="s", image_base64=b64(JPEG), force=True, scan_cropped=True)
    )
    assert seen == [True, False]
    assert h.published


async def test_route_rejects_non_base64_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    h = RouteHarness(monkeypatch, make_problem())
    with pytest.raises(vision.HTTPException) as exc:
        await vision.extract(ExtractRequest(session_id="s", images_base64=[b64(JPEG), "QUJD*"]))
    assert exc.value.status_code == 400
    assert h.extract_calls == []


async def test_route_rejects_oversized_scan(monkeypatch: pytest.MonkeyPatch) -> None:
    h = RouteHarness(monkeypatch, make_problem())
    monkeypatch.setattr(vision, "MAX_DECODED_IMAGE_BYTES", len(JPEG) * 2)
    with pytest.raises(vision.HTTPException) as exc:
        await vision.extract(ExtractRequest(session_id="s", images_base64=[b64(JPEG)] * 3))
    assert exc.value.status_code == 413
    assert h.extract_calls == []


def test_scan_plan_adds_merge_rules_and_budget() -> None:
    plan = extraction_plan(4)
    assert "MULTI-SCREENSHOT SCAN" in plan.system
    assert "You are given 4 screenshots" in plan.system
    assert "4 screenshots" in plan.user_text
    assert plan.max_output_tokens == EXTRACTION_SCAN_MAX_OUTPUT_TOKENS
    assert plan.timeout_s > extraction_plan(1).timeout_s


# ─── fragment detection ──────────────────────────────────────────────────────


def test_bottom_slice_is_fragment_of_full_problem() -> None:
    full = make_problem()
    slice_ = make_problem(
        problem_statement="exactly one solution, and you may not use the same element twice."
        " You can return the answer in any order.",
        examples=full.examples[1:] if full.examples else None,
        confidence=0.75,
    )
    assert is_fragment_of(slice_, full)


def test_untitled_slice_is_fragment() -> None:
    full = make_problem()
    slice_ = make_problem(title=None, examples=None, function_signature=None)
    assert is_fragment_of(slice_, full)


def test_identical_reread_is_fragment() -> None:
    assert is_fragment_of(make_problem(), make_problem())


def test_more_examples_is_not_a_fragment() -> None:
    full = make_problem(examples=None)
    assert not is_fragment_of(make_problem(), full)


def test_more_constraints_or_new_signature_is_not_a_fragment() -> None:
    assert not is_fragment_of(make_problem(), make_problem(constraints=None))
    assert not is_fragment_of(make_problem(), make_problem(function_signature=None))


def test_longer_statement_is_not_a_fragment() -> None:
    partial = make_problem(problem_statement=STATEMENT[:120])
    assert not is_fragment_of(make_problem(), partial)


def test_different_title_is_not_a_fragment() -> None:
    assert not is_fragment_of(make_problem(title="2. Add Two Numbers"), make_problem())


def test_unrelated_problem_is_not_a_fragment() -> None:
    other = make_problem(
        title=None,
        problem_statement="You are given two non-empty linked lists representing two"
        " non-negative integers stored in reverse order.",
    )
    assert not is_fragment_of(other, make_problem())


# ─── route ───────────────────────────────────────────────────────────────────


class RouteHarness:
    def __init__(self, monkeypatch: pytest.MonkeyPatch, result: ExtractedProblem) -> None:
        self.result = result
        self.extract_calls: list[int] = []
        self.published: list[dict[str, Any]] = []
        self.cache_reads = 0
        self.known: ExtractedProblem | None = None
        self.armed: list[ExtractedProblem] = []
        self.subscribed = True

        async def fake_extract(
            images: list[bytes], session_id: str, provider: Any = None, *, cropped: bool = False
        ):
            self.extract_calls.append(len(images))
            return self.result

        async def fake_cached(*_: Any) -> None:
            self.cache_reads += 1

        async def fake_publish(_sid: str, msg: dict[str, Any]) -> bool:
            self.published.append(msg)
            return True

        async def fake_get_current(_sid: str) -> str | None:
            return self.known.model_dump_json() if self.known else None

        async def fake_arm(_sid: str, problem: ExtractedProblem) -> None:
            self.armed.append(problem)

        async def noop(*_: Any) -> bool:
            return True

        monkeypatch.setattr(vision, "extract_problem", fake_extract)
        monkeypatch.setattr(vision, "cached_result", fake_cached)
        monkeypatch.setattr(vision, "cooldown_problem", fake_cached)
        monkeypatch.setattr(vision, "store_result", noop)
        monkeypatch.setattr(vision, "arm_cooldown", fake_arm)
        monkeypatch.setattr(vision, "add_seen_problem_fingerprint", noop)
        monkeypatch.setattr(vision, "set_current_problem", noop)
        monkeypatch.setattr(vision, "set_screen_context", noop)
        monkeypatch.setattr(vision, "get_current_problem", fake_get_current)
        monkeypatch.setattr(vision.session_bus, "publish", fake_publish)
        monkeypatch.setattr(vision.session_bus, "has_subscriber", lambda _sid: self.subscribed)
        monkeypatch.setattr(settings, "vision_cooldown_s", 25)


async def test_scan_sends_every_frame_and_bypasses_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    h = RouteHarness(monkeypatch, make_problem())
    h.subscribed = False  # scans are explicit — never skipped for "no listener"
    res = await vision.extract(
        ExtractRequest(session_id="s", images_base64=[b64(JPEG), b64(PNG), b64(JPEG)])
    )
    assert h.extract_calls == [3]
    assert h.cache_reads == 0
    assert res["emitted"] is True
    assert h.published[0]["type"] == "coding_problem_detected"
    assert h.published[0]["source"] == "scan"


async def test_scan_is_never_suppressed_as_fragment(monkeypatch: pytest.MonkeyPatch) -> None:
    h = RouteHarness(monkeypatch, make_problem())
    h.known = make_problem()  # even an identical known problem → explicit scan emits
    res = await vision.extract(ExtractRequest(session_id="s", images_base64=[b64(JPEG)] * 2))
    assert res["emitted"] is True


async def test_watcher_slice_of_known_problem_is_suppressed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    full = make_problem()
    h = RouteHarness(
        monkeypatch, make_problem(examples=None, constraints=None, function_signature=None)
    )
    h.known = full
    res = await vision.extract(ExtractRequest(session_id="s", image_base64=b64(JPEG)))
    assert res["emitted"] is False
    assert res["suppressed"] == "fragment_of_current"
    assert h.published == []
    # Cooldown re-armed on the KNOWN (complete) problem, not the slice.
    assert h.armed and h.armed[-1].examples == full.examples


async def test_watcher_new_problem_still_emits(monkeypatch: pytest.MonkeyPatch) -> None:
    h = RouteHarness(monkeypatch, make_problem(title="2. Add Two Numbers"))
    h.known = make_problem()
    res = await vision.extract(ExtractRequest(session_id="s", image_base64=b64(JPEG)))
    assert res["emitted"] is True
    assert h.published[0]["source"] == "auto"


async def test_force_reextract_is_not_suppressed(monkeypatch: pytest.MonkeyPatch) -> None:
    h = RouteHarness(monkeypatch, make_problem(examples=None))
    h.known = make_problem()
    res = await vision.extract(ExtractRequest(session_id="s", image_base64=b64(JPEG), force=True))
    assert res["emitted"] is True
    assert h.published[0]["source"] == "force"


async def test_scan_screen_question_carries_source(monkeypatch: pytest.MonkeyPatch) -> None:
    question = make_problem(
        is_coding_problem=False,
        is_screen_question=True,
        question="Describe how you would design a rate limiter for a public API.",
        problem_statement=None,
    )
    h = RouteHarness(monkeypatch, question)
    await vision.extract(ExtractRequest(session_id="s", images_base64=[b64(JPEG)] * 2))
    assert h.published[0] == {
        "type": "screen_question_detected",
        "question": question.question,
        "fingerprint": h.published[0]["fingerprint"],
        "source": "scan",
    }


# ─── provider payloads ───────────────────────────────────────────────────────

PROBLEM_JSON = make_problem().model_dump_json()


async def test_gemini_receives_all_images_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    class FakeModels:
        async def generate_content(self, *, model: str, contents: list[Any], config: Any) -> Any:
            captured["contents"] = contents
            captured["config"] = config
            return type("R", (), {"text": PROBLEM_JSON, "usage_metadata": None})()

    class FakeClient:
        def __init__(self, api_key: str) -> None:
            self.aio = type("A", (), {"models": FakeModels()})()

    monkeypatch.setattr(settings, "gemini_api_key", "k")
    monkeypatch.setattr(coding_extraction.genai, "Client", FakeClient)
    plan = extraction_plan(3)
    problem, _, _ = await coding_extraction._extract_gemini([JPEG, PNG, JPEG], plan)
    assert problem.title == "1. Two Sum"
    parts = captured["contents"]
    assert [p.inline_data.mime_type for p in parts[:3]] == ["image/jpeg", "image/png", "image/jpeg"]
    assert [p.inline_data.data for p in parts[:3]] == [JPEG, PNG, JPEG]
    assert parts[3] == plan.user_text
    assert captured["config"].max_output_tokens == EXTRACTION_SCAN_MAX_OUTPUT_TOKENS
    assert "MULTI-SCREENSHOT SCAN" in captured["config"].system_instruction


async def test_openai_receives_all_images_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    class Parsed:
        def __init__(self) -> None:
            msg = type(
                "M",
                (),
                {
                    "refusal": None,
                    "parsed": coding_extraction._StrictExtraction.model_validate(
                        {
                            **make_problem().model_dump(),
                            "examples": [
                                {**e, "unreliable": False}
                                for e in make_problem().model_dump()["examples"]
                            ],
                        }
                    ),
                },
            )()
            self.choices = [type("C", (), {"message": msg})()]
            self.usage = None

    class FakeCompletions:
        async def parse(self, **kwargs: Any) -> Parsed:
            captured.update(kwargs)
            return Parsed()

    class FakeOpenAI:
        def __init__(self, **kwargs: Any) -> None:
            captured["client_kwargs"] = kwargs
            self.beta = type(
                "B", (), {"chat": type("Ch", (), {"completions": FakeCompletions()})()}
            )()

    monkeypatch.setattr(settings, "openai_api_key", "k")
    monkeypatch.setattr(coding_extraction, "AsyncOpenAI", FakeOpenAI)
    plan = extraction_plan(2)
    problem, _, _ = await coding_extraction._extract_openai([JPEG, PNG], plan, model="gpt-4o")
    assert problem.is_coding_problem
    content = captured["messages"][1]["content"]
    assert content[0] == {"type": "text", "text": plan.user_text}
    urls = [part["image_url"]["url"] for part in content[1:]]
    assert urls == [
        f"data:image/jpeg;base64,{b64(JPEG)}",
        f"data:image/png;base64,{b64(PNG)}",
    ]
    assert captured["client_kwargs"]["timeout"] == plan.timeout_s


async def test_claude_cli_writes_every_frame_and_names_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, Any] = {}

    class FakeStream:
        def __init__(self, lines: list[bytes]) -> None:
            self._lines = lines

        def __aiter__(self) -> FakeStream:
            return self

        async def __anext__(self) -> bytes:
            if not self._lines:
                raise StopAsyncIteration
            return self._lines.pop(0)

        async def read(self, _n: int = -1) -> bytes:
            return b""

    class FakeStdin:
        def write(self, data: bytes) -> None:
            seen["stdin"] = data.decode()

        async def drain(self) -> None:
            return None

        def close(self) -> None:
            return None

    class FakeProc:
        returncode = 0
        pid = 0

        def __init__(self, cwd: str) -> None:
            seen["files"] = sorted(os.listdir(cwd))
            seen["bytes"] = [Path(cwd, f).read_bytes() for f in seen["files"]]
            self.stdin = FakeStdin()
            self.stdout = FakeStream([b'{"type":"result","subtype":"success","result":"{}"}\n'])
            self.stderr = FakeStream([])

        async def wait(self) -> int:
            return 0

    async def fake_exec(*_cmd: Any, cwd: str, **_kw: Any) -> FakeProc:
        return FakeProc(cwd)

    monkeypatch.setattr(claude_cli, "claude_cli_ready", lambda _sid: None)
    monkeypatch.setattr(claude_cli, "resolve_agent_env", lambda _sid: {})
    monkeypatch.setattr(claude_cli.asyncio, "create_subprocess_exec", fake_exec)
    await claude_cli.run_claude_cli_vision(images=[JPEG, PNG, JPEG], prompt="go", system="sys")
    assert seen["files"] == ["screen-01.jpg", "screen-02.png", "screen-03.jpg"]
    assert seen["bytes"] == [JPEG, PNG, JPEG]
    assert "screen-01.jpg, screen-02.png, screen-03.jpg" in seen["stdin"]


def test_screen_question_rule_demands_full_context() -> None:
    # Models read "transcribe that question" as just the final ask (the form
    # fields) and dropped the facts and code the answer depends on.
    plan = extraction_plan(4)
    assert "COMPLETE question" in plan.system
    assert "Never reduce it to only the final ask" in plan.system


# ─── screen context for spoken questions ─────────────────────────────────────

BUGGY_CODE = "1  async function pay(id) {\n2    await bank.transfer(id)\n3  }"


def test_extraction_rule_transcribes_visible_code() -> None:
    plan = extraction_plan(1)
    assert '"screen_code"' in plan.system
    assert "even when both flags are false" in plan.system


def test_screen_context_from_code_only_frame() -> None:
    p = make_problem(is_coding_problem=False, problem_statement=None, screen_code=BUGGY_CODE)
    text = vision.screen_context_text(p)
    assert text is not None and BUGGY_CODE in text


def test_screen_context_from_coding_problem_includes_editor_code() -> None:
    p = make_problem(screen_code="def twoSum(self, nums, target):\n    return []")
    text = vision.screen_context_text(p) or ""
    assert "1. Two Sum" in text
    assert STATEMENT in text
    assert "return []" in text


def test_screen_context_from_screen_question() -> None:
    p = make_problem(
        is_coding_problem=False,
        is_screen_question=True,
        problem_statement=None,
        question="Why does this handler pay twice? Code: ...",
    )
    assert "pay twice" in (vision.screen_context_text(p) or "")


def test_nothing_readable_gives_no_screen_context() -> None:
    p = make_problem(is_coding_problem=False, problem_statement=None, confidence=0.9)
    assert vision.screen_context_text(p) is None


def test_screen_context_is_capped() -> None:
    p = make_problem(is_coding_problem=False, problem_statement=None, screen_code="x" * 50_000)
    assert len(vision.screen_context_text(p) or "") <= vision.SCREEN_CONTEXT_MAX_CHARS + 200


async def test_route_remembers_code_only_screen(monkeypatch: pytest.MonkeyPatch) -> None:
    h = RouteHarness(
        monkeypatch,
        make_problem(is_coding_problem=False, problem_statement=None, screen_code=BUGGY_CODE),
    )
    remembered: list[tuple[str, str]] = []

    async def fake_set(sid: str, text: str) -> None:
        remembered.append((sid, text))

    monkeypatch.setattr(vision, "set_screen_context", fake_set)
    res = await vision.extract(ExtractRequest(session_id="s", image_base64=b64(JPEG)))
    assert res["emitted"] is False  # nothing for the panel to open...
    assert remembered and remembered[0][0] == "s"  # ...but answers can now see it
    assert BUGGY_CODE in remembered[0][1]
    assert h.published == []


async def test_route_keeps_last_context_when_screen_is_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    RouteHarness(monkeypatch, make_problem(is_coding_problem=False, problem_statement=None))
    remembered: list[str] = []

    async def fake_set(_sid: str, text: str) -> None:
        remembered.append(text)

    monkeypatch.setattr(vision, "set_screen_context", fake_set)
    await vision.extract(ExtractRequest(session_id="s", image_base64=b64(JPEG)))
    assert remembered == []


def test_openai_strict_schema_matches_extracted_problem() -> None:
    # OpenAI structured output can only return fields in _StrictExtraction; a
    # field added to ExtractedProblem but not here is silently always null.
    assert set(coding_extraction._StrictExtraction.model_fields) == set(
        ExtractedProblem.model_fields
    )


def test_screen_context_uses_editor_code_held_in_signature() -> None:
    # Vision files the editor's contents under function_signature (and leaves
    # screen_code null to avoid repeating it). A buggy "fix this" starter must
    # still reach answers to spoken questions.
    buggy = "def fetch_page(orders, cursor, limit):\n    rows = [o for o in rows if o[1] <= c]"
    p = make_problem(function_signature=buggy, screen_code=None)
    assert buggy in (vision.screen_context_text(p) or "")


def test_screen_context_does_not_repeat_signature_inside_screen_code() -> None:
    sig = "class Solution:\n    def twoSum(self, nums, target):"
    p = make_problem(function_signature=sig, screen_code=sig + "\n        return []")
    assert (vision.screen_context_text(p) or "").count("def twoSum") == 1
