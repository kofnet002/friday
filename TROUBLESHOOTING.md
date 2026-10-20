# Troubleshooting

Most issues fall into one of these buckets — try the first match.

## Setup / environment

### `pnpm dev` fails with `EADDRINUSE :3333` (or :8000)

Another process is holding the port. Could be a previous run that didn't
clean up.

```bash
# See who's there
lsof -nP -iTCP:3333 -sTCP:LISTEN
lsof -nP -iTCP:8000 -sTCP:LISTEN

# Kill anything Friday-related
pkill -f "turbo run dev"
pkill -f "uvicorn app.main"
pkill -f "next dev --port 3333"
pkill -f "Electron.app.*friday/desktop"
```

If the holder is a _different_ project (e.g. another Next dev server on
:3333), close it first.

### `pnpm install` finished but Electron won't launch the helper

The Swift binary might not have built. Check:

```bash
ls -lh apps/desktop/swift/.build/release/friday-audio
```

If it's missing, run the build manually:

```bash
pnpm --filter @friday/desktop run build:swift
```

If you get a Swift compiler error, install Xcode Command Line Tools:

```bash
xcode-select --install
```

### `pnpm dev` shows `Ignored build scripts: electron@…, sharp@…`

That means pnpm hasn't approved the native postinstalls. Re-run install
once — the project's `pnpm.onlyBuiltDependencies` allowlist should cover
it on a clean install.

```bash
rm -rf node_modules apps/*/node_modules
pnpm install
```

## Running

### "Coding mode only works inside the Friday desktop window"

You're viewing `/session` in a regular browser tab instead of the
Electron window. The `window.friday` API only exists when the page is
loaded by the Electron preload script.

Open the Electron window (it auto-opens with `pnpm dev`). The browser
tab is still useful for code-only testing of the transcript / copilot
panels, just not for system-audio capture or screen extraction.

### The window can't be moved across the screen

The frameless window's drag region is the top 28 px (`.app-titlebar`
class in `globals.css`). Click anywhere in that strip and drag.

### Transcript is empty even though audio is playing

1. **Permission**: System Settings → Privacy & Security → Screen &
   System Audio Recording → enable Friday → quit and relaunch the app.
2. **Audio is actually playing**: macOS mutes some apps independently.
   Try a YouTube video in Chrome.
3. **Deepgram session**: check backend log. Look for
   `deepgram.connected model=nova-3`. If you see `deepgram.error` or
   `Invalid API key`, fix `DEEPGRAM_API_KEY` in `.env` and restart.

### "limit_exceeded" event in the UI

You hit a per-session budget. Two kinds:

- **`tokens`** — total LLM tokens across all calls in this session
  passed `SESSION_TOKEN_LIMIT` (default 500k). New LLM calls are
  blocked. Either start a new session (regenerate the session ID in
  `/setup` → "new session") or bump the limit:
  ```
  SESSION_TOKEN_LIMIT=1000000
  ```
- **`audio`** — total minutes of audio sent to Deepgram passed
  `SESSION_AUDIO_MINUTE_LIMIT` (default 120). The transcribe WS stops
  forwarding frames. Same fix as above.

### `429 RESOURCE_EXHAUSTED` from Gemini even on a fresh day

Each Gemini model has its **own** free-tier daily bucket. If you've been
running heavy tests today, switch to a different model:

```
GEMINI_MODEL=gemini-2.5-flash
QUESTION_DETECTION_MODEL=gemini-3.5-flash-lite
VISION_EXTRACTION_MODEL=gemini-2.5-flash
```

Each gets its own daily allowance.

### Coding extraction is too aggressive / fires on non-problem screens

The vision model has a confidence threshold of 0.7 server-side. If
something below that is still appearing, increase it:

```
# in app/prompts/coding_extraction.py
EXTRACTION_MIN_CONFIDENCE = 0.85
```

### Question detection extracts only the tail of a multi-utterance question

This was the "v1.0 prompt" failure mode and is fixed in v1.1, but if you
see it again, it usually means a Gemini Flash regression. Check the
backend log for `question_detection.bad_json` or `question_detection.skip_mid_thought`
to see what the classifier saw.

### Audio capture cuts out mid-session

The Swift helper exits if the SCStream errors. Watch the backend log for
`coding/audio:log` lines from the renderer. If the helper crashed,
toggle Stop / Start on the transcribe panel — the Electron supervisor
re-spawns it.

## Logs

### Where they live

```
~/Library/Logs/friday/backend.log      # 10 MB × 5 rotation
```

### Format

By default, human-readable structlog console output. Set
`FRIDAY_JSON_LOGS=1` for line-delimited JSON if you want to grep or feed
to another tool.

### What's redacted

API keys are auto-masked anywhere they appear in event keys, values, or
exception text. The mask shows the first 4 + last 4 chars and the length
so you can still differentiate keys without leaking them.

If a key shape isn't in the redaction list and you see it in a log
file, open `apps/backend/app/logging.py` → `_KEY_PATTERNS` and add it.

## State reset

### Clear the session state for a fresh start

Two stores:

```bash
# SQLite (sessions, qa_history, coding_solutions, usage_log)
rm apps/backend/data/friday.db

# Redis (current session transient state)
redis-cli FLUSHDB
```

### Clear browser-side state

The renderer keeps session-id and theme in localStorage. Open the
Electron DevTools (it auto-opens in dev), Application tab → Local
Storage → clear.

Or in the renderer console:

```js
localStorage.clear();
location.reload();
```

## Health check

```bash
curl -s http://127.0.0.1:8000/health      # process alive
curl -s http://127.0.0.1:8000/health/deep | jq    # redis + sqlite + key presence
```

If `/health/deep` returns 503, the `checks` field tells you what's wrong:

| Check    | If "down" / "missing"                                        |
| -------- | ------------------------------------------------------------ |
| `redis`  | Run `redis-cli ping`; start with `brew services start redis` |
| `sqlite` | Permission issue on `apps/backend/data/`; check disk space   |
| `*_key`  | Add the missing key to `.env` and restart the backend        |

## Bug reports

Include:

1. Output of `curl -s http://127.0.0.1:8000/health/deep`
2. Last ~30 lines of `~/Library/Logs/friday/backend.log`
3. macOS version (`sw_vers`) and `sysctl -n machdep.cpu.brand_string`
4. What you were doing when the bug appeared

Strip any visible API-key strings before sharing — the redaction is
best-effort.
