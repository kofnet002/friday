from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ROOT_ENV),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    deepgram_api_key: str = Field(default="")
    gemini_api_key: str = Field(default="")
    openai_api_key: str = Field(default="")
    deepseek_api_key: str = Field(default="")
    backend_url: str = Field(default="http://127.0.0.1:8000")
    redis_url: str = Field(default="redis://127.0.0.1:6379")

    gemini_model: str = Field(default="gemini-2.5-flash")
    openai_model: str = Field(default="gpt-4o")
    deepseek_model: str = Field(default="deepseek-chat")
    deepseek_base_url: str = Field(default="https://api.deepseek.com")
    # Reasoning-tier model for OpenAI used only by coding-mode refine
    # ("Didn't pass?"). GPT-4o without a reasoning trace is genuinely
    # shaky on LeetCode-Hard; o1-mini actually traces the failing input
    # before writing the fix. The reasoning models have a different API:
    # no temperature, max_completion_tokens instead of max_tokens. See
    # _stream_openai(... deep=True) in services/coding_solution.py.
    openai_reasoning_model: str = Field(default="o1-mini")

    # Deepgram streaming config
    deepgram_model: str = Field(default="nova-3")
    deepgram_language: str = Field(default="en-US")
    deepgram_endpointing_ms: int = Field(default=300)
    deepgram_sample_rate: int = Field(default=16000)
    deepgram_channels: int = Field(default=1)

    # Question detection — default to flash-lite so it doesn't share
    # gemini-2.5-flash's free-tier daily bucket with vision + answer streams.
    question_detection_model: str = Field(default="gemini-2.5-flash-lite")
    question_detection_silence_ms: int = Field(default=1200)
    question_detection_transcript_window_s: int = Field(default=30)
    question_detection_min_confidence: float = Field(default=0.7)

    # Vision extraction (coding mode). Must be a model with image input.
    vision_extraction_model: str = Field(default="gemini-2.5-flash")

    # Persistence (SQLite for session context + resume)
    sqlite_path: str = Field(default="data/friday.db")

    # Per-session safety budgets — pre-flight checked before each LLM call
    # and audio second is metered as it's sent to Deepgram.
    session_token_limit: int = Field(default=500_000)
    session_audio_minute_limit: int = Field(default=120)


settings = Settings()
