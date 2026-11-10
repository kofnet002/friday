"""Pydantic models for coding-problem extraction.

Mirrors the JSON schema described in packages/prompts/coding-extraction.ts.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

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
