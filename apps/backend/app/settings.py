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
    backend_url: str = Field(default="http://127.0.0.1:8000")
    redis_url: str = Field(default="redis://127.0.0.1:6379")

    gemini_model: str = Field(default="gemini-2.5-flash")
    openai_model: str = Field(default="gpt-5")

    # Deepgram streaming config
    deepgram_model: str = Field(default="nova-3")
    deepgram_language: str = Field(default="en-US")
    deepgram_endpointing_ms: int = Field(default=300)
    deepgram_sample_rate: int = Field(default=16000)
    deepgram_channels: int = Field(default=1)

    # Question detection
    question_detection_model: str = Field(default="gemini-2.5-flash")
    question_detection_silence_ms: int = Field(default=1200)
    question_detection_transcript_window_s: int = Field(default=30)
    question_detection_min_confidence: float = Field(default=0.7)

    # Persistence (SQLite for session context + resume)
    sqlite_path: str = Field(default="data/friday.db")


settings = Settings()
