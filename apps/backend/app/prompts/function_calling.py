"""Function-calling assessment solver prompt.

Given a task and a tool catalog, the model must select exactly one tool and
construct its argument payload — the shape of a "Function Calling Test". Output
is strict JSON so the solver can parse it and hand it straight to the verifier.
"""

from __future__ import annotations

import json
from typing import Any

FUNCTION_CALLING_VERSION = "1.0.0"

FUNCTION_CALLING_MAX_OUTPUT_TOKENS = 1024
# Deterministic: a function-calling test has ONE correct tool+payload, so we
# want the single most-likely answer, not a sampled one.
FUNCTION_CALLING_TEMPERATURE = 0.0

FUNCTION_CALLING_SYSTEM_PROMPT = """\
You answer function-calling assessments. You are given a task and a catalog of \
available tools, each with a JSON-Schema description of its parameters. Select \
EXACTLY ONE tool and construct the argument payload that correctly performs the \
task.

OUTPUT: strict JSON only. No prose, no markdown fences, no commentary. Schema:

{
  "tool": string,          // the exact name of the chosen tool, copied verbatim
  "arguments": { ... }     // the payload, keyed by the tool's parameter names
}

RULES

- Choose the single tool whose purpose matches the task. There is exactly one \
correct tool — do not invent tools or combine several.
- Use parameter names EXACTLY as declared in the tool's schema. Do not rename, \
add, or drop parameters.
- Include every `required` parameter. Include an optional parameter only when \
the task clearly calls for it; otherwise omit it (do not pass null or "").
- Respect declared types and `enum` values: a string stays a string, an array \
stays an array, an enum value is copied verbatim from the allowed set.
- Extract argument values from the task literally. Do not paraphrase names, \
addresses, subjects, or bodies — attention to detail is graded.
- If a value is not stated in the task, do not fabricate one; leave the optional \
parameter out.
"""


def function_calling_user_prompt(
    question: str,
    tools: list[dict[str, Any]],
    *,
    extra_instructions: str | None = None,
) -> str:
    """Render the task + tool catalog into the user turn. The catalog is
    serialized as pretty JSON so the model sees each tool's exact parameter
    names, types, and required list."""
    catalog = json.dumps(tools, indent=2, ensure_ascii=False)
    parts = [
        "TASK:",
        question.strip(),
        "",
        "AVAILABLE TOOLS:",
        catalog,
    ]
    if extra_instructions and extra_instructions.strip():
        parts += ["", "ADDITIONAL INSTRUCTIONS:", extra_instructions.strip()]
    parts += [
        "",
        'Respond with ONLY the JSON object {"tool": ..., "arguments": {...}}.',
    ]
    return "\n".join(parts)
