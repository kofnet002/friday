"""Prompt for the agentic coding mode.

Unlike the one-shot solve prompt, this drives the `claude` CLI's full tool
loop: the agent writes the solution to a file, runs it against the extracted
examples, and iterates until they pass BEFORE answering. The prompt therefore
does two jobs: (1) tell the agent how to work (write → test → fix), and (2)
pin the FINAL message to the exact 5-section format the panel's SolutionView
already parses, so an agent answer renders identically to a normal solve.
"""

from __future__ import annotations

from typing import Any

from app.prompts.coding_solution import coding_solution_user_prompt

CODING_AGENT_VERSION = "1.2.0"

# Language tag for the fenced code block in the final answer.
_LANG_TAGS = {
    "python": "python",
    "python3": "python",
    "javascript": "javascript",
    "typescript": "typescript",
    "java": "java",
    "c++": "cpp",
    "cpp": "cpp",
    "go": "go",
}


def _lang_tag(language: str) -> str:
    return _LANG_TAGS.get(language.strip().lower(), language.strip().lower())


def build_agent_prompt(
    problem: dict[str, Any],
    *,
    language: str,
    extra_instructions: str | None = None,
    prior_solution: str | None = None,
    feedback: str | None = None,
    starter_file: str | None = None,
) -> str:
    """Assemble the single headless prompt fed to `claude -p`.

    Reuses coding_solution_user_prompt for the problem block (title / platform
    / statement / examples / constraints / starter code) so the agent sees the
    same framing as a normal solve, then wraps it in agent-loop instructions
    and the mandatory output contract.

    `prior_solution` + `feedback` flip into refine framing: a previous attempt
    failed (locally or on the real judge) and the agent should diagnose that
    failure rather than solve from scratch."""
    problem_block = coding_solution_user_prompt(problem)
    tag = _lang_tag(language)
    extra = (
        f"\n\nADDITIONAL INSTRUCTIONS:\n{extra_instructions}"
        if extra_instructions
        else ""
    )
    starter_note = (
        f"\n   A file `{starter_file}` in the working directory contains the exact"
        " starter signature from the candidate's editor — copy it as your"
        " starting point and keep the signature verbatim."
        if starter_file
        else ""
    )
    refine = ""
    if (prior_solution and prior_solution.strip()) or (feedback and feedback.strip()):
        refine = f"""

─── PREVIOUS ATTEMPT (FAILED) ───
{(prior_solution or "").strip() or "(not provided)"}

─── WHAT WENT WRONG (user / judge feedback) ───
{(feedback or "").strip() or "(not provided)"}

REFINE MODE: a previous solution failed with the feedback above — start from
that diagnosis, not from scratch.
- Wrong answer on a case: run the previous code on that exact input first,
  trace where it diverges, then fix the real bug.
- "Time Limit Exceeded": the ALGORITHM is too slow — do not micro-optimize.
  Derive the required complexity from the constraints and rewrite with a
  fundamentally faster approach, then prove it with the worst-case timing run.
- Keep the same function/method name, signature, and class wrapper unless the
  feedback shows the signature itself is wrong."""

    return f"""\
You are an expert competitive programmer solving ONE coding-interview problem \
in {language}, working autonomously in an isolated scratch directory with \
Read/Write/Edit/Bash. Do NOT ask questions — decide and act.

DO NOT RESEARCH. You have no internet. Do NOT try to search the web, look up \
the problem, or "verify the real statement" — solve it DIRECTLY from the \
statement and examples given below, using only your own reasoning + running \
code. Spending turns trying to research wastes your whole time budget and is \
the #1 way this fails.

GOAL: produce a solution that is VERIFIED CORRECT by actually running it, not \
just reasoning about it. This is the whole point — the fast one-shot models \
already failed on this problem, so EXECUTE and CHECK your work.

TRUST THE STATEMENT, TREAT EXAMPLES AS FALLIBLE. The problem statement is your \
source of truth. The examples were OCR'd from a screenshot and MAY contain \
transcription errors (a wrong digit in a grid, a truncated array). If an \
example looks internally inconsistent (e.g. an all-zero input with a non-zero \
output), do NOT stall or research it — note it in one line, rely on the \
STATEMENT, and still deliver a correct, runnable solution to the stated problem.

PROCESS
1. Write your solution to a file (e.g. solution.py) in the CURRENT working \
directory — it is your private scratch dir. Never create files under /tmp or \
any other shared path: those persist between runs, and a stale driver from a \
previous problem can silently poison your verification.{starter_note}
2. Write a small driver script that runs your solution against the provided \
examples and prints PASS/FAIL with expected vs actual for each.
3. Run it with Bash. If an example fails, decide whether YOUR code is wrong or \
the EXAMPLE is corrupt: fix the code if it's a real bug; if the example is \
clearly inconsistent with the statement, disregard that one example and move \
on. Do not loop forever chasing a bad example.
4. EARLY ANSWER (HARD RULE — not optional): the VERY FIRST message you write \
after the driver prints all examples PASS must be the complete solution in \
the exact FINAL ANSWER format below — before any timing runs, edge-case \
analysis, or other hardening. The user is in a live interview and sees this \
message immediately; every second you spend hardening before emitting it is \
time they sit with nothing. Do not write "now let's check timing" or any \
other text first. After emitting it, continue with steps 5–6; your final \
message delivers the (possibly improved) final version in the same format.
5. PERFORMANCE GATE (mandatory — correct-but-slow means Time Limit Exceeded \
on the real judge, which is a FAILURE): read the constraints, generate a \
random WORST-CASE input at the maximum stated size (e.g. n = 1000 → a full \
1000-size input), and TIME your solution on it with Bash. It must finish in \
under ~2 seconds. If it's slower, your complexity is too high — derive the \
required complexity from the constraints (n ≤ 100 → O(n^3) usually fine; \
n ≤ 1000 → at most ~O(n^2 log n); n ≤ 10^5 → O(n log n)) and optimize (better \
state space, prefix/suffix precomputation, monotonic structures) until the \
worst-case timing passes. Re-run the examples after optimizing.
6. Then reason about edge cases beyond the examples (empty input, max \
constraints, duplicates, overflow, etc.) and harden the code. Re-run to \
confirm nothing regressed.
7. If you genuinely cannot get all examples passing, still deliver your best \
verified-as-far-as-possible attempt and note the remaining gap in the Approach \
line — do not loop forever.

FINAL ANSWER (CRITICAL)
Your FINAL message — and nothing else in it — must be the interview-ready \
solution in EXACTLY this Markdown, starting directly with the first heading:

### 🎯 Approach
One sentence naming the technique.

### ⏱️ Complexity
One line, exactly: `Time: O(...) | Space: O(...)`.

### 💻 Code
A single fenced code block tagged ```{tag} containing the EXACT code you \
verified passing (match any provided starter signature verbatim). No test \
harness, no prints — just the solution function/method.

### 💡 Key insight
One sentence on why the approach works.

### ⚡ Edge cases
2–4 short bullets of edge cases considered. Optionally end with \
`Verified: passed N/N provided examples.`

Rules for the final message:
- Only the five sections above. No preamble, no "I tested it and..." narration \
— all of your reasoning, files, and test runs happen in earlier turns, not in \
the final message.
- The code block MUST be the code you actually ran and verified.{extra}

─── PROBLEM ───
{problem_block}{refine}"""
