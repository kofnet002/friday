"""Pure logic for remembered screen passages and their screenshot keys."""

from __future__ import annotations

import hashlib
import re
import time
import uuid
from dataclasses import dataclass, field, replace
from typing import Any

# Budget for remembered passages / preambles. Oldest are dropped first; the
# whole screen context is capped at 20k chars in redis_client.
MAX_REFERENCE_CHARS = 12_000
MAX_IMAGES_PER_REFERENCE = 4
MAX_IMAGES_PER_ANSWER = 8
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


def image_key(data_b64: str) -> str:
    """Stable key for a base64 image (any data-URL prefix is ignored)."""
    body = _DATA_URL_PREFIX.sub("", data_b64.strip())
    return hashlib.sha256(body.encode()).hexdigest()[:32]


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
    if not new_keys:
        # A longer read without figures keeps the figures of the reads it replaces.
        new_keys = list(
            dict.fromkeys(k for ref in replaced for k in ref.image_keys)
        )[:MAX_IMAGES_PER_REFERENCE]
    merged.append(
        ScreenReference(
            id=uuid.uuid4().hex, text=new_text, image_keys=new_keys, saved_at=time.time()
        )
    )
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
