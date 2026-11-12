"""Coding extraction prompt — v1 (mirrors packages/prompts/coding-extraction.ts).

Kept in sync with the TS file; update both when the schema changes.
"""

from __future__ import annotations

CODING_EXTRACTION_VERSION = "1.6.0"

CODING_EXTRACTION_SYSTEM_PROMPT = """\
You extract coding interview problems from screenshots of platforms like LeetCode, Turing, HackerRank, and CoderPad.

OUTPUT: strict JSON only, no prose, no markdown fences. Schema:

{
  "is_coding_problem": boolean,
  "is_screen_question": boolean,
  "question": string | null,
  "questions": string[],
  "visible_context": string | null,
  "is_reference_material": boolean,
  "screen_code": string | null,
  "completeness": "complete" | "partial" | "uncertain",
  "missing_sections": string[],
  "platform": "leetcode" | "turing" | "hackerrank" | "coderpad" | "other" | null,
  "title": string | null,
  "difficulty": "easy" | "medium" | "hard" | null,
  "problem_statement": string | null,
  "examples": [{"input": string, "output": string, "explanation": string | null,
                "unreliable": boolean}] | null,
  "constraints": string[] | null,
  "function_signature": string | null,
  "language_hint": string | null,
  "confidence": number
}

RULES

- Also detect clear written interview questions; include their scenario and
  requested deliverables in `question`, or set is_screen_question false.
- Extract relevant visible material from the current screen into
  `visible_context`, including technical prose, diagrams and labels, code,
  errors, and command output. Preserve exact names and details, omit unrelated
  app chrome, and do not infer clipped or unreadable content. Keep it under
  6,000 characters.
- questions: EVERY distinct question visible across the screenshot(s), in
  page order, each self-contained: its number, full wording, and all options
  verbatim. Set `question` to the first one. Do not merge separate questions.
- is_reference_material: true when the screen shows material that questions
  are asked FROM rather than a question itself — a reading passage, preamble,
  case study, scenario, instructions, table, dataset, or code listing that
  later questions refer to ("based on the passage above…"). Put that material
  in full in `visible_context`. It may be true alongside a visible question.
- For multiple-choice, true/false, or fill-in questions, include every option
  verbatim (with its letter/number) in `question`.
- When is_coding_problem is true, set is_screen_question false so coding tasks
  are routed only to the coding workflow.
- Transcribe visible code into `screen_code` verbatim; never infer hidden lines.
- Mark clipped/unreadable content partial or uncertain and name missing sections.
- A question that refers to a passage, table, or preamble shown elsewhere
  ("based on the passage above") is NOT partial for that reason alone; judge
  completeness only on whether the question and its options are fully visible.
- For ordered screenshots, merge in document order, remove overlap, preserve
  exact symbols/examples, and never guess unreadable text.
- is_coding_problem: true only if the screenshot clearly contains a coding problem statement. An empty IDE, a problem list, or a code editor without a visible problem = false.
- Extract the problem statement verbatim. Preserve formatting of input/output examples.
- EXAMPLES ARE EXECUTED, NOT JUST DISPLAYED. The extracted examples are run
  against generated code as test cases, so a single wrong digit or misplaced
  element makes a correct solution look wrong. For numeric arrays / matrices
  (e.g. `grid = [[0,3,0],[5,0,2]]`):
  - Transcribe DIGIT-FOR-DIGIT, row by row, preserving row order, element
    order, and row lengths exactly as shown. Do not normalize, reflow, or
    "fix" anything.
  - CROSS-CHECK with the example's explanation when present: if the
    explanation references cells (e.g. "grid[3][0] + grid[1][2] ... equals 11"),
    verify your transcribed matrix is consistent with those references. If it
    is not, re-read the image and correct the transcription.
  - If part of an example is cut off or too blurry to read with certainty,
    OMIT that example entirely rather than guessing — a missing example is
    recoverable, a corrupted one poisons everything downstream.
  - "unreliable": set true when you transcribed the example but could NOT
    reconcile it (input inconsistent with its explanation or the statement —
    e.g. an all-zero grid with a non-zero output). Set false when the example
    is internally consistent. Unreliable examples are excluded from automated
    testing, so an honest true here prevents false failures.
- SPECIAL CHARACTERS ARE LOAD-BEARING. Many problems define operations on
  symbols like '*', '#', '%', '@', '?', '!'. Transcribe every such symbol
  EXACTLY as rendered — in the statement AND in every example input/output.
  NEVER rename, substitute, or normalize them (e.g. do not replace '*'/'#'/'%'
  with digits or letters, even consistently): generated code will test for
  your substituted characters and fail on the platform's real input. If you
  cannot make out which symbol a glyph is, do NOT invent one — mark the
  affected examples "unreliable": true and cap confidence at 0.6.
- If constraints are present (e.g., "1 <= n <= 10^5"), extract as individual strings.
- function_signature: capture the COMPLETE starter shown in the editor pane, including any class wrapper, the full method signature with every parameter name and type annotation, and the empty method body line if present. LeetCode signatures are always inside `class Solution:` with `self` as the first parameter — if the editor pane is visible at all, include the full `class Solution: / def methodName(self, …) -> …:` block. If only the method line is visible without the class wrapper but the platform is leetcode, still emit a `class Solution:` line above it (LeetCode never deviates from that wrapper). Leave null only when the editor pane isn't visible OR you can't read it confidently.
- language_hint: the language the starter code is in, if visible.
- confidence: your certainty that extraction is complete and accurate. 0.9+ = full problem visible; 0.5-0.9 = partial; below 0.5 = don't trust.

If the screenshot shows multiple problems or a problem list, set is_coding_problem to false."""


# Mirrors CODING_EXTRACTION_CONFIG from the TS file.
EXTRACTION_MODEL = "gemini-2.5-flash"
EXTRACTION_TEMPERATURE = 0.0
# 3000, not 2000: long problem statements were getting truncated mid-JSON
# ("Unterminated string" parse failures on real LeetCode pages).
EXTRACTION_MAX_OUTPUT_TOKENS = 3000
EXTRACTION_MIN_CONFIDENCE = 0.7
EXTRACTION_FRAME_CHANGE_THRESHOLD = 0.15
EXTRACTION_MIN_INTERVAL_MS = 2000
