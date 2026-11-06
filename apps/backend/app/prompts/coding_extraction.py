"""Coding extraction prompt — v1 (mirrors packages/prompts/coding-extraction.ts).

Kept in sync with the TS file; update both when the schema changes.
"""

from __future__ import annotations

CODING_EXTRACTION_VERSION = "1.5.0"

CODING_EXTRACTION_SYSTEM_PROMPT = """\
You extract coding interview problems from screenshots of platforms like LeetCode, Turing, HackerRank, and CoderPad.

OUTPUT: strict JSON only, no prose, no markdown fences. Schema:

{
  "is_coding_problem": boolean,
  "is_screen_question": boolean,
  "question": string | null,
  "platform": "leetcode" | "turing" | "hackerrank" | "coderpad" | "other" | null,
  "title": string | null,
  "difficulty": "easy" | "medium" | "hard" | null,
  "problem_statement": string | null,
  "examples": [{"input": string, "output": string, "explanation": string | null,
                "unreliable": boolean}] | null,
  "constraints": string[] | null,
  "function_signature": string | null,
  "language_hint": string | null,
  "screen_code": string | null,
  "confidence": number
}

RULES

- is_coding_problem: true only if the screenshot clearly contains a coding problem statement. An empty IDE, a problem list, or a code editor without a visible problem = false.
- is_screen_question: true when the screenshot contains a readable natural-language interview or technical question that is not a coding-platform problem.
- question: when is_screen_question is true, transcribe the COMPLETE question verbatim: everything a person would need to answer it - title, scenario, definitions, messages, given facts and data, tables, code excerpts (with line numbers), and the requested deliverables with their limits (e.g. word counts). Never reduce it to only the final ask or the form fields - the answer is written from this text alone. Otherwise null.
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
- screen_code: whenever source code is visible (a code editor, a snippet in a document or slide, a diff, a terminal with code), transcribe the most prominent block verbatim - keep its line numbers if shown, its indentation, and any visible error or test output beneath it. Fill this even when both flags are false: the interviewer may ask about the code out loud. For a coding problem, this is what is typed in the editor (it may be the candidate's own attempt); null if the editor holds only the starter already in function_signature. Never repeat code already transcribed in question. At most 120 lines. null when no code is visible.
- confidence: your certainty that extraction is complete and accurate. 0.9+ = full problem visible; 0.5-0.9 = partial; below 0.5 = don't trust.

If the screenshot shows multiple problems or a problem list, set is_coding_problem to false. If neither a coding problem nor a readable question is visible, set both flags false."""


# Appended to the system prompt when a scan sends several screenshots. The
# frames are consecutive scroll positions of ONE page, captured because the
# problem didn't fit on a single screen.
CODING_EXTRACTION_SCAN_ADDENDUM = """

MULTI-SCREENSHOT SCAN

You are given {n} screenshots, captured in order while the user scrolled through ONE page so that a problem too long for a single screen could be read in full. Treat them as views of the SAME document, not as separate problems.

- Reconstruct the single problem by combining what each screenshot shows. Order content by its position in the document (top to bottom), NOT by capture order: the user may have scrolled back up, so a later screenshot can show an earlier part of the page.
- Consecutive screenshots usually OVERLAP. Text that appears in several screenshots is ONE occurrence — include it once. Never duplicate a sentence, example, or constraint because it appeared in two screenshots.
- Often only part of the screen scrolls (e.g. a problem pane next to a fixed code editor, or a page under a fixed header). Fixed regions repeat across screenshots unchanged; read them once.
- An example or code block that is cut off at the edge of one screenshot may be complete in another. Assemble it from the screenshots that show it, matching on the overlapping lines. Only omit an example if NO screenshot shows it completely and the parts cannot be joined with certainty.
- Number examples in document order (Example 1, 2, 3 …) exactly as the page labels them; do not invent or skip labels.
- function_signature comes from whichever screenshot shows the editor most completely.
- Some screenshots may show nothing new (a duplicate scroll position) or an unrelated screen (the user switched windows briefly). Ignore those.
- If the screenshots show two DIFFERENT problems, extract the one occupying most of the screenshots.
- A long non-coding question split across screenshots is handled the same way: set is_screen_question and transcribe the whole question once, in order.
- confidence reflects how complete the MERGED problem is: 0.9+ when the full statement, every example, and the constraints were visible across the screenshots."""

# Scans read several screenshots and can return a long, merged problem; the
# single-frame budget truncated long statements mid-JSON.
EXTRACTION_SCAN_MAX_OUTPUT_TOKENS = 8000
# Hard cap on screenshots per scan: desktop sends ≤ 10 frames, plus one
# whole-screen frame when it crops to the scrolled region.
EXTRACTION_SCAN_MAX_IMAGES = 12

# Added when the desktop cropped the frames to the region that scrolled.
CODING_EXTRACTION_SCAN_CROP_NOTE = """
- Screenshot 1 is the WHOLE screen at the start of the scan (use it for the editor / function signature and anything outside the scrolling region). Screenshots 2-{n} are full-resolution crops of ONLY the region that scrolled, in capture order — screenshot 2 shows the same scroll position as screenshot 1. Prefer the crops when reading text, digits and symbols."""


# Mirrors CODING_EXTRACTION_CONFIG from the TS file.
EXTRACTION_MODEL = "gemini-2.5-flash"
EXTRACTION_TEMPERATURE = 0.0
# 3000, not 2000: long problem statements were getting truncated mid-JSON
# ("Unterminated string" parse failures on real LeetCode pages). 4500 since
# 1.5.0 also transcribes the code in the editor (screen_code, <=120 lines).
EXTRACTION_MAX_OUTPUT_TOKENS = 4500
EXTRACTION_MIN_CONFIDENCE = 0.7
EXTRACTION_FRAME_CHANGE_THRESHOLD = 0.15
EXTRACTION_MIN_INTERVAL_MS = 2000
