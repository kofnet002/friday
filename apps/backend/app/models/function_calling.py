"""Pydantic models for function-calling assessments.

A function-calling question presents a natural-language task plus a catalog of
available tools (each with a JSON-Schema parameter spec). The answer is a single
`{tool, arguments}` object. These models are the API boundary; the verifier in
`services/tool_call_runner.py` works on plain dicts (like `code_runner`), so
routes hand it `model_dump()` output rather than the models themselves.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class ToolSpec(BaseModel):
    """One callable tool the model may select. `parameters` is a JSON-Schema
    object describing the arguments (OpenAI's `function.parameters` shape).
    `input_schema` is accepted as an alias for Anthropic-style catalogs — the
    verifier reads either."""

    name: str = Field(min_length=1)
    description: str | None = None
    parameters: dict[str, Any] | None = None
    input_schema: dict[str, Any] | None = None


class PredictedToolCall(BaseModel):
    """The model's answer: which tool, and the payload for it."""

    tool: str | None = None
    arguments: dict[str, Any] = Field(default_factory=dict)


class FunctionCallAssessment(BaseModel):
    """A single assessment question. `expected_*` is the optional answer key —
    present in practice/graded mode, absent in the live-copilot case where only
    the structural self-verify runs."""

    question: str = Field(min_length=1)
    tools: list[ToolSpec] = Field(min_length=1)
    extra_instructions: str | None = None
    expected_tool: str | None = None
    expected_arguments: dict[str, Any] | None = None


class ExtractedFunctionCall(BaseModel):
    """Result of detecting a function-calling assessment on-screen (vision).

    Mirrors `ExtractedProblem` for the coding path: `is_function_call` gates
    emission, `confidence` guards against a blurry/partial read, and `tools`
    carries whatever catalog was visible. When the tool catalog isn't on the
    same screen (some assessments show only the task), `tools` may be empty —
    the solver still runs but the structural self-verify skips."""

    is_function_call: bool
    title: str | None = None
    question: str | None = None
    tools: list[ToolSpec] | None = None
    confidence: float = Field(ge=0.0, le=1.0)

    @field_validator("question", "title", mode="before")
    @classmethod
    def _blank_to_none(cls, v: object) -> object:
        if isinstance(v, str):
            stripped = v.strip()
            return stripped if stripped else None
        return v
