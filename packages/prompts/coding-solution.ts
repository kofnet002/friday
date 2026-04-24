/**
 * Coding problem solution generator — v1
 *
 * Purpose: given a structured coding problem, generate a clean solution with
 * approach, complexity, and code — formatted for glanceable reading during a
 * live interview.
 */

export const CODING_SOLUTION_VERSION = '1.0.0';

export interface CodingSolutionContext {
  language: string;
  difficulty_hint?: string;
  extra_instructions?: string;
}

export const CODING_SOLUTION_SYSTEM_PROMPT = (
  ctx: CodingSolutionContext,
): string => `You solve coding interview problems. The candidate is in a live interview and will read your solution while explaining it verbally.

OUTPUT STRUCTURE (strict — the candidate's eyes will scan in this order)

1. **Approach** — one sentence naming the technique (e.g., "Two-pointer sliding window", "DP with memoization on (i, j)").
2. **Complexity** — one line: "Time: O(...) | Space: O(...)".
3. **Code** — a single fenced block in ${ctx.language}. Clean, idiomatic, no comments except where logic is non-obvious.
4. **Key insight** — one sentence explaining why this approach works. The candidate will paraphrase this out loud.
5. **Edge cases** — 2-4 bullets listing edge cases the candidate should mention they considered.

RULES

- Prefer the OPTIMAL known solution. If brute force is worth mentioning, add one bullet at the end: "Brute force: O(...) — optimized to above via [technique]."
- Code must compile/run. No pseudocode.
- Variable names readable (not \`i\`, \`j\`, \`x\`). 
- No print statements, no test harness — just the solution function.
- If the problem has multiple optimal approaches (e.g., DP vs greedy), pick one and mention the alternative in one bullet.
- If the language is Python, follow PEP 8 and use type hints.
- If the language is Java/C++, include necessary imports/headers inline.

LENGTH TARGET: 250-500 words total including code.${ctx.extra_instructions ? `\n\nADDITIONAL INSTRUCTIONS:\n${ctx.extra_instructions}` : ''}`;

export const CODING_SOLUTION_USER_TEMPLATE = (problem: {
  title?: string | null;
  problem_statement: string;
  examples?: Array<{ input: string; output: string; explanation?: string | null }> | null;
  constraints?: string[] | null;
  function_signature?: string | null;
}): string => {
  const parts: string[] = [];
  if (problem.title) parts.push(`**${problem.title}**\n`);
  parts.push(problem.problem_statement);
  if (problem.examples?.length) {
    parts.push('\n**Examples:**');
    problem.examples.forEach((ex, i) => {
      parts.push(
        `Example ${i + 1}:\nInput: ${ex.input}\nOutput: ${ex.output}${ex.explanation ? `\nExplanation: ${ex.explanation}` : ''}`,
      );
    });
  }
  if (problem.constraints?.length) {
    parts.push('\n**Constraints:**\n' + problem.constraints.map((c) => `- ${c}`).join('\n'));
  }
  if (problem.function_signature) {
    parts.push(`\n**Starter code:**\n\`\`\`\n${problem.function_signature}\n\`\`\``);
  }
  return parts.join('\n');
};

export const CODING_SOLUTION_CONFIG = {
  gemini: { model: 'gemini-2.5-flash', temperature: 0.2, max_output_tokens: 2500 },
  openai: { model: 'gpt-5', temperature: 0.2, max_output_tokens: 2500 },
} as const;
