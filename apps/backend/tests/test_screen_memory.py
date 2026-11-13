import pytest

from app import redis_client as rc
from app.services.screen_memory import (
    ScreenReference,
    answer_image_keys,
    image_key,
    merge_references,
)
from tests.fake_redis import install_fake_redis


def test_legacy_string_loads_as_reference_without_images():
    ref = ScreenReference.from_json("Passage A")
    assert ref.text == "Passage A" and ref.image_keys == [] and ref.id


def test_json_round_trip():
    ref = ScreenReference("1", "t", ["a"], 2.0)
    assert ScreenReference.from_json(ref.to_json()) == ref


def test_rescan_that_adds_a_figure_attaches_images_to_saved_passage():
    refs = merge_references([], "Figure 1 sales", [])
    refs = merge_references(refs, "Figure 1 sales", ["k1"])
    assert len(refs) == 1 and refs[0].image_keys == ["k1"]


def test_longer_read_replaces_shorter_and_takes_its_images():
    refs = merge_references([], "Case study: the team", ["old"])
    refs = merge_references(refs, "Case study: the team migrated.", ["new"])
    assert [r.image_keys for r in refs] == [["new"]]


def test_reference_images_capped_at_four():
    refs = merge_references([], "P", ["a", "b", "c", "d", "e"])
    assert refs[0].image_keys == ["a", "b", "c", "d"]


def test_answer_images_current_first_then_newest_refs_capped_at_eight():
    refs = [ScreenReference("1", "x", ["r1", "r2"], 1.0), ScreenReference("2", "y", ["r3"], 2.0)]
    keys = answer_image_keys(["c1", "r3"], refs, include_references=True)
    assert keys == ["c1", "r3", "r1", "r2"]
    assert answer_image_keys(["c1"], refs, include_references=False) == ["c1"]
    many = [ScreenReference(str(i), str(i), [f"k{i}a", f"k{i}b"], float(i)) for i in range(6)]
    assert len(answer_image_keys([], many, include_references=True)) == 8


def test_image_key_ignores_data_url_prefix():
    assert image_key("data:image/png;base64,AAAA") == image_key("AAAA")
    assert len(image_key("AAAA")) == 32


@pytest.mark.asyncio
async def test_prune_keeps_images_still_referenced_and_clear_removes_all(monkeypatch):
    install_fake_redis(monkeypatch)
    sid = "s1"
    [k] = await rc.put_screen_images(sid, ["AAAA"])
    await rc.set_current_screen_images(sid, [k])
    await rc.set_screen_references(sid, [ScreenReference("1", "t", [k], 1.0)])

    await rc.set_screen_references(sid, [])
    await rc.prune_screen_images(sid, [k])
    assert await rc.get_screen_image(sid, k) is not None  # still current

    await rc.set_current_screen_images(sid, [])
    assert await rc.get_current_screen_images(sid) == []
    await rc.prune_screen_images(sid, [k])
    assert await rc.get_screen_image(sid, k) is None


@pytest.mark.asyncio
async def test_clear_screen_state_removes_images(monkeypatch):
    fake = install_fake_redis(monkeypatch)
    [k] = await rc.put_screen_images("s1", ["AAAA"])
    await rc.set_current_screen_images("s1", [k])
    await rc.put_screen_images("other", ["BBBB"])
    await rc.clear_screen_state("s1")
    assert [key for key in fake.store if key.startswith("session:s1:")] == []
    assert len(fake.store) == 1


def test_legacy_string_id_is_stable():
    assert ScreenReference.from_json("Passage A").id == ScreenReference.from_json("Passage A").id


def test_longer_read_without_images_keeps_replaced_images():
    refs = merge_references([], "Case study: the team", ["a", "b"])
    refs = merge_references(refs, "Case study: the team migrated.", [])
    assert [r.image_keys for r in refs] == [["a", "b"]]


def test_contained_rescan_with_fewer_or_equal_images_changes_nothing():
    refs = merge_references([], "Figure 1 sales", ["k1", "k2"])
    assert merge_references(refs, "Figure 1", ["k3"]) == refs
    assert merge_references(refs, "Figure 1 sales", ["k1", "k2"]) == refs


@pytest.mark.asyncio
async def test_legacy_references_load_from_redis(monkeypatch):
    import json

    fake = install_fake_redis(monkeypatch)
    fake.store["session:s1:screen_references"] = json.dumps(
        [
            "A",
            {"id": "x", "text": "B", "image_keys": ["k"], "saved_at": 1},
            5,
            {"id": "y", "text": ""},
        ]
    )
    first = await rc.get_screen_references("s1")
    assert [r.text for r in first] == ["A", "B"]
    assert first[1].image_keys == ["k"]
    assert [r.id for r in await rc.get_screen_references("s1")] == [r.id for r in first]


# Task 9 shapes: re-reads of one page come back worded a little differently.
PREAMBLE_A = (
    "Read the passage below and answer questions 1 to 7. The figures show quarterly "
    "sales by channel for Northwind Traders in 2025, with online growing fastest."
)
PREAMBLE_B = (
    "Read the passage below and answer Questions 1-7. The figures show the quarterly "
    "sales by channel for Northwind Traders during 2025, with online growing fastest."
)


def test_reread_worded_differently_is_the_same_passage():
    from difflib import SequenceMatcher

    from app.services.screen_memory import _norm

    assert SequenceMatcher(None, _norm(PREAMBLE_A), _norm(PREAMBLE_B)).ratio() >= 0.8
    refs = merge_references([], PREAMBLE_A, ["k1"])
    refs = merge_references(refs, PREAMBLE_B, ["k2"])
    assert len(refs) == 1
    assert refs[0].text == max(PREAMBLE_A, PREAMBLE_B, key=len)
    assert refs[0].image_keys == ["k2", "k1"]


def test_same_heading_and_shared_figures_merge_into_one_passage():
    keys = ["a", "b", "c", "d"]
    heading = "Section 2: Regional performance of all retail stores"
    first = f"{heading}. Figure 2 shows sales by region."
    second = (
        f"{heading}\n\nThe east region overtook the west in Q3, "
        "while Figure 3 traces the approval flow for new store openings."
    )
    refs = merge_references([], first, keys)
    refs = merge_references(refs, second, list(reversed(keys)))
    assert len(refs) == 1
    assert refs[0].text == second.strip()
    assert sorted(refs[0].image_keys) == keys


def test_different_passages_stay_separate():
    refs = merge_references([], "Section 1: Staffing. Hiring rose 4% in Q2.", ["a"])
    refs = merge_references(refs, "Section 4: Logistics. Deliveries fell after the storm.", ["b"])
    assert len(refs) == 2
    # Shared figures alone don't make two passages one.
    refs = merge_references(refs, "Appendix: Glossary of retail terms used above.", ["a"])
    assert len(refs) == 3


def test_merged_passage_keeps_the_older_id_and_position():
    other = "Section 9: Unrelated notes about the warehouse audit."
    refs = merge_references([], PREAMBLE_A, ["k1"])
    refs = merge_references(refs, other, [])
    first_id = refs[0].id
    refs = merge_references(refs, PREAMBLE_B, ["k2"])
    assert refs[0].id == first_id
    assert refs[1].text == other
    assert len(refs) == 2


def test_several_matching_reads_collapse_into_one():
    refs = [
        ScreenReference("old", PREAMBLE_A, ["a", "b"], 1.0),
        ScreenReference("mid", "Section 9: Unrelated notes.", [], 2.0),
        ScreenReference("dup", PREAMBLE_B, ["c", "d"], 3.0),
    ]
    third = PREAMBLE_A.replace("fastest", "the fastest of all")
    refs = merge_references(refs, third, ["e"])
    assert [r.id for r in refs] == ["old", "mid"]
    assert refs[0].text == third
    assert refs[0].image_keys == ["e", "a", "b", "c"]


@pytest.mark.asyncio
async def test_labels_are_stored_pruned_and_cleared_with_their_images(monkeypatch):
    fake = install_fake_redis(monkeypatch)
    sid = "s1"
    k1, k2 = await rc.put_screen_images(sid, ["AAAA", "BBBB"], ["Figure 1 (bar chart)", ""])
    assert await rc.get_screen_image_label(sid, k1) == "Figure 1 (bar chart)"
    assert await rc.get_screen_image_label(sid, k2) is None
    # A later read of the same image without a label keeps the earlier one.
    await rc.put_screen_images(sid, ["AAAA"])
    assert await rc.get_screen_image_label(sid, k1) == "Figure 1 (bar chart)"

    await rc.prune_screen_images(sid, [k1])
    assert await rc.get_screen_image(sid, k1) is None
    assert await rc.get_screen_image_label(sid, k1) is None

    [k3] = await rc.put_screen_images(sid, ["CCCC"], ["Figure 3"])
    await rc.clear_screen_state(sid)
    assert await rc.get_screen_image_label(sid, k3) is None
    assert [key for key in fake.store if key.startswith("session:s1:")] == []


def _smoke11_reads() -> list[dict[str, object]]:
    import json
    from pathlib import Path

    path = Path(__file__).parent / "data" / "smoke11_preamble_reads.json"
    return json.loads(path.read_text(encoding="utf-8"))


def test_title_prefixed_reread_from_the_smoke_merges():
    from difflib import SequenceMatcher

    from app.services.screen_memory import _norm

    # The Task 11 smoke pair: one read starts with the page title, the other
    # straight at the preamble (ratio 0.727, all four screenshots shared).
    first, second = _smoke11_reads()
    ratio = SequenceMatcher(None, _norm(str(first["text"])), _norm(str(second["text"]))).ratio()
    assert 0.6 <= ratio < 0.8
    refs = merge_references([], str(first["text"]), list(first["image_keys"]))  # type: ignore[arg-type]
    first_id = refs[0].id
    refs = merge_references(refs, str(second["text"]), list(second["image_keys"]))  # type: ignore[arg-type]
    assert len(refs) == 1
    assert refs[0].id == first_id
    assert refs[0].text == str(first["text"]).strip()


def _ratio(a: str, b: str) -> float:
    from difflib import SequenceMatcher

    from app.services.screen_memory import _norm

    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def test_unrelated_texts_sharing_two_screenshots_stay_separate():
    first = "Section 2: Regional sales. East grew fastest."
    second = "Appendix B: Glossary of staffing terms used throughout this report."
    assert _ratio(first, second) < 0.5
    refs = merge_references([], first, ["a", "b", "x"])
    refs = merge_references(refs, second, ["b", "a"])
    assert len(refs) == 2


def test_related_reads_sharing_two_screenshots_merge():
    first = "Figure 2 shows quarterly sales by channel; online overtook in-store in early 2024."
    second = "Quarterly sales by channel (Figure 2): online sales overtook in-store sales in 2024."
    assert 0.5 <= _ratio(first, second) < 0.8
    refs = merge_references([], first, ["a", "b", "x"])
    refs = merge_references(refs, second, ["b", "a"])
    assert len(refs) == 1


def test_heading_prefix_within_the_opening_merges_when_wording_is_close():
    import re

    from app.services.screen_memory import _norm

    body = (
        "Preamble: Questions 1 to 7 refer to the figures in this section. Read each "
        "figure carefully; not every value is printed and the text does not repeat them."
    )
    titled = "Operations Analyst Assessment, Section C\n" + body.replace("Preamble: ", "Preamble. ")
    reread = body + " Lakeview Retail runs one distribution centre."
    # Only rule (b) applies: no shared screenshots, wording below 0.8, and the
    # re-read's opening sits inside the titled read's first 120 characters.
    assert 0.6 <= _ratio(titled, reread) < 0.8
    head = re.sub(r"[^a-z0-9]", "", _norm(reread))[:40]
    assert head in re.sub(r"[^a-z0-9]", "", _norm(titled))[:120]
    refs = merge_references([], titled, ["a"])
    refs = merge_references(refs, reread, ["z"])
    assert len(refs) == 1


def test_shared_screenshot_and_heading_prefix_but_different_text_stay_separate():
    import re
    from difflib import SequenceMatcher

    from app.services.screen_memory import _norm

    first = (
        "Figure 2: Sales by channel, quarterly, 2023 to 2024. Online overtook in-store in Q1 2024."
    )
    second = (
        "Questions 5 to 7. Figure 2: Sales by channel, quarterly, 2023 to 2024 is needed for "
        "question 7: add the North region's March and June orders, subtract Online Q4 sales, "
        "and pick the result from A to D. Question 6 uses Table 2 and its uptime targets."
    )
    head = re.sub(r"[^a-z0-9]", "", _norm(first))[:40]
    assert head in re.sub(r"[^a-z0-9]", "", _norm(second))[:120]
    assert SequenceMatcher(None, _norm(first), _norm(second)).ratio() < 0.6
    refs = merge_references([], first, ["shared"])
    refs = merge_references(refs, second, ["shared", "other"])
    assert len(refs) == 2


def test_same_shape_tables_with_different_numbers_stay_separate():
    first = "| Region | Sales |\n|---|---|\n| North | 120 |\n| South | 95 |\n| East | 80 |"
    second = "| Region | Sales |\n|---|---|\n| North | 140 |\n| South | 75 |\n| East | 60 |"
    assert _ratio(first, second) >= 0.8
    refs = merge_references([], first, ["a", "b"])
    refs = merge_references(refs, second, ["a", "b"])
    assert [r.text for r in refs] == [first, second]


def test_preambles_for_different_question_ranges_stay_separate():
    first = (
        "Operations Analyst Assessment, Section C\nPreamble: Questions 1–4 refer to Figure 1. "
        "Read each figure carefully: not every value is printed on it."
    )
    second = (
        "Operations Analyst Assessment, Section C\nPreamble: Questions 5–7 refer to Figure 4. "
        "Read each figure carefully: not every value is printed on it."
    )
    assert _ratio(first, second) >= 0.8
    refs = merge_references([], first, ["a", "b"])
    refs = merge_references(refs, second, ["a", "b"])
    assert len(refs) == 2


def test_question_ranges_alone_keep_passages_apart():
    from app.services.screen_memory import _norm, _same_passage

    # Same numbers either way, so only the differing ranges tell them apart.
    first = "Questions 1 to 4 and 5: read the memo about 4 stores and 1 warehouse."
    second = "Questions 1-5 and 4: read the memo about 4 stores and 1 warehouse."
    ref = ScreenReference("1", first, ["a", "b"], 1.0)
    assert not _same_passage(ref, _norm(second), ["a", "b"])
    same_range = ScreenReference("2", second.replace("1-5", "1 to 5"), [], 1.0)
    assert _same_passage(same_range, _norm(second), [])


def test_contained_reread_with_more_figures_adds_them_to_the_saved_passage():
    refs = merge_references([], "Figure 1 sales by region, Figure 2 costs", ["a", "b"])
    refs = merge_references(refs, "Figure 1 sales by region", ["c", "a", "d"])
    assert len(refs) == 1
    # New first, the saved ones kept after them, deduped and capped at four.
    assert refs[0].image_keys == ["c", "a", "d", "b"]
    refs = merge_references([], "Figure 1 sales by region, Figure 2 costs", ["a", "b"])
    refs = merge_references(refs, "Figure 2 costs", ["c", "d", "e"])
    assert refs[0].image_keys == ["c", "d", "e", "a"]
