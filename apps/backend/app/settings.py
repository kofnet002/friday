import os
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=os.environ.get("FRIDAY_ENV_FILE", str(ROOT_ENV)),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    deepgram_api_key: str = Field(default="")
    gemini_api_key: str = Field(default="")
    openai_api_key: str = Field(default="")
    deepseek_api_key: str = Field(default="")
    anthropic_api_key: str = Field(default="")
    backend_url: str = Field(default="http://127.0.0.1:8000")
    redis_url: str = Field(default="redis://127.0.0.1:6379")

    gemini_model: str = Field(default="gemini-2.5-flash")
    openai_model: str = Field(default="gpt-4o")
    deepseek_model: str = Field(default="deepseek-chat")
    deepseek_base_url: str = Field(default="https://api.deepseek.com")
    # Claude / Anthropic. Opus 5.5 is the default; override via
    # ANTHROPIC_MODEL (e.g. claude-sonnet-5-5 / claude-haiku-5-5) to trade
    # quality for latency/cost. Per-model request differences (thinking
    # headroom, effort support, refusal fallbacks) live in
    # services/claude_api.py, so swapping this string is safe.
    anthropic_model: str = Field(default="claude-opus-5-5")
    # Model for LIVE interview answers (Copilot panel + /api/chat). Separate
    # from ANTHROPIC_MODEL (coding solves, function calling) because live
    # answers are latency-bound: measured on the real answer prompt, Sonnet
    # 5.5 started streaming in ~1.0 s median vs ~2.3 s for Opus 5.5, at half
    # the price, with equivalent answer quality. Coding keeps Opus's depth.
    anthropic_answer_model: str = Field(default="claude-sonnet-5-5")
    # Which transport non-agent Claude calls use (answers, solves, vision,
    # question detection, function calling):
    #   auto         — API key when set, else the subscription CLI
    #   api          — ANTHROPIC_API_KEY only (metered)
    #   subscription — CLAUDE_CODE_OAUTH_TOKEN via the local CLI only
    # The agent tool loop always runs on the CLI regardless (see below).
    claude_transport: Literal["auto", "api", "subscription"] = Field(default="auto")
    # Opus 5.5 always thinks; effort is the only depth/latency control.
    # Latency-sensitive calls (answers, QD, vision, chat) use
    # ANTHROPIC_EFFORT; coding solves use ANTHROPIC_SOLVE_EFFORT, and deep
    # refines / hard problems step up to "high".
    # Project context ("Projects" library). Brief generation is a one-off,
    # offline distillation of a project's sources, so it uses the strongest
    # model; live answers only ever see the (small) brief plus raw text when
    # the attached sources fit PROJECT_RAW_BUDGET_CHARS (~4 chars/token).
    project_brief_model: str = Field(default="claude-opus-5-5")
    project_brief_effort: Literal["low", "medium", "high", "xhigh", "max"] = Field(default="medium")
    project_raw_budget_chars: int = Field(default=120_000)
    # Second pass that fact-checks the draft brief against its sources.
    project_brief_verify: bool = Field(default=True)
    anthropic_effort: Literal["low", "medium", "high", "xhigh", "max"] = Field(default="low")
    anthropic_solve_effort: Literal["low", "medium", "high", "xhigh", "max"] = Field(
        default="medium"
    )

    # Deepgram streaming config
    deepgram_model: str = Field(default="nova-3")
    deepgram_language: str = Field(default="en-US")
    deepgram_endpointing_ms: int = Field(default=300)
    deepgram_sample_rate: int = Field(default=16000)
    deepgram_channels: int = Field(default=1)

    # Turn detection engine for live transcription:
    #   flux — Deepgram Flux (semantic end-of-turn, eager EOT → speculative
    #          answers, mic-aware). English sessions only; others use nova.
    #   nova — nova-3 + silence/ceiling timers (QuestionDetector).
    turn_engine: Literal["flux", "nova"] = Field(default="flux")
    flux_model: str = Field(default="flux-general-en")
    # Confirmed end-of-turn confidence. Higher = fewer premature cut-offs,
    # slightly later confirmation. Range 0.5-1.0.
    flux_eot_threshold: float = Field(default=0.75)
    # Eager ("probably done") threshold — speculation starts here. Lower =
    # earlier answers but more discarded speculative calls. Range 0.3-0.9.
    flux_eager_eot_threshold: float = Field(default=0.5)
    # Force EndOfTurn after this much silence even if the model is unsure
    # (e.g. a long thinking pause mid-question). Range 500-60000.
    flux_eot_timeout_ms: int = Field(default=3000)
    # Start answering at EagerEndOfTurn (hidden until the turn confirms).
    speculative_answers: bool = Field(default=True)

    # Question detection — default to flash-lite so it doesn't share
    # gemini-2.5-flash's free-tier daily bucket with vision + answer streams.
    question_detection_model: str = Field(default="gemini-2.5-flash-lite")
    question_detection_silence_ms: int = Field(default=1200)
    # Hard ceiling: even if the interviewer keeps talking without a pause
    # long enough to satisfy the silence timer, fire detection this many ms
    # after the first unprocessed final. Prevents the "stacked context after
    # the question" failure mode where the silence timer is repeatedly reset.
    question_detection_ceiling_ms: int = Field(default=4500)
    question_detection_transcript_window_s: int = Field(default=30)
    question_detection_min_confidence: float = Field(default=0.7)
    # Model used when Gemini returns 429/RESOURCE_EXHAUSTED. Routed by
    # prefix: a `claude-*` model runs on the Claude credential
    # (CLAUDE_TRANSPORT), anything else on OpenAI. gpt-4o-mini / Claude Haiku
    # 5.5 keep cost close to Flash-Lite.
    question_detection_fallback_model: str = Field(default="gpt-4o-mini")
    # Backend-side dedup: a freshly extracted question that byte-equals the
    # one we just fired within this window is dropped. Catches the case
    # where ceiling + idle both fire on the same transcript window before
    # any client-side entry exists (so client dedup can't help).
    question_detection_dedup_cooldown_s: float = Field(default=4.0)

    # Vision extraction (coding mode). Must be a model with image input.
    vision_extraction_model: str = Field(default="gemini-2.5-flash")
    # Pin the OCR/detection step to a specific provider regardless of the
    # coding panel's selected model. Lets vision run on a fast, reliable model
    # (e.g. openai = gpt-4o, ~2s) while solves still use the selected provider
    # (e.g. the Claude subscription). Empty = follow the coding provider.
    # One of: "" | gemini | openai | deepseek | claude.
    vision_provider: str = Field(default="")
    # After a coding problem is confidently detected, suppress re-running the
    # vision model for this many seconds (non-force frames serve the detected
    # problem). Cuts quota churn from re-OCR-ing the same on-screen problem
    # every frame — matters most on the expensive Claude subscription path.
    # A NEW problem appearing is still caught within this window's tail; hit
    # Re-extract to bypass immediately. Set 0 to disable the cooldown.
    vision_cooldown_s: int = Field(default=25)
    # Also try to detect function-calling assessments ("pick the tool + build
    # the payload") from the same frames. Runs a SECOND vision call ONLY on
    # frames the coding detector rejected (never adds cost to coding frames),
    # and only while a panel is listening. Its own dedup cache + cooldown bound
    # the churn on idle screens. Set false to disable this entirely.
    function_call_detection_enabled: bool = Field(default=True)

    # ─── Agentic coding ("Claude Code" in-app) ─────────────────────────────
    # Drives the local `claude` CLI headlessly to solve hard problems with a
    # real tool-use loop (write code → run it → fix → repeat). Bills against
    # the Claude SUBSCRIPTION via CLAUDE_CODE_OAUTH_TOKEN (from
    # `claude setup-token`), NOT the pay-per-token Anthropic API — so no
    # per-token cost. Off by default; see docs/agentic-coding.md for setup.
    agent_enabled: bool = Field(default=False)
    # Binary name or absolute path of the Claude Code CLI on the backend PATH.
    claude_cli_path: str = Field(default="claude")
    # Claude Code profile directory (CLAUDE_CONFIG_DIR) for the spawned CLI.
    # Lets the app use a separate login/subscription from the default `claude`
    # profile (e.g. ~/.claude-raymond, the user's `claude-raymond` alias).
    # `~` is expanded. Empty = the CLI's default (~/.claude).
    claude_config_dir: str = Field(default="")
    # Long-lived subscription OAuth token from `claude setup-token`. When set,
    # it forces subscription billing (ANTHROPIC_API_KEY is stripped from the
    # child env so the CLI can't silently fall back to metered API access).
    claude_code_oauth_token: str = Field(default="")
    # Wall-clock kill for a single agent run. This is the load-bearing
    # guardrail against a runaway loop draining the subscription quota — the
    # CLI has no turn-count flag, so the timeout bounds the whole run.
    agent_timeout_s: int = Field(default=300)
    # Reasoning effort for the agent (low|medium|high|xhigh|max). LOW on
    # purpose: the agent has a write→run→fix feedback loop, so fast turns beat
    # deep per-turn thinking. At high/default effort Opus spends 100s+ thinking
    # before its FIRST action and never finishes; low effort starts acting in
    # seconds and iterates.
    agent_effort: str = Field(default="low")
    # Tools the agent may use (comma-separated, passed to --allowedTools).
    agent_allowed_tools: str = Field(default="Read,Write,Edit,Bash")
    # Tools the agent must NOT use (passed to --disallowedTools). Blocks web
    # research: with --dangerously-skip-permissions the agent otherwise has
    # internet, and on a problem with OCR-corrupted examples it burns the whole
    # timeout googling instead of solving. Deny overrides skip-permissions.
    agent_disallowed_tools: str = Field(default="WebSearch,WebFetch")
    # Run tools without interactive approval — required for headless use.
    # Safe here because each run executes in a throwaway scratch dir; do NOT
    # enable for untrusted remote users.
    agent_skip_permissions: bool = Field(default=True)
    # Model for the agent's tool loop. Opus 5.5 for raw capability; at
    # AGENT_EFFORT=low it starts acting quickly, but its per-turn reasoning is
    # still slower than Sonnet's — if runs hit AGENT_TIMEOUT_S, set "sonnet".
    agent_model: str = Field(default="claude-opus-5-5")
    # Model used when Claude is the selected provider for VISION extraction
    # (screen → problem), on either transport. Opus does the best OCR but is
    # the slowest/most quota-heavy per frame — override to a faster Claude
    # (e.g. claude-haiku-5-5) if the watch loop feels sluggish.
    claude_vision_model: str = Field(default="claude-opus-5-5")

    # Persistence (SQLite for session context + resume)
    sqlite_path: str = Field(default="data/friday.db")

    # Per-session safety budgets — pre-flight checked before each LLM call
    # and audio second is metered as it's sent to Deepgram.
    session_token_limit: int = Field(default=500_000)
    session_audio_minute_limit: int = Field(default=120)

    # After this many fallback calls have succeeded against OpenAI, the
    # next QD call probes Gemini again. Gemini free-tier quotas reset
    # hourly, so a sticky-forever fallback would keep paying OpenAI rates
    # long after Gemini was usable again. 10 is a reasonable balance: one
    # 429 every ~45s of QD activity vs. one wasted-but-cheap Flash-Lite
    # call to confirm recovery.
    question_detection_probe_interval: int = Field(default=10)

    @model_validator(mode="after")
    def _validate_qd_windows(self) -> "Settings":
        # Dedup cooldown must be wide enough to cover the worst-case gap
        # between two competing triggers (ceiling fires, then idle fires
        # immediately after). If the cooldown is shorter than the timer
        # spread, the second trigger sneaks past dedup.
        if self.question_detection_dedup_cooldown_s * 1000 < (
            self.question_detection_ceiling_ms - self.question_detection_silence_ms
        ):
            # Don't raise — settings come from env, and a misconfig
            # shouldn't crash the app. Just warn at construction time
            # by widening to a safe value.
            self.question_detection_dedup_cooldown_s = (
                self.question_detection_ceiling_ms / 1000.0 + 1.0
            )
        return self


settings = Settings()
