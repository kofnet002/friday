# Friday

Local-first transcription + LLM assistant prototype. macOS-only.

This is a personal/experimental project — see the **Honest scope** section
below for what it is and isn't.

## What's in here

- **`apps/backend`** — FastAPI on `127.0.0.1:8000`. Wraps Deepgram for
  streaming transcription, Gemini/OpenAI for streamed LLM responses,
  Gemini Flash vision for screenshot extraction. SQLite for session
  persistence; Redis for transient session state.
- **`apps/desktop`** — Electron shell + a Swift `friday-audio` helper
  that captures system audio via ScreenCaptureKit and writes 16 kHz mono
  Int16 PCM to stdout.
- **`apps/web`** — Next.js 15 / React 19 / Tailwind. Three-panel session
  layout (transcript / copilot / coding), shiki for syntax highlighting,
  react-resizable-panels for the splits.
- **`packages/shared-types`** — TypeScript types mirroring the backend
  Pydantic models / WS protocols.
- **`packages/prompts`** — Versioned prompt files (`coding-extraction.ts`,
  `coding-solution.ts`, `question-detection.ts`, `answer-generation.ts`).
  Backend mirrors of the same text live in `apps/backend/app/prompts/`.

## Prerequisites

| Tool      | Version | How                                                            |
| --------- | ------- | -------------------------------------------------------------- |
| Node      | ≥ 20    | nvm / Homebrew                                                 |
| pnpm      | ≥ 10    | `corepack enable` or `npm i -g pnpm`                           |
| Python    | 3.11    | uv manages this                                                |
| uv        | ≥ 0.5   | `brew install uv`                                              |
| Redis     | ≥ 7     | `brew install redis && brew services start redis`              |
| Xcode CLT | latest  | `xcode-select --install` (Swift compiler for the audio helper) |
| macOS     | 13+     | ScreenCaptureKit needs Ventura or later                        |

## First-run setup

```bash
git clone … friday && cd friday

# Install everything (also runs `uv sync` and `swift build` via postinstall)
pnpm install

# Copy .env template, fill in keys
cp .env.example .env
# Required for full functionality:
#   DEEPGRAM_API_KEY=…   (free tier OK; paid for sustained use)
#   GEMINI_API_KEY=…     (free tier hits 20/day per model)
#   OPENAI_API_KEY=…     (paid; needs credit balance)
# Optional overrides:
#   GEMINI_MODEL=gemini-2.5-flash         (answer/coding stream)
#   QUESTION_DETECTION_MODEL=gemini-2.5-flash-lite
#   VISION_EXTRACTION_MODEL=gemini-2.5-flash
#   SESSION_TOKEN_LIMIT=500000
#   SESSION_AUDIO_MINUTE_LIMIT=120

# Verify your env / connectivity
pnpm dev
# In another terminal:
curl -s http://127.0.0.1:8000/health/deep | jq
# Expect "ok" with all keys "present" and redis/sqlite "ok".
```

`pnpm dev` runs three things in parallel via Turbo:

1. FastAPI on `127.0.0.1:8000`
2. Next.js on `127.0.0.1:3333`
3. Electron, which `wait-on`s :3333 and then opens against it

Stop the stack with `Ctrl-C` in the same terminal, or:

```bash
pkill -f "turbo run dev"
pkill -f "uvicorn app.main"
pkill -f "next dev"
pkill -f "Electron.app.*friday/desktop"
```

## Required permissions (macOS)

On first launch the app prompts for these. If you skip them you can grant
later in System Settings:

| Permission                      | Where                                                | What for                                                                                          |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Microphone                      | Privacy & Security → Microphone                      | Optional; mic isn't routed into the pipeline by default but the helper requests it for future use |
| Screen & System Audio Recording | Privacy & Security → Screen & System Audio Recording | Required — ScreenCaptureKit captures both screen _and_ system audio under this single permission  |

After granting, fully quit and relaunch Electron — macOS caches permission
state per-launch.

## Hotkey reference

| Keys        | Action                                                   |
| ----------- | -------------------------------------------------------- |
| `⌘ ⇧ Space` | Force-ask the copilot using the last 2 transcript finals |
| `⌘ ⇧ C`     | Toggle coding mode on/off                                |
| `⌘ /`       | Show keyboard shortcuts modal                            |
| `Esc`       | Close any open modal                                     |

## Cost expectations

Approximate per-hour cost during active use, based on the rough public
prices baked into `apps/backend/app/services/usage.py`:

| Component          | Model                    | ~Cost / hour                  |
| ------------------ | ------------------------ | ----------------------------- |
| Transcription      | Deepgram nova-3          | ~$0.26                        |
| Question detection | Gemini 2.5 Flash-Lite    | <$0.01                        |
| Vision extraction  | Gemini 2.5 Flash         | ~$0.005 (≤20 frames)          |
| Answer streaming   | Gemini 2.5 Pro / GPT-5   | varies; typically $0.01–$0.05 |
| Coding solution    | Gemini 2.5 Flash / GPT-5 | <$0.02 per problem            |

Per-session safety budgets (configurable in `.env`):

- `SESSION_TOKEN_LIMIT` — sums input + output tokens across LLM calls
  (default 500k). When exceeded, new LLM calls return a `limit_exceeded`
  event and don't bill.
- `SESSION_AUDIO_MINUTE_LIMIT` — total minutes of audio forwarded to
  Deepgram (default 120). When exceeded, the WS stops forwarding frames
  and emits a `limit_exceeded` event.

## Logs

- Backend → `~/Library/Logs/friday/backend.log` (rotated 10 MB × 5).
  Set `FRIDAY_JSON_LOGS=1` for line-delimited JSON; default is the
  human-readable structlog renderer.
- API keys appearing anywhere in the log stream are masked to
  `sk-…<redacted:N>…last4` form by a structlog processor.

## Stealth Testing

- Open the in-app `Test stealth` page from Session → Settings for a short
  manual verification flow.
- The full desktop checklist lives at
  [`apps/desktop/test-stealth.md`](./apps/desktop/test-stealth.md).

## Known Caveats

- macOS Sonoma and later may still ask the user to enable Screen Recording
  permission even for windows that are intended to stay out of captures.
  That is a system-level quirk, not an app bug.
- Zoom should be kept on the latest version. For the most reliable
  `setContentProtection` behavior, enable `Use hardware acceleration for
screen sharing` in Zoom's advanced video settings.
