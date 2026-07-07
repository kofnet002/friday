"""Self-verification for generated coding solutions.

After Friday streams a solve-mode solution, this runs it against the
problem's extracted examples BEFORE the candidate ever pastes it into the
real judge. The panel can then show ✓ 3/3 or ✗ fails example 2, and the
user can refine with a precise, machine-checked failure instead of finding
out on LeetCode.

Scope (v1):
- Python solutions only. Other languages return ran=False (skipped).
- LeetCode-style examples: `input` is "name = literal, name2 = literal"
  and `output` is a single literal. HackerRank-style bare functions are
  also supported.
- Sandbox is a subprocess with a wall-clock timeout + RLIMIT_CPU /
  RLIMIT_AS, run in `-I` isolated mode from a temp dir, plus a static
  denylist scan that rejects obviously dangerous operations. This is
  "good enough for a local personal tool" — NOT a hardened sandbox. The
  code being run is the LLM's answer to the user's own interview problem,
  not adversarial input; the denylist mainly guards against a
  hallucinated `os.system(...)`.
"""

from __future__ import annotations

import asyncio
import json
import re
import resource
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any

from app.logging import log

# ─── limits ──────────────────────────────────────────────────────────────────
_WALL_TIMEOUT_S = 8.0          # subprocess.run hard kill
_CPU_SECONDS = 5               # RLIMIT_CPU — catches infinite loops
_ADDRESS_SPACE_BYTES = 512 * 1024 * 1024  # RLIMIT_AS — catches memory bombs

# Substrings that, if present in the solution, abort the run. LeetCode /
# HackerRank solutions never need any of these; their presence means either
# a hallucination or something we don't want to execute locally. `sys` is
# deliberately allowed — sys.setrecursionlimit is common and benign in a
# throwaway subprocess.
_BLOCKED_PATTERNS = (
    "import os",
    "from os ",
    "import subprocess",
    "import socket",
    "import shutil",
    "import pathlib",
    "from pathlib",
    "import requests",
    "import urllib",
    "import ctypes",
    "import multiprocessing",
    "__import__",
    "eval(",
    "exec(",
    "compile(",
    "open(",
    "input(",
)


@dataclass(frozen=True)
class TestCaseResult:
    ok: bool
    input: str
    expected: str
    actual: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class TestRunResult:
    """Outcome of running a solution against its examples.

    `ran` is False when verification was skipped entirely (non-Python
    language, no examples, blocked code, no callable found) — in that case
    `skip_reason` explains why and `cases` is empty."""

    ran: bool
    cases: list[TestCaseResult] = field(default_factory=list)
    skip_reason: str | None = None

    @property
    def passed(self) -> int:
        return sum(1 for c in self.cases if c.ok)

    @property
    def total(self) -> int:
        return len(self.cases)

    @property
    def all_passed(self) -> bool:
        return self.ran and self.total > 0 and self.passed == self.total


_CODE_FENCE = re.compile(r"```[a-zA-Z0-9+#]*\n(.*?)```", re.DOTALL)
_METHOD_RE = re.compile(r"def\s+(\w+)\s*\(\s*self\b")
_FUNC_RE = re.compile(r"^def\s+(\w+)\s*\(", re.MULTILINE)


def _extract_code(markdown: str) -> str:
    """Pull the first fenced code block out of a streamed solution. Falls
    back to the whole string when there's no fence (the solution prompt
    always fences code, but a refine reply occasionally inlines it)."""
    m = _CODE_FENCE.search(markdown)
    return (m.group(1) if m else markdown).strip()


def _find_entry(code: str) -> tuple[str, bool] | None:
    """Return (name, is_method). Prefer a `class Solution` method (the
    LeetCode shape — exactly one `def …(self, …)`); fall back to the first
    top-level function (the HackerRank shape). None when no callable
    is found."""
    m = _METHOD_RE.search(code)
    if m:
        return m.group(1), True
    m = _FUNC_RE.search(code)
    if m:
        return m.group(1), False
    return None


# The harness runs INSIDE the sandbox. It reads the test list from stdin,
# parses LeetCode-format inputs, invokes the solution, and prints a JSON
# results array. {code}/{entry}/{is_method} are filled in by _build_harness.
_HARNESS_TEMPLATE = '''\
import ast, json, sys

# LeetCode-style prelude: their runtime pre-imports typing names and the
# common algo modules, and generated solutions rely on that (e.g. a bare
# `List[int]` annotation). Without this the harness dies with NameError
# before running a single test.
from typing import List, Dict, Tuple, Set, Optional, Union, Any, Deque, Iterator
import collections, math, heapq, bisect, itertools, functools, re, string
from collections import defaultdict, deque, Counter, OrderedDict
from functools import lru_cache, cache, reduce
from heapq import heappush, heappop, heapify
from bisect import bisect_left, bisect_right, insort
from itertools import permutations, combinations, product, accumulate
from math import inf, gcd, sqrt, ceil, floor, comb, factorial, log2

# ─── candidate solution ───────────────────────────────────────────────
{code}
# ─── end candidate solution ───────────────────────────────────────────

def _split_top_commas(s):
    depth, cur, parts = 0, [], []
    for ch in s:
        if ch in "([{{":
            depth += 1
        elif ch in ")]}}":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur)); cur = []
        else:
            cur.append(ch)
    if cur:
        parts.append("".join(cur))
    return parts

def _parse_value(raw):
    raw = raw.strip()
    try:
        return ast.literal_eval(raw)
    except Exception:
        return json.loads(raw)  # JSON-style true/false/null

def _parse_input(s):
    kwargs = {{}}
    for part in _split_top_commas(s):
        if "=" not in part:
            continue
        name, _, val = part.partition("=")
        kwargs[name.strip()] = _parse_value(val)
    return kwargs

_ENTRY = {entry!r}
_IS_METHOD = {is_method!r}

def _call(kwargs):
    if _IS_METHOD:
        target = getattr(Solution(), _ENTRY)
    else:
        target = globals()[_ENTRY]
    return target(**kwargs)

_tests = json.loads(sys.stdin.read())
_results = []
for _t in _tests:
    try:
        _kwargs = _parse_input(_t["input"])
        _expected = _parse_value(_t["output"])
        _actual = _call(_kwargs)
        _results.append({{"ok": _actual == _expected, "actual": repr(_actual)}})
    except Exception as _e:
        _results.append({{"ok": False, "error": type(_e).__name__ + ": " + str(_e)}})

sys.stdout.write(json.dumps(_results))
'''


def _build_harness(code: str, entry: str, is_method: bool) -> str:
    return _HARNESS_TEMPLATE.format(code=code, entry=entry, is_method=is_method)


# ─── JavaScript ──────────────────────────────────────────────────────────────
# Same contract as the Python harness, run under `node`. TypeScript is NOT
# executed (needs a transpile step) — it skips with a reason like other
# unsupported languages.

_JS_BLOCKED_PATTERNS = (
    "require(",
    "import ",
    "process.",
    "child_process",
    "fs.",
    "fetch(",
    "XMLHttpRequest",
    "eval(",
    "Function(",
)

_FUNC_RE_JS = re.compile(
    r"^\s*(?:function\s+(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*=)", re.MULTILINE
)


def _find_entry_js(code: str) -> str | None:
    m = _FUNC_RE_JS.search(code)
    if m:
        return m.group(1) or m.group(2)
    return None


# `__CODE__` / `__ENTRY__` are substituted with .replace (not .format — JS is
# full of braces). Values are parsed with eval so LeetCode-style literals
# ([1,2], "abc", true/null) work; the SOLUTION string is denylist-scanned for
# eval/require/etc. before it's embedded, the harness's own eval is ours.
_HARNESS_JS = """\
'use strict';
// ─── candidate solution ───────────────────────────────────────────────
__CODE__
// ─── end candidate solution ───────────────────────────────────────────

function __splitTop(s) {
  let depth = 0, cur = '';
  const parts = [];
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}
function __parseVal(raw) { return eval('(' + raw.trim() + ')'); }
function __parseInput(s) {
  const args = [];
  for (const part of __splitTop(s)) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    args.push(__parseVal(part.slice(i + 1)));
  }
  return args;
}

let __data = '';
process.stdin.on('data', (c) => { __data += c; });
process.stdin.on('end', () => {
  const tests = JSON.parse(__data);
  const results = [];
  for (const t of tests) {
    try {
      const args = __parseInput(t.input);
      const expected = __parseVal(t.output);
      const fn = eval('__ENTRY__');
      const actual = fn(...args);
      results.push({ ok: JSON.stringify(actual) === JSON.stringify(expected),
                     actual: JSON.stringify(actual) });
    } catch (e) {
      const name = e && e.constructor ? e.constructor.name : 'Error';
      const msg = e && e.message ? e.message : String(e);
      results.push({ ok: false, error: name + ': ' + msg });
    }
  }
  process.stdout.write(JSON.stringify(results));
});
"""


def _build_harness_js(code: str, entry: str) -> str:
    return _HARNESS_JS.replace("__CODE__", code).replace("__ENTRY__", entry)


def _set_limits() -> None:
    """preexec_fn — applied in the child before exec.

    Each rlimit is set independently and best-effort: RLIMIT_AS is flaky
    on macOS (setrlimit can reject it), and a raising preexec_fn aborts
    the entire subprocess launch. RLIMIT_CPU plus the wall-clock timeout
    on subprocess.run are the load-bearing protections — RLIMIT_AS is a
    bonus when the platform honors it. This function must never raise."""
    for which, value in (
        (resource.RLIMIT_CPU, _CPU_SECONDS),
        (resource.RLIMIT_AS, _ADDRESS_SPACE_BYTES),
    ):
        try:
            resource.setrlimit(which, (value, value))
        except (ValueError, OSError):
            pass


def _run_blocking(
    harness: str, tests_json: str, *, filename: str = "harness.py", argv0: list[str] | None = None
) -> list[dict[str, Any]]:
    """Write the harness to a temp file, run it sandboxed, return the parsed
    JSON results. Raises on a harness-level failure (syntax error in the
    solution, crash before producing JSON). `argv0` selects the interpreter
    (default: isolated Python; JS passes ["node"])."""
    cmd_prefix = argv0 if argv0 is not None else [sys.executable, "-I"]
    with tempfile.TemporaryDirectory(prefix="friday-verify-") as tmp:
        harness_path = f"{tmp}/{filename}"
        with open(harness_path, "w", encoding="utf-8") as fh:
            fh.write(harness)
        proc = subprocess.run(
            [*cmd_prefix, harness_path],
            input=tests_json,
            capture_output=True,
            text=True,
            timeout=_WALL_TIMEOUT_S,
            preexec_fn=_set_limits,
            cwd=tmp,
        )
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(
            f"harness produced no output (exit {proc.returncode}): "
            f"{proc.stderr.strip()[:300]}"
        )
    parsed = json.loads(out)
    if not isinstance(parsed, list):
        raise RuntimeError("harness output was not a JSON array")
    return parsed


async def run_solution_tests(
    *,
    solution_markdown: str,
    examples: list[dict[str, Any]],
    language: str,
) -> TestRunResult:
    """Verify a streamed solution against the problem's examples.

    Returns ran=False (with a skip_reason) when verification can't or
    shouldn't run; otherwise ran=True with one TestCaseResult per example.
    """
    lang = language.strip().lower()
    is_python = lang in ("python", "python3", "py")
    is_js = lang in ("javascript", "js")
    if not (is_python or is_js):
        return TestRunResult(
            ran=False, skip_reason=f"verification supports Python and JavaScript ({language})"
        )
    if is_js and shutil.which("node") is None:
        return TestRunResult(ran=False, skip_reason="node is not installed — JS not verified")
    if not examples:
        return TestRunResult(ran=False, skip_reason="no examples to verify against")

    code = _extract_code(solution_markdown)
    if not code:
        return TestRunResult(ran=False, skip_reason="no code block in the solution")

    patterns = _BLOCKED_PATTERNS if is_python else _JS_BLOCKED_PATTERNS
    blocked = next((p for p in patterns if p in code), None)
    if blocked is not None:
        return TestRunResult(
            ran=False,
            skip_reason=f"solution uses a blocked operation ({blocked!r}) — not executed",
        )

    if is_python:
        entry = _find_entry(code)
        if entry is None:
            return TestRunResult(ran=False, skip_reason="couldn't find a function to call")
        harness = _build_harness(code, entry[0], entry[1])
        run_kwargs: dict[str, Any] = {}
    else:
        entry_js = _find_entry_js(code)
        if entry_js is None:
            return TestRunResult(ran=False, skip_reason="couldn't find a function to call")
        harness = _build_harness_js(code, entry_js)
        run_kwargs = {"filename": "harness.js", "argv0": ["node"]}

    tests_json = json.dumps(
        [{"input": ex.get("input", ""), "output": ex.get("output", "")} for ex in examples]
    )

    try:
        raw = await asyncio.to_thread(
            lambda: _run_blocking(harness, tests_json, **run_kwargs)
        )
    except subprocess.TimeoutExpired:
        return TestRunResult(ran=False, skip_reason="solution timed out during verification")
    except Exception as exc:  # noqa: BLE001
        log.warning("code_runner.harness_failed", error=str(exc)[:300])
        return TestRunResult(ran=False, skip_reason=f"could not run the solution: {exc}")

    cases: list[TestCaseResult] = []
    for ex, result in zip(examples, raw):
        cases.append(
            TestCaseResult(
                ok=bool(result.get("ok")),
                input=str(ex.get("input", "")),
                expected=str(ex.get("output", "")),
                actual=result.get("actual"),
                error=result.get("error"),
            )
        )
    return TestRunResult(ran=True, cases=cases)
