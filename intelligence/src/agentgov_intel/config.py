from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

GuardianAuthority = Literal["recommend", "contain", "autonomous"]


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    return raw.lower() not in {"0", "false", "no", "off"}


def _float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    azure_openai_endpoint: str = field(default_factory=lambda: os.getenv("AZURE_OPENAI_ENDPOINT", ""))
    foundry_project_endpoint: str = field(default_factory=lambda: os.getenv("FOUNDRY_PROJECT_ENDPOINT", ""))
    guardian_deployment: str = field(default_factory=lambda: os.getenv("GUARDIAN_DEPLOYMENT", "gpt-5"))
    chat_deployment: str = field(default_factory=lambda: os.getenv("CHAT_DEPLOYMENT", "gpt-4.1"))
    drafter_deployment: str = field(default_factory=lambda: os.getenv("DRAFTER_DEPLOYMENT", os.getenv("CHAT_DEPLOYMENT", "gpt-4.1")))
    monitor_mcp_url: str = field(default_factory=lambda: os.getenv("MONITOR_MCP_URL", "http://127.0.0.1:4317/mcp"))
    monitor_api_url: str = field(default_factory=lambda: os.getenv("MONITOR_API_URL", "http://127.0.0.1:4317"))
    monitor_token: str = field(default_factory=lambda: os.getenv("MONITOR_TOKEN", ""))
    entra_api_audience: str = field(default_factory=lambda: os.getenv("ENTRA_API_AUDIENCE", ""))
    guardian_authority: GuardianAuthority = field(default_factory=lambda: os.getenv("GUARDIAN_AUTHORITY", "recommend").lower())  # type: ignore[assignment]
    guardian_poll_seconds: float = field(default_factory=lambda: _float("GUARDIAN_POLL_SECONDS", 30.0))
    guardian_enabled: bool = field(default_factory=lambda: _bool("GUARDIAN_ENABLED", True))
    appinsights_connection_string: str = field(default_factory=lambda: os.getenv("APPLICATIONINSIGHTS_CONNECTION_STRING", ""))

    def __post_init__(self) -> None:
        if self.guardian_authority not in {"recommend", "contain", "autonomous"}:
            object.__setattr__(self, "guardian_authority", "recommend")


def load_settings() -> Settings:
    return Settings()
