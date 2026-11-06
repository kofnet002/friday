"""Coding solution prompt — v1 (mirrors packages/prompts/coding-solution.ts)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

CODING_SOLUTION_VERSION = "1.3.0"


@dataclass(frozen=True)
class CodingSolutionContext:
    language: str
    difficulty_hint: str | None = None
    extra_instructions: str | None = None


def coding_solution_system_prompt(ctx: CodingSolutionContext) -> str:
    extra = (
        f"\n\nADDITIONAL INSTRUCTIONS:\n{ctx.extra_instructions}"
        if ctx.extra_instructions
        else ""
    )
    return f"""\
You solve coding interview problems. The candidate is in a live interview and will read your solution while explaining it verbally.

LANGUAGE: Always write the code in {ctx.language} - the candidate chose it. Starter code read off their screen may be in another language (the page's editor can still show its default); then port it: same function, parameters and return value, written idiomatically in {ctx.language} with its naming style (a Python `merge_bookings` becomes `mergeBookings` in JavaScript, TypeScript or Java), since that is what the editor shows once the language is switched. Never answer in the starter's language instead.

OUTPUT STRUCTURE (MANDATORY — exact H3 headings, exact emoji, in this order)

Emit Markdown with these five section headings, each on its own line:

### 🎯 Approach
One sentence naming the technique (e.g., "Two-pointer sliding window", "DP with memoization on (i, j)").

### ⏱️ Complexity
One line in this exact form: `Time: O(...) | Space: O(...)`.

### 💻 Code
A single fenced code block in {ctx.language}, with the language tag (```python, ```cpp, ```ts, etc.). Clean, idiomatic. Inline comments only where logic is non-obvious — the candidate will narrate the rest.

### 💡 Key insight
One sentence explaining why this approach works. The candidate will paraphrase this out loud.

### ⚡ Edge cases
2–4 short bullets listing edge cases the candidate should mention they considered. End with one optional bullet for brute-force comparison: "Brute force: O(...) — optimized to above via [technique]."

USE THE PROVIDED STARTER CODE EXACTLY (when present)

If the user prompt contains a `**Starter code:**` block, it is the function signature shown on the candidate's screen. Your code MUST:
- Use the same function/method name verbatim.
- Match every parameter name, parameter type, and return type exactly as given.
- Preserve the class container (e.g., `class Solution:` for LeetCode) if shown.
- NEVER rename, drop, or add parameters. NEVER restructure into a different API.
This is critical — the candidate will paste your body into the editor's existing signature; mismatches mean the answer is graded wrong.

PLATFORM-SPECIFIC BOILERPLATE (use when **Starter code:** is missing)

Vision sometimes captures only the left-hand problem statement and misses
the editor pane on the right, so `**Starter code:**` can be empty even when
the platform clearly expects a specific wrapper. When you see a
`**Platform:**` line in the user prompt:

- `leetcode`: MANDATORY. Wrap your solution in `class Solution:` and use
  `self` as the first parameter of the method. The method name comes from
  the problem statement (e.g. "implement maximumScore" → `def maximumScore`).
  Type hints are required and should match the parameter names shown in
  the problem. Never emit a bare module-level function for LeetCode.
- `hackerrank`: typically a module-level function — do NOT wrap in a class
  unless the problem text explicitly shows one.
- `coderpad` / `turing` / `other` / null: follow whatever the problem
  statement implies; default to a bare function with the language's
  idiomatic style.

If the user prompt provides BOTH starter code AND `**Platform:**`, the
starter code's names and structure win (it's the literal text on the
candidate's screen) - ported to the chosen language if it's in another one.

REFINING A PRIOR SOLUTION (MANDATORY when **Previous attempt:** is present)

If the user prompt contains a `**Previous attempt:**` block followed by a
`**What went wrong:**` note, you are REFINING — not solving from scratch.

DIAGNOSIS DISCIPLINE (do not skip)

Before writing the corrected code, BUILD a mental trace of the previous
attempt on the failing input:

1. Pick the failing input. If the feedback names a specific case (e.g.
   "Case 2 failed, expected 94, got 64"), use that example's input from
   the problem statement. If the feedback only names an exception type or
   line, use the FIRST example input the problem provides.
2. Walk the previous code on that input. Track variable values mentally
   step by step.
3. Identify the FIRST step where an intermediate value disagrees with
   what the correct algorithm would produce. That step's expression is
   the bug.

The diagnosis result goes inline in your **🎯 Approach** line, like:
"Previous attempt computed dp[i][j] as a running prefix sum which double-
counts adjacent black cells; correct is to track only the white→black
boundary contribution. Now using …".

OUTPUT RULES

- Reuse the same function / method name and signature unless the failure
  shows that's literally what's broken. NEVER change the wrapper class
  (`class Solution:` on LeetCode stays).
- Keep the output structure the same (Approach · Complexity · Code · Key
  insight · Edge cases). Add a final 1-line bullet to **⚡ Edge cases**:
  `Fix: <what changed vs the prior attempt>`.
- If you can't identify a single root cause from the trace, say so
  explicitly in **🎯 Approach** ("Cannot pin a single bug; rewriting with
  a verified DP recurrence below.") and produce a clean rewrite using a
  fundamentally different recurrence — do not resubmit a cosmetic edit
  of the previous attempt.
- If the previous attempt has the right idea but a wrong base case or
  off-by-one, name the exact base case / index that was wrong in the
  diagnosis.

RULES

- Prefer the OPTIMAL known solution.
- Code must compile/run. No pseudocode.
- Variable names readable (avoid bare `i`, `j`, `x` for non-trivial state — `left`, `right`, `acc`, `best` etc. are fine).
- No print statements, no test harness — just the solution function/method.
- If the language is Python, follow PEP 8 and use type hints.
- If the language is Java/C++, include necessary imports/headers inline.
- Do NOT add any other top-level headings or preamble — start directly with `### 🎯 Approach`.

LENGTH TARGET: 250-500 words total including code.{extra}"""


_LANGUAGE_ALIASES = {
    "js": "javascript",
    "node": "javascript",
    "ts": "typescript",
    "py": "python",
    "python3": "python",
    "c++": "cpp",
    "golang": "go",
    "c#": "csharp",
}


def _same_language(a: str, b: str) -> bool:
    def norm(x: str) -> str:
        key = x.strip().lower()
        return _LANGUAGE_ALIASES.get(key, key)

    return bool(a.strip()) and norm(a) == norm(b)


def coding_solution_user_prompt(
    problem: dict[str, Any],
    *,
    prior_solution: str | None = None,
    feedback: str | None = None,
    language: str | None = None,
) -> str:
    parts: list[str] = []
    title = problem.get("title")
    if title:
        parts.append(f"**{title}**\n")
    # Surface platform so the system prompt's platform-conditional rule
    # has a hook. Vision sets this to "leetcode" / "hackerrank" / etc.
    platform = problem.get("platform")
    if platform:
        parts.append(f"**Platform:** {platform}\n")
    statement = problem.get("problem_statement") or ""
    parts.append(statement)
    examples = problem.get("examples") or []
    if examples:
        parts.append("\n**Examples:**")
        for i, ex in enumerate(examples, 1):
            # The extractor flags examples it couldn't reconcile with the
            # statement (screen OCR misread). Tell the solver so it trusts
            # the statement over the suspect example instead of contorting
            # the algorithm to fit corrupted numbers.
            suspect = (
                " (⚠ possibly misread from screen — trust the statement)"
                if ex.get("unreliable")
                else ""
            )
            block = (
                f"Example {i}:{suspect}\n"
                f"Input: {ex.get('input', '')}\n"
                f"Output: {ex.get('output', '')}"
            )
            explanation = ex.get("explanation")
            if explanation:
                block += f"\nExplanation: {explanation}"
            parts.append(block)
    constraints = problem.get("constraints") or []
    if constraints:
        parts.append("\n**Constraints:**\n" + "\n".join(f"- {c}" for c in constraints))
    signature = problem.get("function_signature")
    if signature:
        hint = str(problem.get("language_hint") or "").strip()
        label = f"**Starter code ({hint}):**" if hint else "**Starter code:**"
        parts.append(f"\n{label}\n```\n{signature}\n```")
        if language and not _same_language(hint, language):
            lead = f"Port it to {language}" if hint else f"If it isn't {language}, port it to {language}"
            parts.append(
                f"{lead}: same function, parameters and return value, in "
                f"{language}'s naming style (snake_case becomes camelCase in "
                "JavaScript, TypeScript and Java)."
            )
    # Refine mode: previous attempt + failure note attach at the end so
    # the model sees the problem first, then the artifact-to-improve.
    if prior_solution:
        parts.append(f"\n**Previous attempt:**\n```\n{prior_solution.strip()}\n```")
    if feedback:
        parts.append(f"\n**What went wrong:**\n{feedback.strip()}")
    return "\n".join(parts)


SOLUTION_GEMINI_MODEL = "gemini-2.5-flash"
SOLUTION_OPENAI_MODEL = "gpt-4o"
SOLUTION_DEEPSEEK_MODEL = "deepseek-chat"
# Claude has a single capable tier for coding — Opus 4.8 is used for both the
# default solve and the deep refine (it already outclasses the Flash/4o solve
# tier, so there's no cheaper "solve" variant to drop to). Override the model
# string via ANTHROPIC_MODEL in settings if you want Sonnet/Haiku instead.
SOLUTION_ANTHROPIC_MODEL = "claude-opus-4-8"
SOLUTION_MAX_OUTPUT_TOKENS = 2500
SOLUTION_TEMPERATURE = 0.2

# Refine ("Didn't pass?") goes to the stronger / reasoning tier of each
# provider. Flash 2.5 with thinking off was good enough for solve but
# couldn't actually diagnose LeetCode-Hard failures — it just resampled
# the same buggy approach. Pro with thinking on burns more tokens but
# usually converges in one refine pass.
REFINE_GEMINI_MODEL = "gemini-2.5-pro"
REFINE_OPENAI_MODEL = "gpt-4o"
REFINE_DEEPSEEK_MODEL = "deepseek-reasoner"
REFINE_ANTHROPIC_MODEL = SOLUTION_ANTHROPIC_MODEL
REFINE_MAX_OUTPUT_TOKENS = 4000
