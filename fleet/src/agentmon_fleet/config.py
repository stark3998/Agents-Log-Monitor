"""Fleet configuration. All settings come from FLEET_* variables (repo-root .env or the environment)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_env_file() -> str | None:
    here = Path(__file__).resolve()
    for parent in [Path.cwd(), *here.parents]:
        candidate = parent / ".env"
        if candidate.is_file():
            return str(candidate)
    return None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="FLEET_", env_file=_find_env_file(), extra="ignore")

    # Identity. Client secret is for local runs; in Container Apps the managed identity is used.
    azure_tenant_id: str | None = None
    azure_client_id: str | None = None
    azure_client_secret: str | None = None
    managed_identity_client_id: str | None = None
    subscription_id: str | None = None

    # Models
    foundry_project_endpoint: str | None = None
    foundry_resource_id: str | None = None
    foundry_api_key: str | None = None
    model_deployment: str = "gpt-5.5"
    fast_model_deployment: str = "gpt-4.1-mini"
    embedding_deployment: str = "text-embedding-3-large"
    llm_enabled: bool = True
    llm_timeout_s: float = 60.0
    fast_llm_timeout_s: float = 0.6
    reasoning_effort: Literal["minimal", "low", "medium", "high"] = "low"

    # Log sources
    law_workspace_id: str | None = None
    law_resource_id: str | None = None
    appinsights_resource_id: str | None = None
    storage_account: str | None = None
    dataverse_org_url: str | None = None
    pp_environment_id: str | None = None

    # Discovery scope
    scope_subscriptions: list[str] = Field(default_factory=list)
    foundry_projects: list[str] = Field(default_factory=list, description="Extra project endpoints to poll")

    # Sinks
    alerts_dce: str | None = None
    alerts_dcr_id: str | None = None
    alerts_stream: str = "Custom-AgentMonAlerts"
    monitor_url: str | None = Field(default="http://127.0.0.1:4317", description="Existing dashboard/governance server")
    monitor_token: str | None = None
    appinsights_connection_string: str | None = None

    # Runtime
    state_db: str = "fleet-state.db"
    poll_interval_s: int = 120
    lookback_minutes: int = 24 * 60
    overlap_minutes: int = 45
    min_alert_severity: Literal["informational", "low", "medium", "high", "critical"] = "low"

    # Real-time hooks
    hooks_audience: str | None = Field(default=None, description="Expected aud for Copilot Studio webhook tokens")
    hooks_allowed_app_ids: list[str] = Field(default_factory=list, description="Caller app IDs allowed to call hooks")
    hooks_allow_anonymous: bool = False
    hooks_block_threshold: int = 70
    hooks_mode: Literal["observe", "enforce"] = "enforce"

    @property
    def project_account_endpoint(self) -> str | None:
        """https://<account>.services.ai.azure.com from the project endpoint."""
        if not self.foundry_project_endpoint:
            return None
        return self.foundry_project_endpoint.split("/api/projects")[0].rstrip("/")

    @property
    def openai_base_url(self) -> str | None:
        acct = self.project_account_endpoint
        return f"{acct}/openai/v1/" if acct else None


@lru_cache
def get_settings() -> Settings:
    return Settings()
