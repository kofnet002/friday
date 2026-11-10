# Packaged App Startup and Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the packaged backend startup, add GitHub Releases automatic updates, and provide commands to rebuild or publish updated Mac packages.

**Architecture:** Run PyInstaller inside the backend project environment so runtime dependencies are collected into the app. Use `electron-updater` in packaged builds only, with the GitHub Releases provider; build both DMG and ZIP, and keep local packaging separate from publishing.

**Tech Stack:** Python 3.11, PyInstaller, Electron, electron-updater, Electron Builder, GitHub Releases.

**Spec:** `docs/superpowers/specs/2026-11-10-packaged-updates-design.md`

## Global Constraints

- Keep the target Apple Silicon ARM64.
- Never embed GitHub or Apple credentials in the application bundle.
- Do not run update checks in development mode.
- Preserve app startup and shutdown management for the bundled backend and web server.
- The first signed release requires a manual install over the current unsigned DMG.
- Redis remains optional, and provider keys stay in the per-user `.env`.

## Review Focus

- PyInstaller must resolve `uvicorn` and all runtime dependencies from the project environment; backend build smoke check must reach `/healthz`.
- Starting the packaged app with development servers already bound to ports 8000/3333 must retain the existing actionable error instead of attaching to the wrong services.
- An update check/network failure must not prevent Friday from opening or stop its bundled services.
- Development builds must never contact GitHub Releases.
- A release build must produce both DMG and ZIP assets and must fail before publishing when the required version/token/signing setup is absent.

---

### Task 1: Fix packaged backend dependency collection

**Files:**

- Modify: `apps/backend/pyproject.toml`
- Modify: `apps/backend/package.json`
- Modify: `apps/backend/uv.lock`
- Modify: `apps/backend/packaging/friday-backend.spec`
- Test: packaged-backend build and `/healthz` smoke check

**Interfaces:**

- Consumes: backend runtime dependencies declared in `apps/backend/pyproject.toml`.
- Produces: `apps/backend/dist/friday-backend/friday-backend`, a runnable bundled executable whose `/healthz` endpoint returns success.

- [x] **Step 1: Capture the regression.** Add a packaging smoke script/test that starts the built executable with a temporary SQLite path, waits for `/healthz`, and fails with captured stderr if the process exits before readiness.
- [x] **Step 2: Verify the smoke check fails against the current artifact** with the missing `uvicorn` import from the user log.
- [x] **Step 3: Put the pinned PyInstaller dependency in a backend build dependency group and invoke it through the project environment** (`uv run --group build pyinstaller ...`) so PyInstaller analysis sees installed runtime packages; preserve the existing app hidden imports and collection options.
- [x] **Step 4: Rebuild and run the smoke check.** Expected: the executable serves `/healthz` and shuts down cleanly.

### Task 2: Add packaged GitHub Releases updater

**Files:**

- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/main.js`
- Create: `apps/desktop/updater.js`
- Test: `apps/desktop/updater.test.js`

**Interfaces:**

- Consumes: Electron `app`, `dialog`, and `electron-updater` `autoUpdater`.
- Produces: `setupAutoUpdates({ app, autoUpdater, dialog, logger })`; returns `checkForUpdates()` and starts packaged-only checks after the main window is ready.

- [x] **Step 1: Write tests** for development no-op, packaged check, non-blocking check errors, update-downloaded restart confirmation, defer-to-next-quit behavior, and manual check.
- [x] **Step 2: Run tests and confirm the new updater tests fail because `setupAutoUpdates` is absent.**
- [x] \*\*Step 3: Add `electron-updater`, configure GitHub owner `kofnet002` and repo `friday`, enable automatic download, notify after download, and connect updater state to the main-process dialog and tray menu without delaying service startup.
- [x] **Step 4: Run the desktop updater and existing desktop tests.** Expected: all pass; development mode does not initiate network requests.

### Task 3: Add DMG rebuild and GitHub release commands

**Files:**

- Modify: `apps/desktop/package.json`
- Modify: `apps/desktop/package.json` Electron Builder targets and publish configuration
- Modify: `pnpm-lock.yaml`
- Modify: `README.md`
- Test: package-script/config assertions in `apps/desktop/packaging.test.js`

**Interfaces:**

- Consumes: Task 2 GitHub updater config and the existing web/backend/Swift staging pipeline.
- Produces: `pnpm --filter @friday/desktop dist` (rebuild local ARM64 DMG and updater ZIP) and `pnpm --filter @friday/desktop release:mac` (publish a versioned build to GitHub Releases using `GH_TOKEN`).

- [x] **Step 1: Write tests** asserting the package config emits DMG plus ZIP, the GitHub Releases provider targets `kofnet002/friday`, and build/release scripts remain separate.
- [x] **Step 2: Run the package tests and confirm they fail against the current DMG-only/no-publisher configuration.**
- [x] **Step 3: Split the existing build pipeline into a shared prepare step, local `dist` build with publish disabled, and `release:mac` build with publish enabled.** Require a bumped package version and `GH_TOKEN`; keep actual publishing an explicit command.
- [x] **Step 4: Document local rebuild, release prerequisites, signing/notarization secrets, first signed install, GitHub release process, and per-user API key setup.**
- [x] **Step 5: Run desktop tests, typecheck, local ARM64 package, inspect DMG/ZIP outputs, and verify `git diff --check`.** Do not publish a GitHub release during implementation.
