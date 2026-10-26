"""Self-verification for function-calling assessment answers.

The coding sibling (`code_runner.py`) executes a generated solution against
the problem's examples. Function-calling assessments have no runnable code —
the answer IS a structured `{tool, arguments}` object — so "verify" here means
checking that object two ways:

- `check_tool_call` — STRUCTURAL self-verify against the tool catalog. Does the
  chosen tool exist? Are all its required parameters present? Any parameter the
  schema doesn't declare? Does each argument's type match the declared JSON
  type / enum? This runs even when no answer key is available (the live-copilot
  case) and catches the model hallucinating a tool or dropping a required field
  BEFORE the candidate submits their single, unre-doable attempt.

- `grade_tool_call` — GRADED comparison against a known-correct answer (the
  practice / answer-key case). Exact tool-name match plus a normalized deep
  equality of the payload (key order ignored, `1` == `1.0`). Each assessment
  question has exactly one correct tool+payload combination, so this is a
  straight pass/fail.

Both operate on plain dicts (like `run_solution_tests`), so the caller can pass
raw provider output without reconstructing Pydantic models. No sandbox, no
subprocess — this is pure comparison logic.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

# ─── result types ────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CheckResult:
    """One structural check. `kind` groups them for the UI:
    `unknown-tool` / `missing-required` / `unexpected-param` / `type-mismatch`
    / `enum` — `field` names the offending parameter when applicable."""

    ok: bool
    kind: str
    detail: str
    field: str | None = None


@dataclass(frozen=True)
class ToolCallCheck:
    """Outcome of structurally validating a predicted call against the catalog.

    `ran` is False when the check was skipped entirely (no tool name in the
    prediction, empty catalog) — mirroring `TestRunResult.ran`. `ok` is the
    aggregate: ran with zero failing checks."""

    ran: bool
    checks: list[CheckResult] = field(default_factory=list)
    skip_reason: str | None = None

    @property
    def failures(self) -> list[CheckResult]:
        return [c for c in self.checks if not c.ok]

    @property
    def ok(self) -> bool:
        return self.ran and not self.failures


@dataclass(frozen=True)
class GradeResult:
    """Outcome of grading a predicted call against the expected answer key."""

    tool_match: bool
    payload_match: bool
    expected_tool: str
    predicted_tool: str | None
    # Human-readable diff of the first payload disagreement, for the panel.
    payload_diff: str | None = None

    @property
    def correct(self) -> bool:
        return self.tool_match and self.payload_match


# ─── JSON-schema type conformance ────────────────────────────────────────────
# A minimal, dependency-free subset of JSON Schema — enough for the parameter
# shapes function-calling catalogs actually use (OpenAI/Anthropic tool specs).
# Deliberately NOT a full validator: we check the declared `type`, `enum`, and
# recurse one level into `array.items` / `object.properties`; unknown keywords
# (`format`, `minimum`, `pattern`, …) are ignored rather than enforced.


def _type_ok(value: Any, json_type: str) -> bool:
    if json_type == "string":
        return isinstance(value, str)
    if json_type == "integer":
        # bool is a subclass of int in Python — exclude it, a boolean is not an
        # integer argument.
        return isinstance(value, int) and not isinstance(value, bool)
    if json_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if json_type == "boolean":
        return isinstance(value, bool)
    if json_type == "array":
        return isinstance(value, list)
    if json_type == "object":
        return isinstance(value, dict)
    if json_type == "null":
        return value is None
    # Unknown/custom type name — don't fail the candidate over a schema we
    # don't model; treat it as satisfied.
    return True


def _value_matches_schema(value: Any, schema: dict[str, Any]) -> str | None:
    """Return None when `value` conforms to `schema`, else a short reason.
    Checks `type` (scalar or list-of-types union) and `enum`, and recurses
    into array items and object properties."""
    declared = schema.get("type")
    if declared is not None:
        types = declared if isinstance(declared, list) else [declared]
        if not any(_type_ok(value, t) for t in types):
            got = "null" if value is None else type(value).__name__
            return f"expected {'|'.join(map(str, types))}, got {got}"

    enum = schema.get("enum")
    if isinstance(enum, list) and value not in enum:
        return f"{value!r} is not one of {enum!r}"

    # Recurse: every array element against `items`, each known property against
    # its own schema. Unknown properties are handled by the caller's
    # additionalProperties check, not here.
    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for i, elem in enumerate(value):
            reason = _value_matches_schema(elem, schema["items"])
            if reason is not None:
                return f"item {i}: {reason}"

    if isinstance(value, dict) and isinstance(schema.get("properties"), dict):
        for key, sub in schema["properties"].items():
            if key in value and isinstance(sub, dict):
                reason = _value_matches_schema(value[key], sub)
                if reason is not None:
                    return f"{key}: {reason}"

    return None


def _find_tool(tools: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    return next((t for t in tools if t.get("name") == name), None)


def _parameters_schema(tool: dict[str, Any]) -> dict[str, Any]:
    """Tool specs put the argument schema under `parameters` (OpenAI) or
    `input_schema` (Anthropic). Accept either; default to an empty object
    schema so a parameter-less tool validates cleanly."""
    schema = tool.get("parameters")
    if not isinstance(schema, dict):
        schema = tool.get("input_schema")
    return schema if isinstance(schema, dict) else {}


# ─── structural self-verify ──────────────────────────────────────────────────


def check_tool_call(
    *,
    tool: str | None,
    arguments: dict[str, Any] | None,
    tools: list[dict[str, Any]],
) -> ToolCallCheck:
    """Validate a predicted tool call against the available tool catalog.

    Returns ran=False (with a skip_reason) when there's nothing to check —
    no predicted tool name, or an empty catalog. Otherwise ran=True with one
    CheckResult per rule evaluated; `.ok` is True only when none failed.
    """
    if not tools:
        return ToolCallCheck(ran=False, skip_reason="no tool catalog to check against")
    if not tool:
        return ToolCallCheck(ran=False, skip_reason="prediction named no tool")

    args = arguments or {}
    checks: list[CheckResult] = []

    spec = _find_tool(tools, tool)
    if spec is None:
        names = ", ".join(t.get("name", "?") for t in tools)
        checks.append(
            CheckResult(
                ok=False,
                kind="unknown-tool",
                detail=f"tool {tool!r} is not in the catalog (available: {names})",
            )
        )
        # No spec to validate arguments against — return the single failure.
        return ToolCallCheck(ran=True, checks=checks)

    checks.append(CheckResult(ok=True, kind="tool-exists", detail=f"tool {tool!r} exists"))

    schema = _parameters_schema(spec)
    _props = schema.get("properties")
    properties: dict[str, Any] = _props if isinstance(_props, dict) else {}
    _req = schema.get("required")
    required: list[Any] = _req if isinstance(_req, list) else []
    # additionalProperties defaults to True in JSON Schema, but function-call
    # catalogs almost always mean "these params and no others". We only flag
    # extras when the schema explicitly forbids them.
    forbid_extra = schema.get("additionalProperties") is False

    for name in required:
        present = name in args
        checks.append(
            CheckResult(
                ok=present,
                kind="missing-required",
                detail=(
                    f"required parameter {name!r} present"
                    if present
                    else f"required parameter {name!r} is missing"
                ),
                field=str(name),
            )
        )

    for name, value in args.items():
        if name in properties:
            sub = properties[name]
            reason = _value_matches_schema(value, sub) if isinstance(sub, dict) else None
            if reason is not None:
                checks.append(
                    CheckResult(
                        ok=False,
                        kind="type-mismatch",
                        detail=f"parameter {name!r}: {reason}",
                        field=name,
                    )
                )
        elif forbid_extra:
            checks.append(
                CheckResult(
                    ok=False,
                    kind="unexpected-param",
                    detail=f"parameter {name!r} is not declared by {tool!r}",
                    field=name,
                )
            )

    return ToolCallCheck(ran=True, checks=checks)


# ─── graded comparison against an answer key ─────────────────────────────────


def _normalize(value: Any) -> Any:
    """Canonicalize a JSON value for equality: dict keys sorted, numbers
    unified so `1 == 1.0` and `True`/`False` stay distinct from `1`/`0`."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        return {k: _normalize(v) for k, v in sorted(value.items())}
    if isinstance(value, list):
        return [_normalize(v) for v in value]
    return value


def _deep_equal(a: Any, b: Any) -> bool:
    a, b = _normalize(a), _normalize(b)
    if isinstance(a, float) and isinstance(b, float):
        return math.isclose(a, b, rel_tol=1e-9, abs_tol=0.0)
    return bool(a == b)


def _first_diff(expected: Any, actual: Any, path: str = "") -> str | None:
    """Locate the first place two payloads disagree, as a dotted path, so the
    panel can say `to: expected "a@x.com" got "b@x.com"` instead of dumping
    both blobs."""
    if _deep_equal(expected, actual):
        return None
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in expected:
            if key not in actual:
                return f"{path}{key}: missing"
            sub = _first_diff(expected[key], actual[key], f"{path}{key}.")
            if sub is not None:
                return sub
        for key in actual:
            if key not in expected:
                return f"{path}{key}: unexpected"
        return None
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return f"{path[:-1] or 'list'}: length {len(expected)} != {len(actual)}"
        for i, (e, a) in enumerate(zip(expected, actual, strict=True)):
            sub = _first_diff(e, a, f"{path}{i}.")
            if sub is not None:
                return sub
        return None
    loc = path.rstrip(".") or "value"
    return f"{loc}: expected {expected!r} got {actual!r}"


def grade_tool_call(
    *,
    tool: str | None,
    arguments: dict[str, Any] | None,
    expected_tool: str,
    expected_arguments: dict[str, Any] | None,
) -> GradeResult:
    """Grade a predicted call against the answer key. Tool name is compared
    exactly; the payload with normalized deep equality (key order + int/float
    agnostic). `correct` requires both."""
    tool_match = tool == expected_tool
    exp_args = expected_arguments or {}
    got_args = arguments or {}
    payload_match = _deep_equal(exp_args, got_args)
    diff = None if payload_match else _first_diff(exp_args, got_args)
    return GradeResult(
        tool_match=tool_match,
        payload_match=payload_match,
        expected_tool=expected_tool,
        predicted_tool=tool,
        payload_diff=diff,
    )
