import pytest

from app.services.question_detection import _looks_mid_thought


@pytest.mark.parametrize(
    "text",
    [
        # The exact failure mode from the screenshot:
        "from how you usually did things. Interviewers are curious to learn how flex",
        "Please describe a situation where you needed to adapt a",
        "So I saw on your resume that you worked on an ML platform and",
        "I'm curious about",
        "Walk me through",
        "",
    ],
)
def test_mid_thought_skips(text: str) -> None:
    assert _looks_mid_thought(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "What's your favorite programming language?",
        "Tell me about a time you disagreed with your manager.",
        "Walk me through what happens when I type google.com into a browser.",
        "How would you design a rate limiter!",
    ],
)
def test_complete_fires(text: str) -> None:
    assert _looks_mid_thought(text) is False
