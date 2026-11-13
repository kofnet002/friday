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
        ["A", {"id": "x", "text": "B", "image_keys": ["k"], "saved_at": 1}, 5,
         {"id": "y", "text": ""}]
    )
    first = await rc.get_screen_references("s1")
    assert [r.text for r in first] == ["A", "B"]
    assert first[1].image_keys == ["k"]
    assert [r.id for r in await rc.get_screen_references("s1")] == [r.id for r in first]
