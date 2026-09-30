from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

GuardianAuthority = Literal["recommend", "contain", "autonomous"]


def _env_file() -> Path | None:
    """Same resolution as the Node server: AGENT_MONITOR_ENV_FILE (``none`` disables), else ``<repo root>/.env``."""
    configured = os.getenv("AGENT_MONITOR_ENV_FILE", "").strip()
    if configured:
        return None if re.fullmatch(r"none|off|false|0", configured, re.IGNORECASE) else Path(configured).resolve()
    package_root = Path(__file__).resolve().parents[2]  # intelligence/ in a source checkout
    if (package_root / "pyproject.toml").is_file():
        return package_root.parent / ".env"
    return None


def load_env_file() -> Path | None:
    """Load the project ``.env`` into ``os.environ``. Real variables win; empty values are ignored."""
    path = _env_file()
    if path is None or not path.is_file():
        return None
    from dotenv import dotenv_values

    for key, value in dotenv_values(path).items():
        if key == "AGENT_MONITOR_ENV_FILE" or not value or key in os.environ:
            continue
        os.environ[key] = value
    return path


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
    # TypeSafe Jev (System One) — shadow mode only; never changes Guardian behaviour.
    typesafe_api_key: str = field(default_factory=lambda: os.getenv("TYPESAFE_API_KEY", ""))
    typesafe_base_url: str = field(default_factory=lambda: os.getenv("TYPESAFE_BASE_URL", ""))
    # Pinned, versioned model: combine thresholds are tuned per version (jev-latest moves).
    jev_model: str = field(default_factory=lambda: os.getenv("JEV_MODEL", "") or "jev-1.13.0")
    jev_timeout_ms: float = field(default_factory=lambda: _float("JEV_TIMEOUT_MS", 2000.0))
    jev_shadow: bool = field(default_factory=lambda: _bool("JEV_SHADOW", True))
    jev_shadow_guardian: bool = field(default_factory=lambda: _bool("JEV_SHADOW_GUARDIAN", True))

    def __post_init__(self) -> None:
        if self.guardian_authority not in {"recommend", "contain", "autonomous"}:
            object.__setattr__(self, "guardian_authority", "recommend")
        if self.jev_timeout_ms <= 0:
            object.__setattr__(self, "jev_timeout_ms", 2000.0)

    @property
    def jev_enabled(self) -> bool:
        """Jev shadow is on only when a key is configured and ``JEV_SHADOW`` is not switched off."""
        return bool(self.typesafe_api_key) and self.jev_shadow

    @property
    def jev_guardian_enabled(self) -> bool:
        return self.jev_enabled and self.jev_shadow_guardian


def load_settings() -> Settings:
    load_env_file()
    return Settings()
