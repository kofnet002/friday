"""Coding panel modes beyond problem→solution.

Three modes mirror what candidates actually need mid-interview when the live
coding goes sideways:

- explain  — paste/select code, get a walkthrough
- debug    — paste code + error/stack trace, get the fix
- tests    — given the current problem, return edge-case inputs to dry-run

Each mode has its own system prompt with a mode-specific output structure so
the panel can render predictable headings/sections. The `solve` mode keeps
living in app/prompts/coding_solution.py.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

CODING_MODES_VERSION = "1.0.0"

# "agent" runs the tool-loop agent (Claude Code CLI) instead of a one-shot
# provider call. Like solve it takes a problem and returns a solution in the
# same 5-section format, so it shares solve's inputs/validation/output shape —
# it has no prompt here (see app.prompts.coding_agent) and is dispatched
# separately in ws_coding rather than through stream_coding.
CodingMode = Literal["solve", "explain", "debug", "tests", "agent"]


@dataclass(frozen=True)
class CodingModeContext:
    language: str
    extra_instructions: str | None = None


# ─── EXPLAIN ─────────────────────────────────────────────────────────────────


def explain_system_prompt(ctx: CodingModeContext) -> str:
    extra = (
        f"\n\nADDITIONAL INSTRUCTIONS:\n{ctx.extra_instructions}"
        if ctx.extra_instructions
        else ""
    )
    return f"""\
You explain code to a candidate in a live interview. They will read your
explanation and paraphrase it out loud. The code is in {ctx.language}.

OUTPUT STRUCTURE (MANDATORY — exact H3 headings, in order)

### 🎯 What it does
One sentence summary of the code's behavior.

### 🔍 Walkthrough
3–6 short bullets, each tracing a logical step. Use inline `code` chips for
variables / functions / types. Lead each bullet with the action verb.

### ⏱️ Complexity
One line in this exact form: `Time: O(...) | Space: O(...)`. If the code is
not algorithmic (e.g., a class definition), say so explicitly.

### 💡 Why it works
One sentence on the underlying technique or invariant that makes the
approach correct.

### ⚠️ Gotchas
0–3 bullets listing easy-to-miss details: off-by-one, mutation surprises,
implicit copies, async pitfalls, etc. Omit the heading if there are none.

RULES

- Direct, scannable, no preamble.
- Don't restate the code line-by-line — pull out the structure.
- If the snippet is incomplete or non-runnable, say so in **What it does**.{extra}"""


def explain_user_prompt(code: str, hint: str | None = None) -> str:
    parts: list[str] = []
    if hint:
        parts.append(f"<context>\n{hint.strip()}\n</context>\n")
    parts.append(f"```\n{code.strip()}\n```")
    parts.append("\nExplain the snippet above.")
    return "\n".join(parts)


# ─── DEBUG ───────────────────────────────────────────────────────────────────


def debug_system_prompt(ctx: CodingModeContext) -> str:
    extra = (
        f"\n\nADDITIONAL INSTRUCTIONS:\n{ctx.extra_instructions}"
        if ctx.extra_instructions
        else ""
    )
    return f"""\
You debug code in a live interview. The candidate hit an error and is
narrating to the interviewer; your job is to identify the bug and show the
fix without rewriting the world. Language: {ctx.language}.

OUTPUT STRUCTURE (MANDATORY — exact H3 headings, in order)

### 🐛 Diagnosis
One sentence naming the root cause. Be specific (cite the line / variable /
operation that's wrong).

### ✅ Fix
A single fenced code block in {ctx.language} containing ONLY the changed
region (function, method, or a few lines). Do NOT reproduce unrelated code.
Add inline `// fix:` comments highlighting the changed lines.

### 🔎 Why
2–4 short bullets explaining why the diagnosis is correct and why the fix
resolves it. Reference the error message / stack trace tokens directly.

### 🧪 Verify
One sentence describing how the candidate can confirm the fix (e.g. "Re-run
the failing test with input X" or "Compile and observe the warning is
gone"). Skip if obvious.

RULES

- If the error message points at a different cause than the actual bug, call
  out the misleading clue in **🔎 Why** so the candidate doesn't get fooled.
- If multiple bugs are visible, surface the FIRST one that would fire — fix
  one thing at a time. Mention the others in a final bullet of **🔎 Why**.
- If the code looks correct but the error context is missing key info (e.g.
  no stack trace), say so in **🐛 Diagnosis** and ask for the specific data
  needed.{extra}"""


def debug_user_prompt(code: str, error: str, hint: str | None = None) -> str:
    parts: list[str] = []
    if hint:
        parts.append(f"<context>\n{hint.strip()}\n</context>\n")
    parts.append(f"<code>\n```\n{code.strip()}\n```\n</code>")
    parts.append(f"\n<error>\n{error.strip()}\n</error>")
    parts.append("\nDiagnose and fix.")
    return "\n".join(parts)


# ─── TESTS ───────────────────────────────────────────────────────────────────


def tests_system_prompt(ctx: CodingModeContext) -> str:
    extra = (
        f"\n\nADDITIONAL INSTRUCTIONS:\n{ctx.extra_instructions}"
        if ctx.extra_instructions
        else ""
    )
    return f"""\
You generate edge-case test inputs for a coding-interview problem. The
candidate will dry-run their solution against these to catch bugs before
showing the interviewer. Solution language: {ctx.language}.

OUTPUT STRUCTURE (MANDATORY — exact H3 headings, in order)

### 🧪 Test cases
A numbered list. Each item is a single test, formatted exactly:

  N. **<label>** — `input` → `expected` ─ <why this stresses the solution>

Where:
- `<label>` is a short category: "Empty", "Single element", "All same",
  "Sorted ascending", "Sorted descending", "Negatives present", "Max-size
  per constraints", "Tight cycle", etc.
- `input` and `expected` are written exactly as they would appear in the
  function call / output — concrete values, not placeholders.
- The trailing rationale is 1 short sentence.

### 🚨 Most likely to break
One bullet identifying which test you think is most likely to expose a bug
in a naive solution, and why.

RULES

- 5–8 tests. The first should be the smallest non-trivial case; the last
  should be the constraint-max boundary.
- Prefer tests that exercise DIFFERENT failure modes (off-by-one, overflow,
  empty input, max input, duplicates, sorted vs unsorted). Skip cases that
  exercise the same code path twice.
- If the problem has explicit constraints, derive at least one test from
  each numeric bound.
- If the problem statement is too vague to generate concrete values, say so
  in a single bullet under **🧪 Test cases** rather than fabricating.{extra}"""


def tests_user_prompt(problem: dict[str, Any]) -> str:
    # Reuses the same shape as the solve prompt's user input, minus the
    # starter-code emphasis — tests don't care about the function signature.
    parts: list[str] = []
    title = problem.get("title")
    if title:
        parts.append(f"**{title}**\n")
    statement = problem.get("problem_statement") or ""
    parts.append(statement)
    examples = problem.get("examples") or []
    if examples:
        parts.append("\n**Examples:**")
        for i, ex in enumerate(examples, 1):
            block = (
                f"Example {i}:\nInput: {ex.get('input', '')}\nOutput: {ex.get('output', '')}"
            )
            explanation = ex.get("explanation")
            if explanation:
                block += f"\nExplanation: {explanation}"
            parts.append(block)
    constraints = problem.get("constraints") or []
    if constraints:
        parts.append("\n**Constraints:**\n" + "\n".join(f"- {c}" for c in constraints))
    parts.append("\nGenerate edge-case test inputs that stress this problem.")
    return "\n".join(parts)
