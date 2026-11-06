import pytest

from app.models.params import (
    anthropic_options,
    gemini_thinking_config,
    is_bad_request,
    open_with_param_fallback,
    openai_options,
)


def test_anthropic_without_effort_turns_thinking_off_per_model() -> None:
    # Claude 5.x thinks by default; left on, thinking eats the whole answer
    # budget (stop_reason=max_tokens with little or no text). Each model
    # spells "off" differently (verified against the live API, Nov 2026).
    def thinking(model: str) -> object:
        return anthropic_options(effort=None, max_tokens=1500, model=model).get("thinking")

    assert thinking("claude-haiku-5-5") == {"type": "disabled"}
    assert thinking("claude-sonnet-5-5") == {"type": "between_tools"}
    assert thinking("claude-opus-4-8") == {"type": "disabled"}
    # Opus 5.x / Fable can't turn thinking off — send nothing, keep headroom.
    assert thinking("claude-opus-5-5") is None
    assert thinking("claude-fable-5-1") is None
    assert anthropic_options(effort=None, max_tokens=1500, model="claude-opus-5-5") == {
        "max_tokens": 1500
    }


def test_anthropic_effort_enables_adaptive_thinking_and_headroom() -> None:
    opts = anthropic_options(effort="high", max_tokens=1500, model="claude-opus-5-5")
    assert opts["output_config"] == {"effort": "high"}
    assert opts["thinking"] == {"type": "adaptive"}
    # Thinking tokens share max_tokens, so the cap must leave room for them.
    assert opts["max_tokens"] > 1500


def test_openai_classic_model_keeps_temperature_and_max_tokens() -> None:
    opts = openai_options("gpt-4o", effort="high", max_tokens=1500, temperature=0.4)
    assert opts == {"max_tokens": 1500, "temperature": 0.4}


def test_gpt5_without_effort_omits_temperature() -> None:
    # The API rejects any non-default temperature for gpt-5.x.
    opts = openai_options("gpt-5.5", effort=None, max_tokens=1500, temperature=0.4)
    assert opts == {"max_completion_tokens": 1500}


def test_openai_reasoning_model_with_effort_drops_temperature() -> None:
    opts = openai_options("o3", effort="max", max_tokens=1500, temperature=0.4)
    assert opts["reasoning_effort"] == "xhigh"
    assert "temperature" not in opts
    assert opts["max_completion_tokens"] > 1500


def test_gemini_default_thinking_matches_legacy_behaviour() -> None:
    assert gemini_thinking_config("gemini-2.5-flash", None).thinking_budget == 0
    assert gemini_thinking_config("gemini-2.5-pro", None).thinking_budget == -1


def test_gemini_2_effort_maps_to_budget() -> None:
    low = gemini_thinking_config("gemini-2.5-flash", "low").thinking_budget
    high = gemini_thinking_config("gemini-2.5-flash", "high").thinking_budget
    assert low is not None and high is not None and 0 < low < high
    assert gemini_thinking_config("gemini-2.5-pro", "max").thinking_budget == -1


def test_gemini_3_effort_maps_to_thinking_level() -> None:
    cfg = gemini_thinking_config("gemini-3-pro-preview", "high")
    assert cfg.thinking_level is not None
    assert cfg.thinking_level.value == "HIGH"
    assert cfg.thinking_budget is None


class _Http400(Exception):
    status_code = 400


class _Http500(Exception):
    status_code = 500


def test_is_bad_request_reads_status_code_or_code() -> None:
    assert is_bad_request(_Http400())
    assert not is_bad_request(_Http500())

    err = Exception()
    err.code = 400  # type: ignore[attr-defined]
    assert is_bad_request(err)


@pytest.mark.asyncio
async def test_open_with_param_fallback_retries_once_on_400() -> None:
    calls: list[dict[str, object]] = []

    async def open_fn(opts: dict[str, object]) -> str:
        calls.append(opts)
        if "reasoning_effort" in opts:
            raise _Http400("unsupported parameter")
        return "stream"

    result = await open_with_param_fallback(open_fn, {"reasoning_effort": "high"}, {}, label="test")
    assert result == "stream"
    assert calls == [{"reasoning_effort": "high"}, {}]


@pytest.mark.asyncio
async def test_open_with_param_fallback_reraises_other_errors() -> None:
    async def open_fn(opts: dict[str, object]) -> str:
        raise _Http500("overloaded")

    with pytest.raises(_Http500):
        await open_with_param_fallback(open_fn, {"a": 1}, {}, label="test")


@pytest.mark.asyncio
async def test_open_with_param_fallback_does_not_retry_identical_options() -> None:
    calls = 0

    async def open_fn(opts: dict[str, object]) -> str:
        nonlocal calls
        calls += 1
        raise _Http400("bad model")

    with pytest.raises(_Http400):
        await open_with_param_fallback(open_fn, {}, {}, label="test")
    assert calls == 1


def test_openai_o_series_without_effort_omits_temperature() -> None:
    opts = openai_options("o3-mini", effort=None, max_tokens=1500, temperature=0.4)
    assert opts == {"max_completion_tokens": 1500}
