from app.prompts.answer_generation import AnswerContext, answer_system_prompt


def test_screen_context_is_omitted_from_legacy_prompt():
    prompt = answer_system_prompt(AnswerContext())
    assert "<visible_screen_context>" not in prompt


def test_screen_context_is_available_as_relevant_source_material():
    prompt = answer_system_prompt(
        AnswerContext(screen_context="Design a rate limiter for 10k requests/second.")
    )
    assert "<visible_screen_context>" in prompt
    assert "Design a rate limiter for 10k requests/second." in prompt
    assert "Use this context only when it is relevant" in prompt


def test_screen_rules_ask_for_direct_answers_to_on_screen_questions():
    from app.prompts.answer_generation import AnswerContext, answer_system_prompt

    prompt = answer_system_prompt(AnswerContext(screen_context="Q1. Which is O(1)? A) ... B) ..."))
    assert "multiple-choice" in prompt
    assert "reference material" in prompt


def test_grouped_screen_questions_are_answered_together_with_their_numbers():
    prompt = answer_system_prompt(AnswerContext())
    assert "Answer each of these" in prompt
    assert "question's own number" in prompt


def test_unsure_or_cut_off_answers_are_flagged():
    prompt = answer_system_prompt(AnswerContext())
    assert "⚠️ Check:" in prompt


def test_attached_screen_visuals_are_the_source_of_truth():
    prompt = answer_system_prompt(
        AnswerContext(screen_context="Chart page", screen_visuals="attached")
    )
    assert "source of truth" in prompt
    assert "visual not available" not in prompt


def test_unavailable_screen_visuals_ask_for_a_check():
    prompt = answer_system_prompt(
        AnswerContext(screen_context="Chart page", screen_visuals="unavailable")
    )
    assert "⚠️ Check: visual not available" in prompt
    assert "source of truth" not in prompt


def test_no_screen_visuals_line_by_default():
    prompt = answer_system_prompt(AnswerContext(screen_context="Chart page"))
    assert "source of truth" not in prompt
    assert "visual not available" not in prompt


def test_non_claude_answer_is_told_visuals_are_unavailable(monkeypatch):
    import asyncio

    from app.services import answer as answer_mod

    seen: list[str] = []

    async def fake_gemini(system: str, user: str):
        seen.append(system)
        yield "ok"

    monkeypatch.setattr(answer_mod, "_stream_gemini", fake_gemini)
    monkeypatch.setattr(answer_mod, "_provider_chain", lambda p: [p])

    async def run() -> list[str]:
        return [
            t
            async for t in answer_mod.stream_answer(
                "gemini",
                "What does the chart show?",
                AnswerContext(screen_context="Chart page"),
                images=[b"\x89PNG\r\n\x1a\nfake"],
            )
        ]

    assert asyncio.run(run()) == ["ok"]
    assert "⚠️ Check: visual not available" in seen[0]


def test_claude_gets_images_and_fallback_is_told_visuals_are_unavailable(monkeypatch):
    import asyncio

    from app.services import answer as answer_mod

    seen: dict[str, object] = {}
    images = [b"\x89PNG\r\n\x1a\nfake"]

    async def fake_anthropic(system: str, *_a: object, **kw: object):
        seen["claude_system"] = system
        seen["claude_kwargs"] = kw
        raise ValueError("claude hard failure")
        yield ""  # pragma: no cover - makes this an async generator

    async def fake_gemini(system: str, user: str):
        seen["gemini_system"] = system
        yield "ok"

    monkeypatch.setattr(answer_mod, "_stream_anthropic", fake_anthropic)
    monkeypatch.setattr(answer_mod, "_stream_gemini", fake_gemini)
    monkeypatch.setattr(answer_mod, "_provider_chain", lambda p: ["claude", "gemini"])

    async def run() -> list[str]:
        return [
            t
            async for t in answer_mod.stream_answer(
                "claude",
                "What does the chart show?",
                AnswerContext(screen_context="Chart page", screen_visuals="attached"),
                images=images,
            )
        ]

    assert asyncio.run(run()) == ["ok"]
    claude_system = str(seen["claude_system"])
    assert "source of truth" in claude_system
    assert "visual not available" not in claude_system
    assert "⚠️ Check: visual not available" in str(seen["gemini_system"])
    assert seen["claude_kwargs"]["images"] == images  # type: ignore[index]
