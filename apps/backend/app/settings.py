import os
from pathlib import Path

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"


def env_file_path() -> Path:
    """The .env to load. The packaged app has no repo root, so Electron points
    FRIDAY_ENV_FILE at ~/Library/Application Support/Friday/.env."""
    override = os.environ.get("FRIDAY_ENV_FILE")
    return Path(override) if override else ROOT_ENV


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(env_file_path()),
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
    # Claude / Anthropic. Opus 4.8 is the most capable tier; override via
    # ANTHROPIC_MODEL (e.g. claude-sonnet-4-6 / claude-haiku-4-5) to trade
    # quality for latency/cost. Note: the Opus 4.x family rejects
    # temperature/top_p/top_k and budget_tokens — the streamers below omit
    # them deliberately, so swapping in an older model that needs them would
    # require changing the call, not just this string.
    anthropic_model: str = Field(default="claude-opus-4-8")

    # Deepgram streaming config
    deepgram_model: str = Field(default="nova-3")
    deepgram_language: str = Field(default="en-US")
    deepgram_endpointing_ms: int = Field(default=300)
    deepgram_sample_rate: int = Field(default=16000)
    deepgram_channels: int = Field(default=1)

    # Question detection — default to flash-lite so it doesn't share
    # gemini-2.5-flash's free-tier daily bucket with vision + answer streams.
    # (gemini-2.5-flash-lite is no longer available to new API keys.)
    question_detection_model: str = Field(default="gemini-3.5-flash-lite")
    question_detection_silence_ms: int = Field(default=1200)
    # Hard ceiling: even if the interviewer keeps talking without a pause
    # long enough to satisfy the silence timer, fire detection this many ms
    # after the first unprocessed final. Prevents the "stacked context after
    # the question" failure mode where the silence timer is repeatedly reset.
    question_detection_ceiling_ms: int = Field(default=4500)
    question_detection_transcript_window_s: int = Field(default=30)
    question_detection_min_confidence: float = Field(default=0.7)
    # Model used when Gemini returns 429/RESOURCE_EXHAUSTED. Defaults to
    # gpt-4o-mini for cost parity with Flash-Lite (Flash-Lite → gpt-4o is
    # roughly a 20× jump per call; mini is much closer). Override to
    # `gpt-4o` for higher quality.
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
    # Model for the agent's tool loop. Defaults to Sonnet (fast) rather than
    # Opus: the loop's speed of iteration matters more than depth of a single
    # thought, and Opus's per-turn reasoning latency blows the timeout. Set to
    # "opus"/"claude-opus-4-8" if you'd rather trade speed for raw capability.
    agent_model: str = Field(default="sonnet")
    # Model used when Claude is the selected provider for VISION extraction
    # (screen → problem) via the subscription CLI. Opus does the best OCR but
    # is the slowest/most quota-heavy per frame — override to a faster Claude
    # (e.g. claude-haiku-4-5) if the watch loop feels sluggish.
    claude_vision_model: str = Field(default="claude-opus-4-8")

    # Per-model price overrides for the cost pill, as JSON
    # {"model-id": [input_usd_per_1M, output_usd_per_1M]}. Use it for models
    # not in services/usage.py PRICING (custom / newer IDs).
    model_pricing: str = Field(default="")

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
