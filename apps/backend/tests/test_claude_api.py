from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from app.services.claude_api import (
    _THINKING_HEADROOM,
    _request_kwargs,
    claude_transport,
    claude_usage_model,
    image_media_type,
)
from app.settings import settings


def _creds(monkeypatch: pytest.MonkeyPatch, *, key: str, token: str, mode: str) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", key)
    monkeypatch.setattr(settings, "claude_code_oauth_token", token)
    monkeypatch.setattr(settings, "claude_transport", mode)


@pytest.mark.parametrize(
    ("key", "token", "mode", "expected"),
    [
        # auto: API key wins when both exist, subscription otherwise.
        ("sk", "oat", "auto", "api"),
        ("", "oat", "auto", "cli"),
        ("sk", "", "auto", "api"),
        ("", "", "auto", None),
        # Pinned modes never cross over to the other credential.
        ("sk", "oat", "subscription", "cli"),
        ("sk", "", "subscription", None),
        ("", "oat", "api", None),
        ("sk", "oat", "api", "api"),
    ],
)
def test_claude_transport(
    monkeypatch: pytest.MonkeyPatch, key: str, token: str, mode: str, expected: str | None
) -> None:
    _creds(monkeypatch, key=key, token=token, mode=mode)
    assert claude_transport() == expected


def test_usage_model_label_follows_transport(monkeypatch: pytest.MonkeyPatch) -> None:
    _creds(monkeypatch, key="sk", token="oat", mode="auto")
    assert claude_usage_model("claude-opus-5-5") == "claude-opus-5-5"
    _creds(monkeypatch, key="sk", token="oat", mode="subscription")
    assert claude_usage_model("claude-opus-5-5") == "claude-code:claude-opus-5-5"


def test_request_kwargs_opus_5_5() -> None:
    kw = _request_kwargs(
        system="s", messages=[], model="claude-opus-5-5", max_tokens=256, effort="low"
    )
    assert kw["max_tokens"] == 256 + _THINKING_HEADROOM
    assert kw["output_config"] == {"effort": "low"}
    assert kw["fallbacks"] == "default"
    assert kw["betas"] == ["server-side-fallback-2026-07-01"]
    assert kw["system"] == "s"
    assert not {"temperature", "top_p", "top_k", "thinking"} & kw.keys()


def test_request_kwargs_older_models() -> None:
    # Opus 4.8: no default thinking → no headroom; takes effort; no fallbacks.
    kw = _request_kwargs(
        system="", messages=[], model="claude-opus-4-8", max_tokens=256, effort="low"
    )
    assert kw["max_tokens"] == 256
    assert kw["output_config"] == {"effort": "low"}
    assert "fallbacks" not in kw and kw["betas"] == []
    assert "system" not in kw
    # Haiku 4.5 rejects effort.
    kw = _request_kwargs(
        system="", messages=[], model="claude-haiku-4-5", max_tokens=128, effort="low"
    )
    assert "output_config" not in kw


@pytest.mark.parametrize(
    ("head", "mime"),
    [
        (b"\x89PNG\r\n\x1a\n....", "image/png"),
        (b"\xff\xd8\xff\xe0", "image/jpeg"),
        (b"GIF89a", "image/gif"),
        (b"RIFF\x00\x00\x00\x00WEBP", "image/webp"),
        (b"????", "image/jpeg"),
    ],
)
def test_image_media_type(head: bytes, mime: str) -> None:
    assert image_media_type(head) == mime


def test_request_kwargs_thinking_off() -> None:
    kw = _request_kwargs(
        system="",
        messages=[],
        model="claude-haiku-5-5",
        max_tokens=320,
        effort="low",
        thinking=False,
    )
    assert kw["thinking"] == {"type": "disabled"} and kw["max_tokens"] == 320
    # Opus 5.5 rejects disabled thinking — keep it on, with headroom.
    kw = _request_kwargs(
        system="",
        messages=[],
        model="claude-opus-5-5",
        max_tokens=320,
        effort="low",
        thinking=False,
    )
    assert "thinking" not in kw and kw["max_tokens"] == 320 + _THINKING_HEADROOM


async def test_live_answers_use_answer_model(monkeypatch: pytest.MonkeyPatch) -> None:
    """Live answers run on ANTHROPIC_ANSWER_MODEL, not ANTHROPIC_MODEL (which
    stays on coding solves)."""
    from app.services import answer as answer_mod

    seen: list[str] = []

    async def fake_stream(**kw: object) -> AsyncIterator[str]:
        seen.append(str(kw["model"]))
        yield "ok"

    _creds(monkeypatch, key="sk", token="", mode="auto")
    monkeypatch.setattr(settings, "anthropic_model", "claude-opus-5-5")
    monkeypatch.setattr(settings, "anthropic_answer_model", "claude-sonnet-5-5")
    monkeypatch.setattr(answer_mod, "stream_claude_api", fake_stream)
    out = [t async for t in answer_mod._stream_anthropic("sys", "q", "q", ())]
    assert out == ["ok"] and seen == ["claude-sonnet-5-5"]
    assert answer_mod.claude_answer_model() == "claude-sonnet-5-5"


def test_content_captions_each_image_in_order() -> None:
    from app.services.claude_api import _content

    images = [(b"one", "image/png"), (b"two", "image/jpeg")]
    blocks = _content("Question?", images, captions=["Figure 1 (bar chart)", ""])
    assert isinstance(blocks, list)
    assert [b["type"] for b in blocks] == ["text", "image", "text", "image", "text"]
    assert blocks[0]["text"] == "Screenshot 1 of 2: Figure 1 (bar chart)"
    assert blocks[2]["text"] == "Screenshot 2 of 2: unlabelled"
    assert blocks[-1]["text"] == "Question?"
    # No captions: images then text, as before.
    plain = _content("Q", images)
    assert isinstance(plain, list)
    assert [b["type"] for b in plain] == ["image", "image", "text"]


async def test_answer_images_reach_the_api_with_their_labels(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import answer as answer_mod

    seen: dict[str, object] = {}

    async def fake_stream(**kw: object) -> AsyncIterator[str]:
        seen.update(kw)
        yield "ok"

    _creds(monkeypatch, key="sk", token="", mode="auto")
    monkeypatch.setattr(answer_mod, "stream_claude_api", fake_stream)
    out = [
        t
        async for t in answer_mod._stream_anthropic(
            "sys", "q", "q", (), images=[b"\x89PNG\r\n\x1a\nx"], image_labels=["Figure 2"]
        )
    ]
    assert out == ["ok"]
    assert seen["image_captions"] == ["Figure 2"]


async def test_unlabelled_images_are_sent_without_captions(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import answer as answer_mod

    seen: dict[str, object] = {}

    async def fake_stream(**kw: object) -> AsyncIterator[str]:
        seen.update(kw)
        yield "ok"

    _creds(monkeypatch, key="sk", token="", mode="auto")
    monkeypatch.setattr(answer_mod, "stream_claude_api", fake_stream)
    png = b"\x89PNG\r\n\x1a\nx"
    for labels in (None, ["", " "]):
        seen.clear()
        _ = [
            t
            async for t in answer_mod._stream_anthropic(
                "sys", "q", "q", (), images=[png, png], image_labels=labels
            )
        ]
        assert seen["image_captions"] is None


async def test_unlabelled_images_on_the_cli_get_no_file_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import answer as answer_mod
    from app.services import claude_cli

    seen: dict[str, object] = {}

    async def fake_cli(**kw: object) -> str:
        seen.update(kw)
        return "ok"

    _creds(monkeypatch, key="", token="oat", mode="auto")
    monkeypatch.setattr(claude_cli, "run_claude_cli_with_images", fake_cli)
    png = b"\x89PNG\r\n\x1a\nx"
    out = [
        t
        async for t in answer_mod._stream_anthropic(
            "sys", "q", "q", (), images=[png], image_labels=[""]
        )
    ]
    assert out == ["ok"] and seen["labels"] is None
    seen.clear()
    _ = [
        t
        async for t in answer_mod._stream_anthropic(
            "sys", "q", "q", (), images=[png, png], image_labels=["Figure 1", ""]
        )
    ]
    assert seen["labels"] == ["Figure 1", ""]


async def test_answer_effort_reaches_the_api_and_defaults_to_the_answer_effort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.prompts.answer_generation import AnswerContext
    from app.services import answer as answer_mod

    efforts: list[object] = []

    async def fake_stream(**kw: object) -> AsyncIterator[str]:
        efforts.append(kw["effort"])
        yield "ok"

    _creds(monkeypatch, key="sk", token="", mode="auto")
    monkeypatch.setattr(settings, "anthropic_effort", "low")
    monkeypatch.setattr(answer_mod, "stream_claude_api", fake_stream)
    monkeypatch.setattr(answer_mod, "_provider_chain", lambda _p: ["claude"])
    for effort in ("medium", None):
        _ = [
            t
            async for t in answer_mod.stream_answer(
                "claude", "Q1?", AnswerContext(screen_context="page"), effort=effort
            )
        ]
    assert efforts == ["medium", "low"]


async def test_screen_effort_reaches_the_cli_only_when_given(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import answer as answer_mod
    from app.services import claude_cli

    seen: list[object] = []

    async def fake_text(**kw: object) -> AsyncIterator[str]:
        seen.append(kw.get("effort"))
        yield "ok"

    async def fake_images(**kw: object) -> str:
        seen.append(kw.get("effort"))
        return "ok"

    _creds(monkeypatch, key="", token="oat", mode="auto")
    monkeypatch.setattr(claude_cli, "stream_claude_cli_text", fake_text)
    monkeypatch.setattr(claude_cli, "run_claude_cli_with_images", fake_images)
    png = b"\x89PNG\r\n\x1a\nx"
    _ = [t async for t in answer_mod._stream_anthropic("s", "q", "q", (), effort="medium")]
    _ = [
        t
        async for t in answer_mod._stream_anthropic(
            "s", "q", "q", (), images=[png], effort="medium"
        )
    ]
    _ = [t async for t in answer_mod._stream_anthropic("s", "q", "q", ())]
    assert seen == ["medium", "medium", None]
