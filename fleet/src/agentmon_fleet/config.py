"""Fleet configuration. All settings come from FLEET_* variables (repo-root .env or the environment)."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field
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
    llm_budget_per_cycle: int = 60
    redact_pii: bool = True
    events_jsonl: str | None = Field(default=None, description="Optional path to mirror normalized events (debugging)")
    alerts_jsonl: str | None = Field(default="fleet-alerts.jsonl", description="Local alert log; empty to disable")

    # Inference / network sentinel
    known_callers: list[str] = Field(default_factory=list,
                                     description="Entra object ids allowed to call models directly (apps, pipelines)")
    inference_hourly_token_alert: int = 250_000
    denied_burst_threshold: int = 20
    network_allowed_destinations: list[str] = Field(default_factory=list)

    # Deep content collection is limited to these Foundry projects (endpoint substrings); empty = all accessible.
    content_projects: list[str] = Field(default_factory=list)

    # Charter overrides (*.yaml). Default: fleet/charters in a source checkout; set explicitly for installed packages.
    charter_dir: str | None = None

    # Optional tenant-level collectors (collectors/tenant.py); each needs admin-consented app permissions.
    tenant_purview: bool = False
    purview_start_subscription: bool = False  # let the fleet start the Audit.General subscription
    tenant_entra: bool = False
    tenant_defender: bool = False

    # Real-time hooks
    hooks_audience: list[str] = Field(default_factory=list,
                                      description="Accepted aud values for webhook tokens (app id URI / base URL / app id)")
    hooks_allowed_app_ids: list[str] = Field(default_factory=list, description="Caller app IDs allowed to call hooks")
    hooks_allow_anonymous: bool = False
    hooks_token: str | None = Field(default=None, description="Shared bearer for /evaluate and /events (local/dev)")
    hooks_block_threshold: int = 70
    hooks_mode: Literal["observe", "enforce"] = "observe"  # per-agent charters can opt in to enforce
    hooks_deadline_ms: int = 850

    # TypeSafe Jev (System One) — SHADOW MODE ONLY: answers are recorded for benchmarking and never change
    # verdicts/alerts. Enabled when a key is set and jev_mode != off. The key also reads plain TYPESAFE_API_KEY.
    jev_mode: Literal["off", "shadow"] = "shadow"
    typesafe_api_key: str | None = Field(
        default=None, validation_alias=AliasChoices("FLEET_TYPESAFE_API_KEY", "TYPESAFE_API_KEY", "typesafe_api_key"))
    typesafe_base_url: str | None = Field(
        default=None, validation_alias=AliasChoices("FLEET_TYPESAFE_BASE_URL", "TYPESAFE_BASE_URL", "typesafe_base_url"))
    jev_model: str = "jev-1.13.0"  # pinned: thresholds in jev_questions.py are tuned for this version
    jev_timeout_s: float = 2.0  # offline detectors (per call, hard deadline)
    jev_realtime_timeout_s: float = 0.3  # real-time hook path (per call, hard deadline, no retries)
    jev_budget_per_cycle: int = 2000
    jev_shadow_post: bool = True  # POST shadow records to {monitor_url}/api/gov/jev/shadow
    jev_shadow_jsonl: str | None = Field(default="fleet-jev-shadow.jsonl",
                                         description="Local shadow-record log; empty to disable")

    @property
    def jev_enabled(self) -> bool:
        return bool((self.typesafe_api_key or "").strip()) and self.jev_mode != "off"

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
