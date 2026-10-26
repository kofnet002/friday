# Agentic coding ("Claude Code" in the app)

A coding mode that drives the **local `claude` CLI** headlessly to solve hard
problems with a real tool-use loop (write code → run it → see output → fix →
repeat) — the same agent that runs in your terminal, triggered from the app.

Unlike the normal `solve` path (a single blind LLM call per provider), the
agent **executes and verifies its own code** against the extracted examples
before it hands you an answer. That closed loop is what solves problems the
one-shot Gemini/DeepSeek/Opus calls fail on.

## Why the CLI and not the Anthropic API

It bills against your **Claude subscription** (via `CLAUDE_CODE_OAUTH_TOKEN`),
**not** the pay-per-token Anthropic API. No `ANTHROPIC_API_KEY` required and no
per-token cost — it draws from the same subscription quota as your terminal.

### Setup (one time)

1. Generate a long-lived subscription token from a terminal where you're logged
   into Claude Code:

   ```
   claude setup-token
   ```

   It prints a `CLAUDE_CODE_OAUTH_TOKEN=...` value (a subscription OAuth token,
   scoped to inference).

2. Put it in the repo root `.env` and enable the feature:

   ```
   AGENT_ENABLED=true
   CLAUDE_CODE_OAUTH_TOKEN=<the token from step 1>
   ```

3. Make sure `claude` is on the backend's PATH (or set `CLAUDE_CLI_PATH` to an
   absolute path). Check with `claude --version`.

## How it works

```
coding-panel  ──"Agent"──▶  ws_coding (mode: "agent")
                                 │
                                 ▼
                     services/coding_agent.stream_coding_agent()
                                 │  spawns:  claude -p --output-format stream-json
                                 │           (cwd = per-run scratch dir, subscription auth)
                                 ▼
              parses stream-json events → yields AgentEvent:
                 agent_step / agent_tool / agent_tool_result / agent_solution
                                 │
                                 ▼
                     ws forwards them to the panel (live trace),
                     sets the final solution on the active tab,
                     then runs the existing self-verify (code_runner)
```

- **Auth seam** — `services/claude_agent_auth.py` resolves the credential per
  run. Today it returns the single global `CLAUDE_CODE_OAUTH_TOKEN`; the
  `session_id` argument is the hook for a future multi-user build where each
  user brings their own token (never share one subscription across users — that
  violates Anthropic's terms).
- **Sandbox / workspace** — each run gets a throwaway temp dir as its `cwd`.
  The CLI's Bash tool runs on this machine (same trust level as using the
  terminal yourself). Fine for a personal local tool; **do not** expose this to
  untrusted remote users.
- **Guardrails** — `AGENT_TIMEOUT_S` wall-clock-kills a runaway loop so it can't
  drain your subscription quota (the CLI has no turn-count flag, so the timeout
  is the backstop). The run is also cancellable from the panel.
- **Language** — Python-first (matches the `code_runner` self-verify). The agent
  can still write other languages, but the final self-verify only runs Python.

## The solve pipeline: fast first, escalate to Claude on failure

The instant auto-solve uses a **fast API provider** (Gemini/OpenAI/DeepSeek) —
never the Claude subscription CLI, which does extended reasoning that takes
_minutes_ on hard problems (unusable for a live auto-solve). The streamed
solution is then checked against the extracted examples (`code_runner`). If it
**fails self-verify**, the panel automatically escalates to the **Claude Agent**
(`onCodingSolutionMessage` → `requestAgentSolve` on a failing `test_results`),
which writes + runs + fixes code until the examples pass. Net: an instant answer
every time, Claude's (slower, verified) power only when the fast answer is
actually wrong. The manual **Agent** button does the same on demand.

Note: because the subscription CLI can't do a snappy solve, selecting "Claude"
in the dropdown does not run Claude for the _instant_ solve unless the transport
resolves to the API (an `ANTHROPIC_API_KEY` with `CLAUDE_TRANSPORT=auto|api` —
see "Claude transport" below). Subscription
Claude reaches you through the Agent — automatically on verify-failure, or via
the button.

### Vision extraction with Claude

With an API key, picking **Claude** sends the screenshot straight to the
Messages API as an image block (fast, real token counts). On the subscription
transport, _vision_ (screen → problem) goes through the CLI instead: Claude Code reads the
screenshot (`services/claude_cli.py: run_claude_cli_vision`) and returns the
`ExtractedProblem` (incl. the `function_signature` boilerplate that feeds the
solver's `Starter code`). But it's slow (~10-20s) and weaker models (haiku)
produce sub-threshold confidence — prefer **`VISION_PROVIDER=openai`** (gpt-4o,
~2s, reliable) for detection while the Agent handles Claude-quality solving.

### Claude transport (`CLAUDE_TRANSPORT`)

Every non-agent Claude call — answers, instant solves, vision, question
detection, function calling, `/api/chat` — picks its transport in one place,
`services/claude_api.py: claude_transport()`:

| `CLAUDE_TRANSPORT` | API key set      | Only subscription token |
| ------------------ | ---------------- | ----------------------- |
| `auto` (default)   | API (metered)    | subscription CLI        |
| `api`              | API (metered)    | Claude unavailable      |
| `subscription`     | subscription CLI | subscription CLI        |

Live Copilot answers use their own model, `ANTHROPIC_ANSWER_MODEL` (default
`claude-sonnet-5-5`): measured on the real answer prompt it starts streaming in
~1.0 s median versus ~2.3 s for Opus 5.5, at half the price, with equivalent
answers. `ANTHROPIC_MODEL` (Opus 5.5) keeps coding solves and function calling.

The Agent is unaffected: it always drives the CLI and, when a subscription
token exists, strips `ANTHROPIC_API_KEY` from its env so it can't fall back to
metered billing. On the API path, `ANTHROPIC_EFFORT` (default `low`) controls
latency-sensitive calls and `ANTHROPIC_SOLVE_EFFORT` (default `medium`) coding
solves; deep refines use `high`. Opus 5.5 always thinks, so `claude_api` adds
thinking headroom to `max_tokens` and opts into server-side refusal fallbacks
(`fallbacks: "default"`).

### Cutting vision quota churn (`VISION_COOLDOWN_S`)

A detected problem sits on screen for a while, but a cursor blink / caret move /
typing changes the pixels enough to bust the exact-image cache, so vision would
re-OCR the same problem every frame. After a confident detection the backend
arms a per-session cooldown (`VISION_COOLDOWN_S`, default 25s): non-`force`
frames serve the already-detected problem without calling the model. It's armed
**only** on a successful coding-problem detection, so a problem appearing on an
idle screen is still caught on the first frame; a _new_ problem replacing the
current one is caught within the cooldown's tail, or immediately via **Re-extract**.
(A perceptual image hash was tried first but coding screenshots are ~90%
whitespace — different problems hash near-identically, which risked silently
deduping a new problem away.)

## Settings (app/settings.py)

| Setting                   | Default                | Purpose                                                                                               |
| ------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `AGENT_ENABLED`           | `false`                | Master switch for the mode                                                                            |
| `CLAUDE_CLI_PATH`         | `claude`               | Path/name of the CLI binary                                                                           |
| `CLAUDE_CODE_OAUTH_TOKEN` | `""`                   | Subscription token from `claude setup-token`                                                          |
| `AGENT_TIMEOUT_S`         | `300`                  | Wall-clock kill for one run (the runaway guardrail)                                                   |
| `AGENT_ALLOWED_TOOLS`     | `Read,Write,Edit,Bash` | Tools the agent may use                                                                               |
| `AGENT_DISALLOWED_TOOLS`  | `WebSearch,WebFetch`   | Blocked tools — keeps the agent solving, not googling                                                 |
| `AGENT_SKIP_PERMISSIONS`  | `true`                 | Run tools without prompts (needed headless)                                                           |
| `AGENT_MODEL`             | `claude-opus-5-5`      | Agent model — set `sonnet` if Opus turns hit `AGENT_TIMEOUT_S`                                        |
| `AGENT_EFFORT`            | `low`                  | Reasoning effort — low = fast turns; the loop compensates                                             |
| `CLAUDE_VISION_MODEL`     | `claude-opus-5-5`      | Model for Claude vision extraction (screen→problem); set a faster Claude if the watch loop feels slow |
| `CLAUDE_TRANSPORT`        | `auto`                 | `auto` \| `api` \| `subscription` — credential for non-agent Claude calls (see above)                 |

## Status / caveats

- **ToS**: subscription auth is intended for interactive use. Driving _your own_
  logged-in CLI from _your own_ local app for _your own_ use is low-risk; a
  hosted multi-user product on one subscription is not. Keep this single-user
  until per-user tokens land.
- **Latency**: an agent run takes seconds-to-a-minute (it runs tests), not the
  instant token stream of the normal solve. It's the "escalate when the fast
  models fail" tool, not the default.
- **Quota**: heavy agent use competes with your terminal's subscription limits
  (5-hour windows + weekly caps).
