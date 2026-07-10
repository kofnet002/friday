# Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Friday's one-model-per-provider selector with a validated catalog of selectable model IDs.

**Architecture:** Keep provider adapters unchanged where possible, add a shared model catalog describing provider and capabilities, and carry the selected model ID through session configuration and answer/coding requests. Environment variables remain defaults and fallback settings.

**Tech Stack:** FastAPI/Pydantic, TypeScript, React/Next.js, pytest, TypeScript compiler.

---

### Task 1: Define the shared model catalog

**Files:**

- Create: `packages/shared-types/src/models.ts`
- Modify: `packages/shared-types/src/index.ts`
- Test: `packages/shared-types/src/models.test.ts`

- [ ] Add catalog entries and `ModelId`/`ModelOption` types for existing models plus GPT-5.5/GPT-5.6.
- [ ] Add tests for provider lookup and capability filtering.
- [ ] Export the catalog from the package.

### Task 2: Add model-aware backend validation

**Files:**

- Create: `apps/backend/app/models/catalog.py`
- Modify: `apps/backend/app/settings.py`
- Modify: `apps/backend/app/api/sessions.py`
- Modify: `apps/backend/app/api/ws_answer.py`
- Modify: `apps/backend/app/services/answer.py`
- Test: `apps/backend/tests/test_model_catalog.py`

- [ ] Mirror the catalog IDs in Python and validate selected IDs before provider calls.
- [ ] Preserve `OPENAI_MODEL`, `GEMINI_MODEL`, and other env defaults when no session model is selected.
- [ ] Pass the selected model into the existing provider streamers.
- [ ] Reject unknown or incompatible model IDs with actionable errors.
- [ ] Add tests for lookup, provider inference, default fallback, and invalid models.

### Task 3: Carry selected models through shared session protocols

**Files:**

- Modify: `packages/shared-types/src/index.ts`
- Modify: `apps/web/lib/session-context.ts`
- Modify: `apps/web/app/session/session-client.tsx`
- Test: `apps/web/lib/session-context.test.ts`

- [ ] Store a model ID alongside the existing provider preference.
- [ ] Include the selected model in answer and coding request payloads.
- [ ] Keep old sessions without a model valid by deriving the model from the provider default.

### Task 4: Replace hardcoded UI options with grouped model options

**Files:**

- Modify: `apps/web/app/session/answer-panel.tsx`
- Modify: `apps/web/app/session/coding-panel.tsx`
- Modify: `apps/web/app/setup/setup-form.tsx`

- [ ] Render models grouped by provider with model labels from the catalog.
- [ ] Persist the selected model and keep provider/model state synchronized.
- [ ] Disable or filter models that do not support the current vision/coding workflow.
- [ ] Show the configured model label in status and latency displays.

### Task 5: Verify and document configuration

**Files:**

- Modify: `.env.example`
- Modify: `README.md`

- [ ] Document model IDs, defaults, and the fact that preview models require account access.
- [ ] Run targeted backend/frontend tests, typecheck, and the desktop/web build checks.
- [ ] Confirm existing provider defaults and fallback tests remain green.
