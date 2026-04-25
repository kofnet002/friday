"""Coding extraction prompt — v1 (mirrors packages/prompts/coding-extraction.ts).

Kept in sync with the TS file; update both when the schema changes.
"""

from __future__ import annotations

CODING_EXTRACTION_VERSION = "1.0.0"

CODING_EXTRACTION_SYSTEM_PROMPT = """\
You extract coding interview problems from screenshots of platforms like LeetCode, Turing, HackerRank, and CoderPad.

OUTPUT: strict JSON only, no prose, no markdown fences. Schema:

{
  "is_coding_problem": boolean,
  "platform": "leetcode" | "turing" | "hackerrank" | "coderpad" | "other" | null,
  "title": string | null,
  "difficulty": "easy" | "medium" | "hard" | null,
  "problem_statement": string | null,
  "examples": [{"input": string, "output": string, "explanation": string | null}] | null,
  "constraints": string[] | null,
  "function_signature": string | null,
  "language_hint": string | null,
  "confidence": number
}

RULES

- is_coding_problem: true only if the screenshot clearly contains a coding problem statement. An empty IDE, a problem list, or a code editor without a visible problem = false.
- Extract the problem statement verbatim. Preserve formatting of input/output examples.
- If constraints are present (e.g., "1 <= n <= 10^5"), extract as individual strings.
- If a function signature / starter code is visible, extract it exactly.
- language_hint: the language the starter code is in, if visible.
- confidence: your certainty that extraction is complete and accurate. 0.9+ = full problem visible; 0.5-0.9 = partial; below 0.5 = don't trust.

If the screenshot shows multiple problems or a problem list, set is_coding_problem to false."""


# Mirrors CODING_EXTRACTION_CONFIG from the TS file.
EXTRACTION_MODEL = "gemini-2.5-flash"
EXTRACTION_TEMPERATURE = 0.0
EXTRACTION_MAX_OUTPUT_TOKENS = 2000
EXTRACTION_MIN_CONFIDENCE = 0.7
EXTRACTION_FRAME_CHANGE_THRESHOLD = 0.15
EXTRACTION_MIN_INTERVAL_MS = 2000
