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
