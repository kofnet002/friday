---
name: run-desktop
description: Launch and drive the real Friday desktop app (Electron) to smoke-test a change — screen mode, guided scan, answers, model pickers. Use when asked to run, test, or screenshot the app, or to confirm a change works end to end rather than only in unit tests.
---

# Run and drive the Friday desktop app

`apps/desktop/scripts/drive.mjs` launches the dev Electron app under Playwright
and reads one command per line from stdin. Launch it once, then send commands
through a FIFO so each step's result can be checked before the next.

## 1. Start the services

The Electron app loads the web app from `:3333` and calls the backend on `:8000`.
Redis must be running (`redis-cli ping`). Run each in the background:

```bash
cd apps/backend && uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 > "$OUT/backend.log" 2>&1
cd apps/web && npx next dev --port 3333 > "$OUT/web.log" 2>&1
```

Wait for `curl -s 127.0.0.1:8000/health` and a 200 from `127.0.0.1:3333/session`.
The backend has no `--reload` here: restart it after backend changes. Restart the
app (`quit`, relaunch) after desktop (`apps/desktop/*.js`) changes.

## 2. Launch the driver

```bash
OUT=<scratch dir>; mkfifo "$OUT/cmd.fifo"
tail -f "$OUT/cmd.fifo" | node apps/desktop/scripts/drive.mjs --out "$OUT" > "$OUT/driver.log" 2>&1   # background
```

Wait for `ready` in `driver.log`, then send commands:

```bash
echo "click Assist" > "$OUT/cmd.fifo"
```

Commands: `shot <name>`, `buttons`, `click <exact name>`, `clickp <name start>`,
`select <aria-label> <value>`,
`text [css]`, `status`, `watch`, `testpage <file>`, `evalPage <js>`,
`evalMain <js body>`, `wait <ms>`, `quit`. Results and errors go to
`driver.log`; screenshots go to `$OUT/<name>.png`. Always look at the screenshots.

## 3. Smoke-test screen mode / guided scan

`fixtures/assessment-scan.html` is a long page with a preamble, a table and three
multiple-choice questions. It waits 5 s after loading, then scrolls ~70% of a
screen every 2.2 s, pausing like a reader, and stops at the bottom.

**Open fixtures for a scan in the separate viewer, not with `testpage`.** Every
capture Friday makes hides all of Friday's own windows, and the driver's
`testpage` window belongs to Friday's Electron process, so a scan can't see it:
it records no motion and ends idle after 12 s. `fixture-viewer/` is a tiny
separate Electron app (a different process, like a real browser) that fills the
primary display with the page. Start it from the repo root in the background, and
start the scan within a couple of seconds: the fixtures begin scrolling 5 s after
they load.

```bash
apps/desktop/node_modules/.bin/electron .claude/skills/run-desktop/fixture-viewer \
  .claude/skills/run-desktop/fixtures/assessment-scan.html > "$OUT/viewer.log" 2>&1 &   # background
```

```text
click Assist
click Screen
watch                         # logs "[drive] status: …" lines as the scan runs
click Start                   # start screen watching
# (launch the viewer now — see above)
click Start guided screen scan
wait 45000
click AI Help
shot answer
```

Close the viewer afterwards (`pkill -f run-desktop/fixture-viewer`). Don't drive
Safari/Chrome through AppleScript for this: it blocks on a macOS automation
prompt. `testpage` is still fine for anything that doesn't capture the screen.

Copy chips: in the answer view, keys 1–9 copy that question's answer. To check
without touching the real keyboard, send the key to the window and read the
clipboard:

```text
evalMain const {BrowserWindow,clipboard}=electron; const w=BrowserWindow.getAllWindows().find(x=>x.webContents.getURL().includes('/session')); w.focus(); for (const type of ['keyDown','char','keyUp']) w.webContents.sendInputEvent({type,keyCode:'2'}); await new Promise(r=>setTimeout(r,600)); return clipboard.readText()
```

What a working scan shows in `driver.log` and on screen:

- `✓ View N captured — scroll to the next part` after each settled view.
- `Saved passage as reference: “…”` soon after the first view (the preamble).
- Questions get answered while the page is still scrolling, so the panel often
  switches to the answer view before `Scrolling stopped · Reading N views…` shows.
- One answer page (`1/1`) with **Q1 · …**, **Q2 · …**, **Q3 · …** (later ones under
  "More questions from the screen") and copy chips. The correct answers are
  C) Highland, A) True and B) 2,000.
- In the backend log, background reads (`extraction.done`) run during the scroll
  and no new read follows the end of the scan when its views match the last one.

Check which model ran in the backend log (`extraction.done … model=…`,
`usage.answer … model=…`). To pick a Claude model for screen mode:
`select model claude-haiku-5-5` while the Screen tab is open.

### Visual scan

`fixtures/assessment-visuals.html` ("Operations Analyst Assessment — Section C") is a
long page whose questions can only be answered by reading the figures: a bar chart
(only Jan and Jun labelled), a two-series line chart, a refund-approval flowchart, a
PNG floor plan (the dock numbers exist only in the image) and an SLA table. It
scrolls itself one section per stop (7 stops, ~8 views — under the 12-view cap),
so each figure is whole in one view. Run it the same way, opening
`.claude/skills/run-desktop/fixtures/assessment-visuals.html` in `fixture-viewer`;
answers arrive ~40 s after the scan starts. Friday's own panel is hidden from the
captures, so it can stay over the page on the primary display. That is also how
to check it: fetch the stored screenshots
(`GET /api/vision/screen-image/{key}?session_id=…`; keys from
`GET /api/vision/screen-context?session_id=…`) and confirm the page shows where
the panel sat.
Answer key (also in an HTML comment at the bottom):

- Q1 B) April · Q2 B) 60,000 · Q3 B) Q1 2024 · Q4 C) Manager review
- Q5 B) Dock 7 · Q6 C) Support · Q7 B) 68 (50 + 70 − 52)

Screenshots with figures are kept for the session and listed under **Saved
passages** in the Screen panel. Buttons are clicked by exact accessible name, which
is the `aria-label` when there is one: `click Show` / `click Hide`,
`click Remove passage 1` (not "Remove"), and
`click Clear remembered screen context` (the "Clear all" button). A thumbnail is
`click Open saved screenshot` (opens a new window).

## Gotchas

- **Clicks match exact names.** A partial match for "Start" hits **Restart Friday**,
  which relaunches the app outside the driver. If that happens, kill the stray
  Electron (`pgrep -fl "electron.*apps/desktop"`) before relaunching.
- **Some names change with state.** Once screen watching is on, the Screen tab is
  named "Screen, screen active", so `click Screen` times out — use `clickp Screen`.
- **The Next.js dev overlay** (`nextjs-portal`) covers the app and swallows clicks;
  the driver removes it before every click.
- **Screen capture needs macOS permission** for the dev Electron binary. Check with
  `evalMain const {systemPreferences}=electron; return systemPreferences.getMediaAccessStatus('screen')`
  — it must be `granted`. Scans capture the **primary** display.
- **Real model calls cost money.** A scan of the fixture page makes several vision
  calls (one per pause) plus a few short answers; keep runs few.
- When done: `quit`, then stop the backend and web servers you started.
