"""Pure logic for remembered screen passages and their screenshot keys."""

from __future__ import annotations

import hashlib
import re
import time
import uuid
from dataclasses import dataclass, field, replace
from difflib import SequenceMatcher
from typing import Any

# Budget for remembered passages / preambles. Oldest are dropped first; the
# whole screen context is capped at 20k chars in redis_client.
MAX_REFERENCE_CHARS = 12_000
MAX_IMAGES_PER_REFERENCE = 4
MAX_IMAGES_PER_ANSWER = 8
# A re-read worded this similarly (difflib ratio on normalized text) is the
# same passage, not a new one.
SAME_PASSAGE_RATIO = 0.8
# Or: it shares a figure with a saved passage and starts the same way.
SAME_PASSAGE_HEAD_CHARS = 40
# A heading found near the start of the other read (a page title before
# it, say) counts when the wording is still this close.
SAME_PASSAGE_HEAD_WINDOW = 120
SAME_PASSAGE_PREFIXED_RATIO = 0.6
# Reads sharing this many screenshots show the same passage.
SAME_PASSAGE_SHARED_IMAGES = 2
REFERENCE_HEADER = (
    "Earlier reference material on screen (passages / preambles the questions may refer to):"
)

_DATA_URL_PREFIX = re.compile(r"^data:[^,]*;base64,", re.IGNORECASE)


@dataclass
class ScreenReference:
    id: str
    text: str
    image_keys: list[str] = field(default_factory=list)
    saved_at: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "text": self.text,
            "image_keys": list(self.image_keys),
            "saved_at": self.saved_at,
        }

    @classmethod
    def from_json(cls, obj: str | dict[str, Any]) -> ScreenReference:
        if isinstance(obj, str):
            return cls(
                id=hashlib.sha256(obj.encode()).hexdigest()[:32],
                text=obj,
                image_keys=[],
                saved_at=0.0,
            )
        keys = obj.get("image_keys")
        saved_at = obj.get("saved_at")
        return cls(
            id=str(obj.get("id") or uuid.uuid4().hex),
            text=str(obj.get("text") or ""),
            image_keys=[k for k in keys if isinstance(k, str)] if isinstance(keys, list) else [],
            saved_at=float(saved_at) if isinstance(saved_at, int | float) else 0.0,
        )


def _norm(text: str) -> str:
    return " ".join(text.split()).lower()


def strip_data_url(data_b64: str) -> str:
    return _DATA_URL_PREFIX.sub("", data_b64.strip())


def image_key(data_b64: str) -> str:
    """Stable key for a base64 image (any data-URL prefix is ignored)."""
    body = strip_data_url(data_b64)
    return hashlib.sha256(body.encode()).hexdigest()[:32]


def _alnum(norm_text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", norm_text)


def _head(norm_text: str) -> str:
    return _alnum(norm_text)[:SAME_PASSAGE_HEAD_CHARS]


def _head_near_start(a_norm: str, b_norm: str) -> bool:
    """One read's opening line appears near the start of the other's (e.g. the
    other also caught the page title above it)."""
    a, b = _alnum(a_norm), _alnum(b_norm)
    a_head, b_head = a[:SAME_PASSAGE_HEAD_CHARS], b[:SAME_PASSAGE_HEAD_CHARS]
    return bool(a_head and b_head) and (
        a_head in b[:SAME_PASSAGE_HEAD_WINDOW] or b_head in a[:SAME_PASSAGE_HEAD_WINDOW]
    )


def _same_passage(ref: ScreenReference, new_norm: str, new_keys: list[str]) -> bool:
    """A re-read of a saved passage: worded nearly the same, showing several
    of its screenshots, showing one of its figures under the same opening
    line, or opening the same way (after a title, say) in close wording."""
    ref_norm = _norm(ref.text)
    shared = set(ref.image_keys) & set(new_keys)
    if len(shared) >= SAME_PASSAGE_SHARED_IMAGES:
        return True
    matcher = SequenceMatcher(None, ref_norm, new_norm)
    if matcher.quick_ratio() >= SAME_PASSAGE_RATIO and matcher.ratio() >= SAME_PASSAGE_RATIO:
        return True
    head = _head(new_norm)
    if head and shared and _head(ref_norm) == head:
        return True
    return (
        _head_near_start(ref_norm, new_norm)
        and matcher.quick_ratio() >= SAME_PASSAGE_PREFIXED_RATIO
        and matcher.ratio() >= SAME_PASSAGE_PREFIXED_RATIO
    )


def merge_references(
    refs: list[ScreenReference], new_text: str, image_keys: list[str]
) -> list[ScreenReference]:
    """Add a newly seen passage, dropping exact repeats and shorter earlier
    reads of the same passage (a rescan that captured more of it). Images
    follow the passage: a rescan that found more figures upgrades the saved one."""
    new_text = new_text.strip()[:MAX_REFERENCE_CHARS]
    if not new_text:
        return list(refs)
    new_keys = list(image_keys)[:MAX_IMAGES_PER_REFERENCE]
    new_norm = _norm(new_text)
    for i, ref in enumerate(refs):
        if new_norm in _norm(ref.text):
            merged = list(refs)
            if len(ref.image_keys) < len(new_keys):
                merged[i] = replace(ref, image_keys=new_keys)
            return merged
    replaced = [ref for ref in refs if _norm(ref.text) in new_norm]
    merged = [ref for ref in refs if _norm(ref.text) not in new_norm]
    same = [ref for ref in merged if _same_passage(ref, new_norm, new_keys)]
    if same:
        # One passage: it keeps the oldest read's id and place (the viewer's
        # numbering and remove-by-id stay stable), the longest wording, and
        # the newest figures first.
        survivor = same[0]
        group = [*same, *replaced]
        text = max([new_text, *(ref.text for ref in group)], key=len)
        keys = list(dict.fromkeys([*new_keys, *(k for ref in group for k in ref.image_keys)]))
        merged = [
            replace(ref, text=text, image_keys=keys[:MAX_IMAGES_PER_REFERENCE])
            if ref is survivor
            else ref
            for ref in merged
            if ref is survivor or all(ref is not other for other in same)
        ]
        return _trim(merged)
    if not new_keys:
        # A longer read without figures keeps the figures of the reads it replaces.
        new_keys = list(dict.fromkeys(k for ref in replaced for k in ref.image_keys))[
            :MAX_IMAGES_PER_REFERENCE
        ]
    merged.append(
        ScreenReference(
            id=uuid.uuid4().hex, text=new_text, image_keys=new_keys, saved_at=time.time()
        )
    )
    return _trim(merged)


def _trim(merged: list[ScreenReference]) -> list[ScreenReference]:
    while len(merged) > 1 and sum(len(ref.text) for ref in merged) > MAX_REFERENCE_CHARS:
        merged.pop(0)
    return merged


def compose_screen_context(current: str, refs: list[ScreenReference]) -> str:
    """Current screen first (most relevant), then earlier reference material
    that isn't already visible on the current screen."""
    current_norm = _norm(current)
    earlier = [ref.text for ref in refs if _norm(ref.text) not in current_norm]
    if not earlier:
        return current
    block = REFERENCE_HEADER + "\n\n" + "\n\n---\n\n".join(earlier)
    return f"{current}\n\n{block}" if current else block


def reference_saved_event(refs: list[ScreenReference], saved_text: str) -> dict[str, Any]:
    """Tell the panel a passage was remembered, with a one-line preview."""
    preview = " ".join(saved_text.split())
    if len(preview) > 120:
        preview = preview[:119].rstrip() + "…"
    return {"type": "screen_reference_saved", "count": len(refs), "preview": preview}


def answer_image_keys(
    current: list[str], refs: list[ScreenReference], *, include_references: bool
) -> list[str]:
    """Images to attach to an answer: current screen first, then remembered
    passages newest-first, deduped and capped."""
    ordered = list(current)
    if include_references:
        for ref in reversed(refs):
            ordered.extend(ref.image_keys)
    seen: set[str] = set()
    out: list[str] = []
    for key in ordered:
        if key not in seen:
            seen.add(key)
            out.append(key)
    return out[:MAX_IMAGES_PER_ANSWER]
