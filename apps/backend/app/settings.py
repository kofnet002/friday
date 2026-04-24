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

    gemini_model: str = Field(default="gemini-2.5-pro")
    openai_model: str = Field(default="gpt-5")


settings = Settings()
