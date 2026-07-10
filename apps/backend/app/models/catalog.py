from typing import Literal

Provider = Literal["gemini", "openai", "deepseek", "claude"]

MODEL_PROVIDERS: dict[str, Provider] = {
    "gemini-2.5-flash": "gemini",
    "gemini-2.5-pro": "gemini",
    "gpt-4o": "openai",
    "gpt-5.5": "openai",
    "gpt-5.6": "openai",
    "deepseek-chat": "deepseek",
    "claude-opus-4-8": "claude",
    "claude-sonnet-4-6": "claude",
}

def provider_for_model(model: str) -> Provider | None:
    return MODEL_PROVIDERS.get(model)
