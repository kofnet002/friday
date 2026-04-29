"""Coding solution prompt — v1 (mirrors packages/prompts/coding-solution.ts)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

CODING_SOLUTION_VERSION = "1.0.0"


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

OUTPUT STRUCTURE (strict — the candidate's eyes will scan in this order)

1. **Approach** — one sentence naming the technique (e.g., "Two-pointer sliding window", "DP with memoization on (i, j)").
2. **Complexity** — one line: "Time: O(...) | Space: O(...)".
3. **Code** — a single fenced block in {ctx.language}. Clean, idiomatic, no comments except where logic is non-obvious.
4. **Key insight** — one sentence explaining why this approach works. The candidate will paraphrase this out loud.
5. **Edge cases** — 2-4 bullets listing edge cases the candidate should mention they considered.

RULES

- Prefer the OPTIMAL known solution. If brute force is worth mentioning, add one bullet at the end: "Brute force: O(...) — optimized to above via [technique]."
- Code must compile/run. No pseudocode.
- Variable names readable (not `i`, `j`, `x`).
- No print statements, no test harness — just the solution function.
- If the problem has multiple optimal approaches (e.g., DP vs greedy), pick one and mention the alternative in one bullet.
- If the language is Python, follow PEP 8 and use type hints.
- If the language is Java/C++, include necessary imports/headers inline.

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
SOLUTION_OPENAI_MODEL = "gpt-5"
SOLUTION_DEEPSEEK_MODEL = "deepseek-chat"
SOLUTION_MAX_OUTPUT_TOKENS = 2500
SOLUTION_TEMPERATURE = 0.2
