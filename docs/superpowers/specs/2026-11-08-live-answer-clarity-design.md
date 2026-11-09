# Live Answer Clarity Design

## Intent

Tune Friday's live interview answers to address the supplied feedback: clearer structure, more concise technical explanations, concrete examples, actionable steps for process questions, and precise PostgreSQL and Node.js terminology. The candidate should be able to glance at the answer and speak naturally from it.

## Goals

- Keep the existing first-person, glanceable answer format.
- Lead with a direct answer, then add only the most useful supporting detail.
- For process and architecture questions, give ordered, concrete steps and a concise example when useful.
- Use accurate technical distinctions and terminology; avoid guessing when uncertain.
- Ground project answers in supplied context and avoid inventing experience or implementation details.

## Non-goals

- Add an interview practice mode, new UI, or new API behavior.
- Change question detection, coding solution generation, models, or answer transport.
- Turn every answer into a long tutorial or require examples when they would add noise.

## Approaches

1. **Tune the live answer prompts (selected).** Update the prompt guidance and illustrative answer shapes in both `packages/prompts/answer-generation.ts` and its Python mirror, `apps/backend/app/prompts/answer_generation.py`. This fits Friday's existing architecture and directly targets the feedback.
2. **Add an interview practice feature.** Useful for building these skills before an interview, but requires a separate user flow and is outside the selected live-answer scope.
3. **Tune live answers and add practice.** Covers both immediate and long-term needs, but expands the change beyond the requested scope.

## Design

For technical answers, direct the model to answer the question in one clear opening statement, then use a small number of focused bullets. For “walk me through” and process questions, prefer ordered steps with concrete actions and an example or validation check where relevant. Keep definitions and comparisons short, state the distinction precisely, and qualify uncertainty instead of presenting a muddled explanation as fact. Use the candidate's project context for examples when available; otherwise use a clearly general example without implying the candidate personally implemented it.

Preserve existing output headers and first-person voice. Adjust the total length guidance so concise answers are preferred while allowing additional detail when the question genuinely calls for a technical deep dive. Add representative examples covering CI/versioning steps, PostgreSQL `timestamp` versus `timestamptz`, and Node.js event-loop terminology. Keep TypeScript and Python prompt text behaviorally aligned.

## Constraints and success criteria

- Prompt-only change; no UI, API, or persistence changes.
- Existing prompt format remains valid for the current streaming answer panel.
- The examples make the intended answer shape concrete without hard-coding claims about the candidate's own experience.
- Both prompt implementations encode the same guidance.

## Builder choices

- Exact word counts and example phrasing remain implementation choices; favor short answers first and retain room for genuinely complex questions.
- Prompt version should be incremented consistently in both implementations if the repository's prompt versioning conventions require it.
