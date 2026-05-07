"""Coding solution prompt — v1 (mirrors packages/prompts/coding-solution.ts)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

CODING_SOLUTION_VERSION = "1.1.0"


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

RULES

- Prefer the OPTIMAL known solution.
- Code must compile/run. No pseudocode.
- Variable names readable (avoid bare `i`, `j`, `x` for non-trivial state — `left`, `right`, `acc`, `best` etc. are fine).
- No print statements, no test harness — just the solution function/method.
- If the language is Python, follow PEP 8 and use type hints.
- If the language is Java/C++, include necessary imports/headers inline.
- Do NOT add any other top-level headings or preamble — start directly with `### 🎯 Approach`.

LENGTH TARGET: 250-500 words total including code.{extra}"""


def coding_solution_user_prompt(problem: dict[str, Any]) -> str:
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
                f"Example {i}:\n"
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
        parts.append(f"\n**Starter code:**\n```\n{signature}\n```")
    return "\n".join(parts)


SOLUTION_GEMINI_MODEL = "gemini-2.5-flash"
SOLUTION_OPENAI_MODEL = "gpt-4o"
SOLUTION_DEEPSEEK_MODEL = "deepseek-chat"
SOLUTION_MAX_OUTPUT_TOKENS = 2500
SOLUTION_TEMPERATURE = 0.2
