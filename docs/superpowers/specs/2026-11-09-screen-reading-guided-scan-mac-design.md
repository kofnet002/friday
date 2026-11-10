# Screen Reading, Guided Scan, and Packaged Mac App Design

## Intent

Use the useful screen-reading and packaging work on `origin/the-weekend` as a reference to improve the current `develop` app. Make reading content that extends beyond one viewport reliable, especially coding problems with examples, constraints, and starter code. Bring back support for written interview questions on screen, make capture progress and completeness clear in the desktop UI, and produce a usable packaged Mac app.

## Current state and relevant history

- Current `apps/desktop/coding.js` captures the primary display approximately once a second, uses an 8×8 visual hash to decide whether to send a frame, and posts one image to `/api/vision/extract`.
- Current `apps/backend/app/api/vision.py` extracts coding problems and optionally performs a second pass for function-call assessments. The current `ExtractedProblem` does not represent ordinary written screen questions or visible code context.
- Current `apps/web/app/session/coding-panel.tsx` can warn that the visible screenshot may be partial and suggests scrolling and re-extracting. It cannot combine several screen positions.
- Current `apps/desktop/main.js` loads the local web server at `127.0.0.1:3333`; `apps/desktop/package.json` has no packaged distribution target.
- Redis is an existing external prerequisite for full functionality in the README, although `redis_client.py` treats it as optional and degrades to no-op transient state when unavailable. The old packaged-service supervisor starts the backend and web app but does not start Redis.
- `origin/the-weekend` contains a guided scroll scan: samples while the user scrolls, keeps distinct frames, retains the final view, crops a likely scrolling pane, submits several images together, and exposes Scan/Finish progress in the coding panel. Its vision model also represented written screen questions and code visible outside coding problems.
- That branch also contains an Electron Builder ARM64 DMG pipeline. It stages a PyInstaller backend, Next.js standalone server and static files, and the Swift audio helper; packaged services start on localhost and are supervised by Electron. Its ad-hoc signing identity and disabled hardened runtime indicate a local-use package rather than a public notarized release.
- Current `develop` contains later work such as project context, function-call assessment, and coding verification. The old feature implementation should be adapted around those improvements, not restored wholesale.

## Goals

- Read a full long coding prompt while the candidate scrolls once through it.
- Reconstruct screen content in document order, remove overlap, and accurately retain examples, constraints, special characters, and the full editor signature.
- Read ordinary written interview questions across one or more screen positions and make them available to the answer flow.
- Report whether an extraction appears complete; show partial or uncertain results honestly.
- Provide a clear, keyboard-accessible guided scan flow in the compact desktop UI without moving the interview page on the candidate's behalf.
- Restore a packaged ARM64 Mac app that starts its bundled web and backend services without a development server.
- Preserve the current single-frame watcher, function-call assessment, project context, coding verification, privacy/stealth behavior, and session limits.

## Non-goals

- Have Friday automatically scroll, click, or otherwise control the interview page.
- Replace Electron or add browser-specific DOM integrations.
- Change how generated coding solutions are produced, run, or refined.
- Build a universal Intel/Apple Silicon package or public notarized distribution in the first pass.
- Persist raw screenshot frames after the scan request completes.

## Approaches

1. **Repeat single-frame capture.** Ask the candidate to scroll and press Re-extract for each section. This is a small change, but leaves the candidate responsible for merging the prompt and makes the coding workflow fragmented.
2. **Drive automatic page scrolling.** Friday scrolls the target page and captures it from top to bottom. This reduces manual work but can disrupt the live interview, is difficult to target reliably across applications, and needs extra macOS accessibility behavior.
3. **Guided scan (selected).** The candidate starts a scan, scrolls normally, and finishes with a control or shortcut. Friday automatically captures distinct views and merges them. This was selected in the conversation because it improves completeness while leaving the interview page under the candidate's control.

## Proposed design

### 1. Guided capture

Extend the desktop coding capture coordinator with explicit `start`, `finish`, `cancel`, and status operations. While scanning, sample the selected display at a faster rate than the normal watcher; default to the primary display and let the user choose another when several are connected. Use visual signatures to keep novel positions, avoid duplicates, and retain the final position even when the candidate stops quickly. Pause the normal watcher while a scan is active and resume it after success, failure, or cancellation.

Use the old scan implementation as a measured starting point: 400 ms sampling, a 90 second ceiling, up to 10 distinct scan frames, a final capture, and pane cropping only when the changed region is confidently smaller than the display. Preserve a whole-screen reference frame when cropping. These values are initial guardrails, not guarantees; use fixtures and local captures to tune them. When a time or frame cap is reached, automatically submit the captured views as partial and report the limit in the UI; do not discard captured work or label it complete.

The capture API remains behind Electron preload and IPC. Keep renderer access narrow: the page can request scan operations and subscribe to scan state, but cannot access Electron APIs directly. Keep screen capture memory-only and send images only to the configured vision provider through the local backend.

### 2. Multi-view extraction and content model

Extend `/api/vision/extract` to accept either its current single image or an ordered, bounded list for an explicit scan. Validate base64, image count, and aggregate decoded size before provider calls. Explicit scans bypass the single-frame image cache/cooldown, while the regular watcher keeps its current behavior.

Adapt the `origin/the-weekend` merge instructions: treat frames as views of one document, combine overlapping text once, order content by document position rather than capture timestamp, use the clearest view of each example or code block, and ignore repeated fixed screen regions. Keep one provider call over all images initially to preserve cross-frame context; retain provider fallback and usage accounting. If evidence shows the model misses content or exceeds the image budget, evaluate per-frame extraction followed by a structured merge as a later alternative.

Extend the extraction contract in both Python and TypeScript prompt/schema definitions to represent:

- Coding problems: statement, title/platform/difficulty, examples, constraints, full starter signature, and visible user code.
- Written interview questions: the complete visible question and its necessary scenario/data, rather than only the final sentence.
- Completeness: `complete`, `partial`, or `uncertain`, with any known missing sections such as examples, constraints, or signature.
- Confidence and capture source, so the UI can explain whether content came from one frame or a guided scan.

Keep function-call assessment as its existing separate second-pass route. Store useful extracted text in session screen context; do not store source images. Complete written screen questions should enter the existing answer flow once, with the same duplicate-question protection used by the prior branch. Partial or uncertain questions should be shown for review with a rescan action; let the candidate explicitly choose to answer the captured portion. Coding content should create or update the existing coding tab without creating truncated duplicate tabs.

### 3. Desktop UI and interaction

Add an explicit Scan control to the coding panel and a discoverable keyboard shortcut. When multiple displays are connected, allow selecting which display to scan and remember the selection; default to the primary display. Use clear states: idle, capturing (including frame count and guidance), combining/reading, complete, partial, and failed. Finish and cancel should remain visible and operable; processing should disable duplicate submissions and expose an actionable error near the scan control.

Show an honest completeness summary after extraction. When partial, identify what appears missing and offer another scan or a focused re-extract. For a partial written question, show the extracted text and provide explicit `Answer captured text` and `Scan again` actions; do not silently answer a truncated question. Keep the current compact overlay hierarchy and existing coding tabs. Use text/icon as well as color for state, accessible labels and pressed/disabled semantics, and preserve click-through behavior outside explicit interactive surfaces. Keep privacy mode and capture protection effective while scan UI is open.

### 4. Packaged Mac app

Restore a reproducible `dist` pipeline based on the existing Electron architecture: build the Next.js standalone app, PyInstaller backend, Swift audio helper, native stealth module and icon; stage them under desktop bundle resources; build an ARM64 DMG with Electron Builder. In packaged mode, start bundled services on loopback, wait for readiness, write the per-user environment file with restrictive permissions, log to the user's app log directory, and stop child services with the app. Redis remains an external optional service for this first pass; show a clear status when it is missing and document that full transient-session features require it. Development mode continues to use `pnpm dev`.

Initial distribution assumption: local Apple Silicon installation, matching the repo's personal/experimental scope. Public distribution, Developer ID signing, notarization, and auto-update are outside this first pass and need a separate decision if the app will be shared.

## Work order

1. **Screen-read contract and evaluation fixtures:** cover written questions, code-only screens, long coding prompts, overlapping frames, unreadable/truncated examples, missing signatures, and false detections. Keep Python and TypeScript prompt/schema versions aligned.
2. **Guided scan capture and API:** add capture state, bounded multi-image request validation, frame ordering, merge prompt, and event delivery while preserving one-frame behavior.
3. **Coding and question UI:** add scan controls, progress/finish/cancel/error states, completeness feedback, and route written questions into answers.
4. **Packaged app restoration:** bundle services, smoke-test a clean ARM64 DMG without a running development stack, and validate permission, first-run configuration, logs, upgrade data preservation, and clean shutdown.

## Success criteria

- A long coding fixture split across several viewports produces one problem with each readable example, constraint, special character, and the complete starter signature represented once and in order.
- A written interview question split across viewports is reconstructed once with its scenario and requested deliverables intact.
- When a scan misses content, the UI reports partial/uncertain and gives a clear recovery action rather than presenting a truncated result as complete.
- The normal single-frame watcher, function-call route, project context, and coding self-verification continue to work.
- A clean ARM64 DMG launches its own local services without a dev server, handles first-run configuration, and shuts down without leaving service processes behind.
- Keyboard users can start, finish, and cancel a scan; scan status is understandable without color alone.

## Open assumptions for review

- Include ordinary written interview questions as well as coding tasks in screen reading; this follows the old branch's behavior and the request's mention of questions.
- Let the candidate select a display, defaulting to the primary display, when using multiple monitors.
- Target a local Apple Silicon DMG first. If the app is intended for other users, signing and notarization must move into scope before packaging work begins.
- Keep Redis external and optional in the initial package, consistent with current backend behavior; bundling Redis or replacing it is a separate scope decision.
- The capture remains user-controlled; Friday never scrolls or clicks in the interview page.
