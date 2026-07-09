"""Verify-harness regression tests.

The one that matters most: string-output problems. OCR drops the quotes
around string expected-outputs (`d`, `-`), which used to make _parse_value
raise inside the harness and error EVERY case (passed=0 regardless of the
solution) — silently burning agent escalations on a structurally broken
verify.
"""

from __future__ import annotations

import pytest

from app.services.code_runner import run_solution_tests

_STRING_SOLUTION = """\
### 💻 Code
```python
class Solution:
    def firstChar(self, s: str, k: int) -> str:
        return s[k] if k < len(s) else "-"
```
"""


@pytest.mark.asyncio
async def test_bare_string_expected_output() -> None:
    """Unquoted string outputs must compare as literal strings, not error."""
    examples = [
        {"input": 's = "cab", k = 1', "output": "a"},
        {"input": 's = "cab", k = 9', "output": "-"},
    ]
    res = await run_solution_tests(
        solution_markdown=_STRING_SOLUTION, examples=examples, language="Python"
    )
    assert res.ran
    assert all(c.ok for c in res.cases), [(c.expected, c.actual, c.error) for c in res.cases]


@pytest.mark.asyncio
async def test_bare_string_real_mismatch_still_fails() -> None:
    """The fallback must not turn genuine wrong answers into passes."""
    examples = [{"input": 's = "cab", k = 1', "output": "z"}]
    res = await run_solution_tests(
        solution_markdown=_STRING_SOLUTION, examples=examples, language="Python"
    )
    assert res.ran
    assert not res.cases[0].ok
    assert res.cases[0].error is None  # a real comparison, not a parse error


@pytest.mark.asyncio
async def test_quoted_and_numeric_outputs_unaffected() -> None:
    """Existing behavior: quoted strings and numbers still parse as literals."""
    examples = [
        {"input": 's = "cab", k = 0', "output": '"c"'},
    ]
    res = await run_solution_tests(
        solution_markdown=_STRING_SOLUTION, examples=examples, language="Python"
    )
    assert res.ran
    assert res.cases[0].ok
