/**
 * Coding problem extraction from screenshot — v1
 *
 * Purpose: given a screenshot of a coding platform (LeetCode, Turing, HackerRank),
 * extract the problem into structured JSON for solution generation.
 *
 * Called on significant-change frames when coding mode is active.
 * Target model: gemini-2.5-flash (vision + cheap) OR gpt-4o vision.
 */

export const CODING_EXTRACTION_VERSION = '1.6.0';

export const CODING_EXTRACTION_SYSTEM_PROMPT = `You extract coding interview problems from screenshots of platforms like LeetCode, Turing, HackerRank, and CoderPad.

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
  "examples": [{"input": string, "output": string, "explanation": string | null}] | null,
  "constraints": string[] | null,
  "function_signature": string | null,
  "language_hint": string | null,
  "confidence": number
}

RULES

- Also detect clear written interview questions; include their scenario and
  requested deliverables in the question field, or set is_screen_question false.
- Extract relevant visible material from the current screen into
  \`visible_context\`, including technical prose, diagrams and labels, code,
  errors, and command output. Preserve exact names and details, omit unrelated
  app chrome, and do not infer clipped or unreadable content. Keep it under
  6,000 characters.
- questions: EVERY distinct question visible across the screenshot(s), in
  page order, each self-contained: its number, full wording, and all options
  verbatim. Set the question field to the first one. Do not merge separate questions.
- is_reference_material: true when the screen shows material that questions
  are asked FROM rather than a question itself — a reading passage, preamble,
  case study, scenario, instructions, table, dataset, or code listing that
  later questions refer to ("based on the passage above…"). Put that material
  in full in \`visible_context\`. It may be true alongside a visible question.
- For multiple-choice, true/false, or fill-in questions, include every option
  verbatim (with its letter/number) in the question field.
- When is_coding_problem is true, set is_screen_question false so coding tasks
  are routed only to the coding workflow.
- Transcribe visible code into the screen_code field verbatim; never infer hidden lines.
- Mark clipped/unreadable content partial or uncertain and name missing sections.
- A question that refers to a passage, table, or preamble shown elsewhere
  ("based on the passage above") is NOT partial for that reason alone; judge
  completeness only on whether the question and its options are fully visible.
- For ordered screenshots, merge in document order, remove overlap, preserve
  exact symbols/examples, and never guess unreadable text.
- is_coding_problem: true only if the screenshot clearly contains a coding problem statement. An empty IDE, a problem list, or a code editor without a visible problem = false.
- Extract the problem statement verbatim. Preserve formatting of input/output examples.
- If constraints are present (e.g., "1 <= n <= 10^5"), extract as individual strings.
- If a function signature / starter code is visible, extract it exactly.
- language_hint: the language the starter code is in, if visible.
- confidence: your certainty that extraction is complete and accurate. 0.9+ = full problem visible; 0.5-0.9 = partial; below 0.5 = don't trust.

If the screenshot shows multiple problems or a problem list, set is_coding_problem to false.`;

export const CODING_EXTRACTION_CONFIG = {
  model: 'gemini-2.5-flash',
  temperature: 0.0,
  max_output_tokens: 2000,
  response_mime_type: 'application/json',
  min_confidence_to_use: 0.7,
  frame_change_threshold: 0.15,
  min_interval_ms: 2000,
} as const;
