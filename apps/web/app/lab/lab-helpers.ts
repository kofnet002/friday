// Pure helpers for the model lab page (no imports, unit-tested).

export interface LabExample {
  input: string;
  output: string;
  explanation?: string | null;
}

export interface LabProblem {
  is_coding_problem: boolean;
  is_screen_question?: boolean;
  question?: string | null;
  title?: string | null;
  problem_statement?: string | null;
  examples?: LabExample[] | null;
  constraints?: string[] | null;
  function_signature?: string | null;
  confidence: number;
}

/** The text an answer model should see for an extracted problem: the
 *  verbatim screen question, or a coding problem laid out in full. */
export function problemToQuestion(problem: LabProblem): string {
  if (!problem.is_coding_problem && problem.question) return problem.question.trim();
  const parts: string[] = [];
  if (problem.title) parts.push(problem.title);
  if (problem.problem_statement) parts.push(problem.problem_statement);
  (problem.examples ?? []).forEach((ex, i) => {
    const lines = [`Example ${i + 1}:`, `Input: ${ex.input}`, `Output: ${ex.output}`];
    if (ex.explanation) lines.push(`Explanation: ${ex.explanation}`);
    parts.push(lines.join('\n'));
  });
  if (problem.constraints?.length) {
    parts.push(['Constraints:', ...problem.constraints.map((c) => `- ${c}`)].join('\n'));
  }
  if (problem.function_signature) parts.push(problem.function_signature);
  if (!parts.length && problem.question) parts.push(problem.question);
  return parts.join('\n\n').trim();
}

export interface RubricCheck {
  label: string;
  hit: boolean;
}

/** One check per non-empty line. A line passes when the answer contains any
 *  of its `|`-separated alternatives (case-insensitive). */
export function checkRubric(answer: string, rubric: string): RubricCheck[] {
  const haystack = answer.toLowerCase();
  return rubric
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => ({
      label,
      hit: label
        .split('|')
        .map((alt) => alt.trim().toLowerCase())
        .filter(Boolean)
        .some((alt) => haystack.includes(alt)),
    }));
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
