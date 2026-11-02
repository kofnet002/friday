"""Cross-provider fallback: an empty completion must never look like success."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from app.services._fallback import EmptyStreamError, stream_with_fallback


async def _collect(it: AsyncIterator[str]) -> list[str]:
    return [token async for token in it]


def _factory(outputs: dict[str, list[str]]):
    async def gen(provider: str) -> AsyncIterator[str]:
        for token in outputs[provider]:
            yield token

    return gen


async def test_empty_primary_falls_back_to_next_provider() -> None:
    switches: list[tuple[str, str]] = []

    async def on_fallback(prev: str, nxt: str, _reason: str) -> None:
        switches.append((prev, nxt))

    tokens = await _collect(
        stream_with_fallback(
            providers=["prov-empty", "prov-ok"],
            factory=_factory({"prov-empty": [], "prov-ok": ["hello", " world"]}),
            on_fallback=on_fallback,
        )
    )

    assert tokens == ["hello", " world"]
    assert switches == [("prov-empty", "prov-ok")]


async def test_whitespace_only_stream_counts_as_empty() -> None:
    tokens = await _collect(
        stream_with_fallback(
            providers=["prov-blank", "prov-ok"],
            factory=_factory({"prov-blank": ["  ", "\n"], "prov-ok": ["answer"]}),
        )
    )

    assert tokens == ["answer"]


async def test_empty_stream_on_last_provider_raises() -> None:
    with pytest.raises(EmptyStreamError):
        await _collect(
            stream_with_fallback(
                providers=["prov-empty"],
                factory=_factory({"prov-empty": []}),
            )
        )


async def test_non_empty_stream_passes_through_unchanged() -> None:
    tokens = await _collect(
        stream_with_fallback(
            providers=["prov-ok", "prov-unused"],
            factory=_factory({"prov-ok": ["a", "b"], "prov-unused": ["x"]}),
        )
    )

    assert tokens == ["a", "b"]
