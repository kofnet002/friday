# Screen Reading, Guided Scan, and Packaged Mac App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore complete screen reading for written interview questions and coding tasks, add a user-controlled guided scan for long pages, and package Friday as a standalone Apple Silicon Mac app.

**Architecture:** Preserve the current one-image watcher and extend its extraction contract/API for bounded multi-image scans. Electron captures selected-display frames behind preload IPC; the backend merges them into typed screen content and the UI routes written questions to answers or coding problems to existing tabs. Package the finished stack with Electron Builder and supervised local services.

**Tech Stack:** Electron, Next.js/React, TypeScript, FastAPI/Pydantic, Redis, PyInstaller, Swift, Electron Builder.

**Spec:** `docs/superpowers/specs/2026-11-09-screen-reading-guided-scan-mac-design.md`

## Global Constraints

- Keep the current single-frame watcher and `/api/vision/extract` behavior backward compatible.
- A scan is candidate-controlled: Friday captures while the candidate scrolls; Friday never scrolls or clicks the interview page.
- Use initial scan guardrails from the design: 400 ms sampling, 90 second ceiling, up to 10 distinct scan frames, final capture; tune only with fixture evidence.
- Cap requests at 12 images and 32 MiB decoded total; validate image data before provider calls.
- Preserve provider fallback/usage accounting, function-call assessment, coding verification, project context, privacy mode, and stealth protection.
- Screen-question extraction and answer-context rules must be aligned between Python and TypeScript prompt implementations.
- Source screenshots remain in memory for the scan and are not persisted.
- Redis remains external and optional in the initial DMG, matching current backend behavior; surface a degraded status and document which transient-session features need Redis.
- Initial packaged target is a local Apple Silicon ARM64 DMG; signing/notarization for external distribution is out of scope.
- Keep renderer access to Electron through narrow preload IPC APIs.

## Review Focus

- A legacy one-image request still works and receives the same cache/cooldown behavior — Task 2 request/API tests.
- A written interview question split across views is merged and routed into the answer flow only once — Tasks 2 and 4 tests.
- Overlapping/backtracked frames do not duplicate text, and unreadable examples are not guessed — Task 2 merge tests.
- Time/frame cap, cancellation, and display choice leave the scanner and normal watcher in a well-defined state — Task 3 tests.
- Missing bundled files, unavailable ports, or service startup failure produce a recoverable launch error and clean shutdown — Task 5 packaging/service tests.

---

### Task 1: Restore screen-question and visible-code context

**Files:**

- Modify: `apps/backend/app/models/coding.py`
- Modify: `packages/shared-types/src/index.ts`
- Modify: `packages/prompts/coding-extraction.ts`
- Modify: `apps/backend/app/prompts/coding_extraction.py`
- Modify: `packages/prompts/answer-generation.ts`
- Modify: `apps/backend/app/prompts/answer_generation.py`
- Modify: `apps/backend/app/redis_client.py`
- Modify: `apps/backend/app/api/ws_answer.py`
- Test: `apps/backend/tests/test_screen_context.py`
- Test: `apps/backend/tests/test_answer_prompt.py`
- Test: `apps/backend/tests/test_ws_answer.py`

**Interfaces:**

- Consumes: Existing `ExtractedProblem`, answer context, Redis session state, and answer WebSocket flow.
- Produces: Shared extraction fields `is_screen_question`, `question`, `screen_code`, `completeness`, `missing_sections`; transient screen context available to answer generation.

- [ ] **Step 1: Write failing model and prompt tests.** In `test_screen_context.py`, cover defaults for legacy coding payloads, a readable screen question, visible code, `complete`/`partial`/`uncertain` values, and missing-section names. In `test_answer_prompt.py` and `test_ws_answer.py`, cover answer prompts with/without visible-screen context.
- [ ] **Step 2: Extend the Pydantic and TypeScript extraction types** with `is_screen_question: boolean`, nullable `question` and `screen_code`, `completeness: 'complete' | 'partial' | 'uncertain'`, and `missing_sections: string[]`. Give legacy fields safe defaults where necessary.
- [ ] **Step 3: Update the Python and TypeScript extraction prompts in sync.** Require complete question context, verbatim code/signature transcription, exact examples/symbols, explicit partial status, and no guessed text. Align both prompt version constants at `1.4.0`.
- [ ] **Step 4: Restore session screen context in the answer path.** Add a `screen_context` field to both answer-context implementations, wrap it in a dedicated prompt block with instructions to use it only when relevant, store extracted text in Redis, and load it for answer requests.
- [ ] **Step 5: Run Task 1 tests.** Run: `uv run pytest tests/test_screen_context.py tests/test_answer_prompt.py tests/test_ws_answer.py -q` from `apps/backend`. Expected: PASS; legacy answer prompts remain unchanged when no screen context exists.

### Task 2: Add bounded multi-image extraction and merge

**Files:**

- Modify: `apps/backend/app/api/vision.py`
- Modify: `apps/backend/app/services/coding_extraction.py`
- Modify: `apps/backend/app/prompts/coding_extraction.py`
- Modify: `packages/prompts/coding-extraction.ts`
- Test: `apps/backend/tests/test_vision_scan.py`
- Test: `apps/backend/tests/test_coding_solution_prompt.py`

**Interfaces:**

- Consumes: Task 1 extraction shape and current single-image API/service.
- Produces: `ExtractRequest` accepting exactly one source: `image_base64` or ordered `images_base64`; scan-only `scan_cropped` metadata; multi-frame extraction plan and merge rules; response/event source metadata (`single_frame` or `guided_scan`).

- [ ] **Step 1: Write failing API and extraction tests.** Cover exactly-one-image-source validation; 12-image and 32 MiB limits; invalid/empty base64; scan cache/cooldown bypass; unchanged single-image behavior; provider input order; merge of overlap/backtracking; screen-question event and screen context; and unreadable examples marked incomplete rather than guessed.
- [ ] **Step 2: Implement request validation and compatibility** in `vision.py`. Decode every image strictly, enforce count and aggregate byte limits before provider calls, bypass cache/cooldown for explicit scans, and keep single-image request shape and response behavior working.
- [ ] **Step 3: Implement multi-frame extraction planning** in `coding_extraction.py`. Pass ordered images to supported providers, retain fallback and token accounting, select a larger output budget for scans, and append the scan/crop instructions only for scans. Keep function-call detection on its existing single-frame path.
- [ ] **Step 4: Route merged results.** Store useful question/problem/code text in screen context; publish written questions with source and completeness metadata; publish coding results with the existing fingerprint and fragment-suppression behavior.
- [ ] **Step 5: Run Task 2 tests.** Run: `uv run pytest tests/test_vision_scan.py tests/test_coding_solution_prompt.py -q` from `apps/backend`. Expected: PASS; existing one-frame vision tests also pass.

### Task 3: Implement guided frame capture in Electron

**Files:**

- Create: `apps/desktop/scan.js`
- Modify: `apps/desktop/coding.js`
- Modify: `apps/desktop/main.js`
- Modify: `apps/desktop/preload.js`
- Modify: `apps/web/types/friday.d.ts`
- Test: `apps/desktop/scan.test.js`
- Test: `apps/desktop/coding.test.js`

**Interfaces:**

- Consumes: Task 2 `images_base64` request and current `CodingCapture` watcher.
- Produces: Preload methods for start/finish/cancel/status and scan-state subscription; scan-state payload `{state, frames, displayId?, limitReached?, error?}`.

- [ ] **Step 1: Write failing pure selector tests** for first/final frame retention, duplicate/novel position selection, motion sampling, a changing small screen region, frame cap, and final-frame inclusion.
- [ ] **Step 2: Implement `ScanSelector`, pane detection, and image preparation** in `scan.js`, starting from `origin/the-weekend` behavior but keeping functions pure where possible. Retain one whole-display context frame and crop the scrolling region only when detection confidence is high.
- [ ] **Step 3: Write failing `CodingCapture` tests** for start/finish/cancel, normal-watcher pause/resume, automatic partial submission at the time/frame cap, and failure cleanup.
- [ ] **Step 4: Implement scan lifecycle** in `coding.js`. Preserve the normal watcher, retain frames in memory, include the final capture, submit one multi-image request, and resume the watcher after every terminal state.
- [ ] **Step 5: Add display selection and IPC.** Default to the primary display; expose available display IDs/labels through preload and persist the user selection. Add the guided-scan shortcut and typed scan-state events in `main.js`, `preload.js`, and `friday.d.ts`.
- [ ] **Step 6: Run Task 3 tests.** Run: `pnpm --filter @friday/desktop test`. Expected: PASS without requiring an actual display capture.

### Task 4: Add scan and extraction states to the session UI

**Files:**

- Modify: `apps/web/app/session/coding-panel.tsx`
- Modify: `apps/web/app/session/session-client.tsx`
- Modify: `packages/shared-types/src/index.ts`
- Create: `apps/web/lib/screen-question-routing.js`
- Test: `apps/web/lib/screen-question-routing.test.js`

**Interfaces:**

- Consumes: Task 1 screen-question/coding completeness fields and Task 3 scan-state API.
- Produces: Visible Scan/Finish/Cancel flow; partial/complete/error feedback; complete screen questions auto-submitted once through existing `askAnswer` flow; partial questions require explicit `Answer captured text` or `Scan again`.

- [ ] **Step 1: Write failing event-routing tests** for `screenQuestionAction(question, completeness, recentUserQuestion) -> 'answer' | 'review' | 'ignore'`: complete unique questions answer, complete recent duplicates ignore, and partial/uncertain questions require review. Compare duplicate text case-insensitively after trimming outer whitespace. Keep coding same-fingerprint tab replacement covered by existing `session-client` behavior and backend scan event tests.
- [ ] **Step 2: Add scan control and status UI** with idle, capturing, combining, complete, partial, and failed states; show frame count, selected display, finish/cancel controls, and actionable errors.
- [ ] **Step 3: Add completeness feedback** that names missing sections and offers a rescan/re-extract action. For partial written questions, show captured text with `Answer captured text` and `Scan again` actions. Keep existing coding tabs, project context, privacy masking, and compact overlay layout.
- [ ] **Step 4: Route screen questions** through the current answer flow once, preserving its prior duplicate-question guard; route coding results through current fingerprint/tab behavior.
- [ ] **Step 5: Verify accessibility and types.** Confirm keyboard operation, text/icon state cues, accessible labels, disabled semantics, and click-through surfaces; run `node --test lib/screen-question-routing.test.js` from `apps/web` and `pnpm --filter @friday/web typecheck`.

### Task 5: Restore packaged ARM64 Mac build

**Files:**

- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/main.js`
- Modify: `apps/web/next.config.mjs`
- Modify: `apps/backend/package.json`
- Create: `apps/backend/packaging/friday-backend.spec`
- Create: `apps/desktop/services.js`
- Create: `apps/desktop/scripts/stage-bundle.js`
- Create: `apps/desktop/scripts/after-pack.js`
- Test: `apps/desktop/services.test.js`
- Test: `apps/desktop/packaging.test.js`
- Modify: `README.md`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: Completed screen-reading UI, existing Electron shell, backend, Next app, native stealth module, and Swift audio helper.
- Produces: `pnpm --filter @friday/desktop dist` creating an ARM64 DMG with a self-starting local backend/web stack.

- [ ] **Step 1: Write failing packaging/service tests** for local module inclusion, bundle staging paths, missing resource diagnostics, service readiness/failure, environment-file permissions, child-process shutdown, and successful startup with Redis unavailable plus a visible degraded status.
- [ ] **Step 2: Configure build artifacts.** Enable Next standalone output, define the PyInstaller backend spec/build script, add Electron Builder files/resources/DMG configuration, and preserve required native/Sharp assets and Next standalone symlinks.
- [ ] **Step 3: Implement service supervision.** Resolve bundled paths, create first-run `.env` with mode `0600`, use per-user database/log paths, check localhost ports, start backend and web server, await readiness, surface startup errors, and stop services during quit/signals.
- [ ] **Step 4: Implement bundle staging and after-pack copying** for backend, Next standalone/static/public assets, Swift helper, and env template. Keep development mode on the existing `pnpm dev` services.
- [ ] **Step 5: Document local ARM64 packaging** and first launch/API-key/permission/Redis setup in `README.md`; state that Redis-backed transient context needs Redis and public distribution signing/notarization is not configured.
- [ ] **Step 6: Run Task 5 tests.** Run: `pnpm --filter @friday/desktop test` and `pnpm --filter @friday/desktop dist` on Apple Silicon. Expected: tests pass and a DMG launches without a development server; verify first-run config, services, both Redis-present and Redis-absent status, capture permission, and clean shutdown.

## Completion checks

- Run the backend suite: `uv run pytest -q` from `apps/backend`.
- Run workspace typechecks: `pnpm typecheck`.
- Run the Electron unit tests: `pnpm --filter @friday/desktop test`.
- Build and manually launch the ARM64 DMG without `pnpm dev`; verify a multi-screen written question and a long coding problem through guided scan.
- Review staged/working-tree diff for accidental changes to existing user data and ensure no `Co-authored-by` trailer is added unless explicitly requested.
