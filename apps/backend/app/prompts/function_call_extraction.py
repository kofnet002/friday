"""Vision prompt for detecting a function-calling assessment on screen.

The coding sibling (`coding_extraction.py`) pulls a LeetCode/HackerRank problem
out of a screenshot. This one recognizes the "Function Calling Test" shape: a
natural-language task plus a catalog of callable tools with parameter schemas.
The output feeds the same solve → self-verify flow as a hand-entered
assessment.
"""

from __future__ import annotations

FUNCTION_CALL_EXTRACTION_VERSION = "1.0.0"

FUNCTION_CALL_EXTRACTION_MAX_OUTPUT_TOKENS = 2048
FUNCTION_CALL_EXTRACTION_TEMPERATURE = 0.0
# Higher bar than coding (0.7): a false positive here hijacks the panel with a
# fabricated tool catalog, so only fire when the assessment is clearly on screen.
FUNCTION_CALL_EXTRACTION_MIN_CONFIDENCE = 0.75

FUNCTION_CALL_EXTRACTION_SYSTEM_PROMPT = """\
You detect FUNCTION-CALLING ASSESSMENTS in screenshots. These tests show a task \
(often an email, calendar, search, or API scenario) and ask the candidate to \
pick the correct tool and construct its argument payload. A tool catalog — each \
tool with a name, description, and parameter schema — is usually shown on the \
same screen or a side panel.

OUTPUT: strict JSON only, no prose, no markdown fences. Schema:

{
  "is_function_call": boolean,
  "title": string | null,
  "question": string | null,
  "tools": [
    {
      "name": string,
      "description": string | null,
      "parameters": {                      // JSON Schema for the arguments
        "type": "object",
        "properties": { "<param>": { "type": "string|integer|number|boolean|array|object", ... } },
        "required": [ "<param>", ... ],
        "additionalProperties": false
      }
    }
  ] | null,
  "confidence": number
}

RULES

- is_function_call: true ONLY when the screen clearly presents a function/tool \
calling task — a task/prompt to satisfy AND (usually) a list of available tools. \
A plain coding problem, an empty IDE, a chat window, or a docs page = false.
- Transcribe the task/question VERBATIM. Preserve every literal the answer will \
need — email addresses, names, subjects, dates, IDs — exactly as shown. These \
are graded character-for-character; do not paraphrase or "clean up".
- For each visible tool, copy its name EXACTLY and transcribe its parameter \
schema faithfully: parameter names, JSON types, which are required, and any \
enum value sets. If a tool's schema is only partially visible, include what you \
can read and omit fields you cannot.
- If NO tool catalog is visible (only the task is shown), still set \
is_function_call true when it's clearly a tool-calling task, and set "tools" to \
null. Do not invent tools that aren't on screen.
- confidence: your certainty the detection is complete and accurate. 0.9+ = task \
and full catalog clearly visible; 0.75-0.9 = task clear, catalog partial; below \
0.75 = don't trust, likely not this kind of screen.
"""
