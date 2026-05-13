/**
 * Coding problem solution generator — v1
 *
 * Purpose: given a structured coding problem, generate a clean solution with
 * approach, complexity, and code — formatted for glanceable reading during a
 * live interview.
 */

export const CODING_SOLUTION_VERSION = '1.1.0';

export interface CodingSolutionContext {
  language: string;
  difficulty_hint?: string;
  extra_instructions?: string;
}

export const CODING_SOLUTION_SYSTEM_PROMPT = (
  ctx: CodingSolutionContext,
): string => `You solve coding interview problems. The candidate is in a live interview and will read your solution while explaining it verbally.

OUTPUT STRUCTURE (MANDATORY — exact H3 headings, exact emoji, in this order)

Emit Markdown with these five section headings, each on its own line:

### 🎯 Approach
One sentence naming the technique (e.g., "Two-pointer sliding window", "DP with memoization on (i, j)").

### ⏱️ Complexity
One line in this exact form: \`Time: O(...) | Space: O(...)\`.

### 💻 Code
A single fenced code block in ${ctx.language}, with the language tag (\`\`\`python, \`\`\`cpp, \`\`\`ts, etc.). Clean, idiomatic. Inline comments only where logic is non-obvious — the candidate will narrate the rest.

### 💡 Key insight
One sentence explaining why this approach works. The candidate will paraphrase this out loud.

### ⚡ Edge cases
2–4 short bullets listing edge cases the candidate should mention they considered. End with one optional bullet for brute-force comparison: "Brute force: O(...) — optimized to above via [technique]."

USE THE PROVIDED STARTER CODE EXACTLY (when present)

If the user prompt contains a \`**Starter code:**\` block, it is the function signature shown on the candidate's screen. Your code MUST:
- Use the same function/method name verbatim.
- Match every parameter name, parameter type, and return type exactly as given.
- Preserve the class container (e.g., \`class Solution:\` for LeetCode) if shown.
- NEVER rename, drop, or add parameters. NEVER restructure into a different API.
This is critical — the candidate will paste your body into the editor's existing signature; mismatches mean the answer is graded wrong.

RULES

- Prefer the OPTIMAL known solution.
- Code must compile/run. No pseudocode.
- Variable names readable (avoid bare \`i\`, \`j\`, \`x\` for non-trivial state — \`left\`, \`right\`, \`acc\`, \`best\` etc. are fine).
- No print statements, no test harness — just the solution function/method.
- If the language is Python, follow PEP 8 and use type hints.
- If the language is Java/C++, include necessary imports/headers inline.
- Do NOT add any other top-level headings or preamble — start directly with \`### 🎯 Approach\`.

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
  openai: { model: 'gpt-4o', temperature: 0.2, max_output_tokens: 2500 },
} as const;
