# Live Answer Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve clarity and precision in Friday's streamed technical interview answers.

**Architecture:** Update the existing TypeScript answer-generation prompt and its Python backend mirror in place. Preserve the output contract, first-person voice, project grounding, and live-call scanability; use short examples to define the desired style.

**Tech Stack:** TypeScript prompt module, Python prompt module.

**Spec:** `docs/superpowers/specs/2026-11-08-live-answer-clarity-design.md`

## Global Constraints

- Keep existing output headers and first-person voice.
- Do not add UI, API, persistence, question-detection, or coding-solution changes.
- Use candidate project context for personal examples; otherwise use general examples without implying personal experience.
- Keep TypeScript and Python prompt guidance behaviorally aligned.

## Review Focus

- Short conceptual questions should stay short and state precise distinctions.
- Process questions should give ordered, actionable steps and a concrete check or example when useful.
- PostgreSQL `timestamp` and `timestamptz` explanations should distinguish timezone storage/interpretation accurately.
- Node.js event-loop explanations should use precise phase and microtask terminology.
- Missing candidate context must not cause the prompt to invent personal experience.

---

### Task 1: Tune live answer generation guidance

**Files:**

- Modify: `packages/prompts/answer-generation.ts`
- Modify: `apps/backend/app/prompts/answer_generation.py`

**Interfaces:**

- Consumes: Existing `AnswerContext` / `AnswerContext` dataclasses and current answer output format.
- Produces: Updated system prompt text with matching guidance in both implementations; no public signature changes.

- [ ] **Step 1: Tighten the answer length and structure guidance** in both prompt files. Keep the existing section headers, but make a direct opening answer followed by only the most useful supporting bullets the default for technical responses. Reserve longer explanations for explicit deep dives.
- [ ] **Step 2: Add process-answer guidance and examples** in both prompt files. For CI/versioning or other walkthrough questions, specify ordered actions, what each validates, and a concrete example/check when useful. Use candidate context when available; otherwise label examples as general rather than personal experience.
- [ ] **Step 3: Add terminology precision guidance and examples** in both prompt files for PostgreSQL `timestamp` versus `timestamptz` and Node.js event-loop phases/microtasks. Require precise distinctions and explicit qualification when uncertain.
- [ ] **Step 4: Align the two prompt implementations** by reviewing the relevant sections side by side and confirming equivalent instructions and examples. Do not run or add tests unless separately requested.
- [ ] **Step 5: Review the final diff** to confirm no output headings, prompt interpolation, or unrelated coding/question-detection behavior changed.
