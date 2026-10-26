"""Function-calling self-verify + grading tests.

The verifier is the centerpiece of the function-calling assessment feature (the
tool-selection analog of code_runner): it structurally checks a predicted
`{tool, arguments}` against the catalog, and grades it against an answer key.
Pure logic, no LLM — everything here runs offline.
"""

from __future__ import annotations

from app.services.tool_call_runner import (
    check_tool_call,
    grade_tool_call,
)

# A small email-tool catalog, the "Email - Easy" assessment shape.
_SEND_EMAIL = {
    "name": "send_email",
    "description": "Send an email to one or more recipients.",
    "parameters": {
        "type": "object",
        "properties": {
            "to": {"type": "string"},
            "subject": {"type": "string"},
            "body": {"type": "string"},
            "cc": {"type": "array", "items": {"type": "string"}},
            "priority": {"type": "string", "enum": ["low", "normal", "high"]},
        },
        "required": ["to", "subject", "body"],
        "additionalProperties": False,
    },
}
_SEARCH_INBOX = {
    "name": "search_inbox",
    "parameters": {
        "type": "object",
        "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
        "required": ["query"],
        "additionalProperties": False,
    },
}
_CATALOG = [_SEND_EMAIL, _SEARCH_INBOX]


# ─── structural self-verify ──────────────────────────────────────────────────


def test_valid_call_passes_all_checks() -> None:
    res = check_tool_call(
        tool="send_email",
        arguments={"to": "a@x.com", "subject": "Hi", "body": "Hello"},
        tools=_CATALOG,
    )
    assert res.ran
    assert res.ok, [c.detail for c in res.failures]


def test_unknown_tool_fails() -> None:
    res = check_tool_call(tool="delete_all", arguments={}, tools=_CATALOG)
    assert res.ran and not res.ok
    assert res.failures[0].kind == "unknown-tool"


def test_missing_required_param_fails() -> None:
    res = check_tool_call(
        tool="send_email", arguments={"to": "a@x.com", "subject": "Hi"}, tools=_CATALOG
    )
    assert not res.ok
    missing = [c for c in res.failures if c.kind == "missing-required"]
    assert missing and missing[0].field == "body"


def test_unexpected_param_flagged_when_additional_properties_false() -> None:
    res = check_tool_call(
        tool="send_email",
        arguments={"to": "a@x.com", "subject": "Hi", "body": "y", "bcc": "z@x.com"},
        tools=_CATALOG,
    )
    assert not res.ok
    extra = [c for c in res.failures if c.kind == "unexpected-param"]
    assert extra and extra[0].field == "bcc"


def test_type_mismatch_fails() -> None:
    res = check_tool_call(
        tool="search_inbox", arguments={"query": "hi", "limit": "ten"}, tools=_CATALOG
    )
    assert not res.ok
    mism = [c for c in res.failures if c.kind == "type-mismatch"]
    assert mism and mism[0].field == "limit"


def test_bool_is_not_integer() -> None:
    res = check_tool_call(
        tool="search_inbox", arguments={"query": "hi", "limit": True}, tools=_CATALOG
    )
    assert not res.ok
    assert any(c.kind == "type-mismatch" and c.field == "limit" for c in res.failures)


def test_enum_violation_fails() -> None:
    res = check_tool_call(
        tool="send_email",
        arguments={"to": "a@x.com", "subject": "Hi", "body": "y", "priority": "urgent"},
        tools=_CATALOG,
    )
    assert not res.ok
    assert any(c.kind == "type-mismatch" and c.field == "priority" for c in res.failures)


def test_array_item_type_checked() -> None:
    res = check_tool_call(
        tool="send_email",
        arguments={"to": "a@x.com", "subject": "Hi", "body": "y", "cc": ["ok@x.com", 5]},
        tools=_CATALOG,
    )
    assert not res.ok
    assert any(c.kind == "type-mismatch" and c.field == "cc" for c in res.failures)


def test_skips_when_no_tool_named() -> None:
    res = check_tool_call(tool=None, arguments={}, tools=_CATALOG)
    assert not res.ran and res.skip_reason


def test_skips_on_empty_catalog() -> None:
    res = check_tool_call(tool="send_email", arguments={}, tools=[])
    assert not res.ran


def test_anthropic_input_schema_key_accepted() -> None:
    tool = {
        "name": "ping",
        "input_schema": {
            "type": "object",
            "properties": {"host": {"type": "string"}},
            "required": ["host"],
        },
    }
    ok = check_tool_call(tool="ping", arguments={"host": "x"}, tools=[tool])
    assert ok.ok
    bad = check_tool_call(tool="ping", arguments={}, tools=[tool])
    assert not bad.ok


# ─── graded comparison ───────────────────────────────────────────────────────


def test_grade_exact_match() -> None:
    g = grade_tool_call(
        tool="send_email",
        arguments={"to": "a@x.com", "subject": "Hi", "body": "Hello"},
        expected_tool="send_email",
        expected_arguments={"body": "Hello", "to": "a@x.com", "subject": "Hi"},  # key order differs
    )
    assert g.correct and g.tool_match and g.payload_match


def test_grade_wrong_tool() -> None:
    g = grade_tool_call(
        tool="search_inbox",
        arguments={"query": "x"},
        expected_tool="send_email",
        expected_arguments={"to": "a@x.com", "subject": "Hi", "body": "y"},
    )
    assert not g.correct and not g.tool_match


def test_grade_payload_diff_reported() -> None:
    g = grade_tool_call(
        tool="send_email",
        arguments={"to": "b@x.com", "subject": "Hi", "body": "y"},
        expected_tool="send_email",
        expected_arguments={"to": "a@x.com", "subject": "Hi", "body": "y"},
    )
    assert not g.correct and g.tool_match and not g.payload_match
    assert g.payload_diff and "to" in g.payload_diff


def test_grade_int_float_equal() -> None:
    g = grade_tool_call(
        tool="search_inbox",
        arguments={"query": "x", "limit": 5},
        expected_tool="search_inbox",
        expected_arguments={"query": "x", "limit": 5.0},
    )
    assert g.payload_match


def test_grade_nested_and_list_equality() -> None:
    g = grade_tool_call(
        tool="send_email",
        arguments={"to": "a@x.com", "subject": "Hi", "body": "y", "cc": ["p@x.com", "q@x.com"]},
        expected_tool="send_email",
        expected_arguments={
            "cc": ["p@x.com", "q@x.com"],
            "to": "a@x.com",
            "subject": "Hi",
            "body": "y",
        },
    )
    assert g.payload_match
