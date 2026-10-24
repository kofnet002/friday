from __future__ import annotations

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
