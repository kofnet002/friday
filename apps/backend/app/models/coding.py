"""Pydantic models for coding-problem extraction.

Mirrors the JSON schema described in packages/prompts/coding-extraction.ts.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Platform = Literal["leetcode", "turing", "hackerrank", "coderpad", "other"]
Difficulty = Literal["easy", "medium", "hard"]
Completeness = Literal["complete", "partial", "uncertain"]


class CodingExample(BaseModel):
    input: str
    output: str
    explanation: str | None = None
    # Set by the extractor when it can't reconcile the transcribed example
    # with the statement / the example's own explanation (OCR misread).
    # Unreliable examples are excluded from self-verification — a corrupted
    # test makes a correct solution look wrong — and flagged to the solver.
    unreliable: bool = False


class ExtractedProblem(BaseModel):
    is_coding_problem: bool
    is_screen_question: bool = False
    question: str | None = None
    # Every distinct question on screen, in page order. A scanned assessment
    # page often holds several; `question` stays the first for older callers.
    questions: list[str] = Field(default_factory=list)
    visible_context: str | None = None
    # A passage / preamble / case study / dataset the questions refer to.
    # Kept across later screens so "Q3 — based on the passage above…" still
    # has the passage after the user scrolls past it.
    is_reference_material: bool = False
    screen_code: str | None = None
    completeness: Completeness = "uncertain"
    missing_sections: list[str] = Field(default_factory=list)
    platform: Platform | None = None
    title: str | None = None
    difficulty: Difficulty | None = None
    problem_statement: str | None = None
    examples: list[CodingExample] | None = None
    constraints: list[str] | None = None
    function_signature: str | None = None
    language_hint: str | None = None
    confidence: float = Field(ge=0.0, le=1.0)
    # 0-based indices of the screenshots holding a chart/diagram/figure the
    # questions depend on, so those frames can be kept for later answers.
    visual_frames: list[int] = Field(default_factory=list)
    # One short label per entry of visual_frames (same order) naming the
    # figures that screenshot shows; sent as its caption with answers.
    visual_frame_labels: list[str] = Field(default_factory=list)

    @field_validator("visual_frames", mode="before")
    @classmethod
    def _null_visual_frames(cls, value: object) -> object:
        return [] if value is None else value

    @field_validator("visual_frame_labels", mode="before")
    @classmethod
    def _coerce_visual_frame_labels(cls, value: object) -> list[str]:
        # A bad caption must never fail the whole read.
        if not isinstance(value, list):
            return []
        return [item if isinstance(item, str) else "" for item in value]

    @model_validator(mode="after")
    def _align_visual_frame_labels(self) -> ExtractedProblem:
        labels = [label.strip() for label in self.visual_frame_labels]
        count = len(self.visual_frames)
        self.visual_frame_labels = (labels + [""] * count)[:count]
        return self

    def valid_visual_frames(self, frame_count: int) -> list[int]:
        return sorted({i for i in self.visual_frames if 0 <= i < frame_count})

    def labelled_visual_frames(self, frame_count: int) -> list[tuple[int, str]]:
        """Valid frame indices in page order, each with its label ("" if none)."""
        labels: dict[int, str] = {}
        for i, label in zip(self.visual_frames, self.visual_frame_labels, strict=False):
            if 0 <= i < frame_count:
                labels.setdefault(i, label)
        return sorted(labels.items())

    @model_validator(mode="after")
    def _sync_questions(self) -> "ExtractedProblem":
        seen: set[str] = set()
        cleaned: list[str] = []
        for item in self.questions:
            text = item.strip() if isinstance(item, str) else ""
            key = " ".join(text.split()).lower()
            if text and key not in seen:
                seen.add(key)
                cleaned.append(text)
        if not cleaned and self.question and self.question.strip():
            cleaned = [self.question.strip()]
        self.questions = cleaned
        if cleaned and not (self.question and self.question.strip()):
            self.question = cleaned[0]
        return self

    @field_validator("platform", mode="before")
    @classmethod
    def _normalize_platform(cls, v: object) -> object:
        if isinstance(v, str):
            lowered = v.strip().lower()
            return lowered if lowered else None
        return v

    @field_validator("difficulty", mode="before")
    @classmethod
    def _normalize_difficulty(cls, v: object) -> object:
        if isinstance(v, str):
            lowered = v.strip().lower()
            return lowered if lowered else None
        return v
