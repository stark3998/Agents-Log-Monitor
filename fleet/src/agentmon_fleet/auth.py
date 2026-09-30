"""Credential selection: service principal (local), managed identity (Container Apps), else developer login."""
from __future__ import annotations

import os
from functools import lru_cache

from azure.core.credentials import TokenCredential
from azure.identity import (
    ChainedTokenCredential,
    ClientSecretCredential,
    DefaultAzureCredential,
    ManagedIdentityCredential,
    get_bearer_token_provider,
)

from .config import Settings, get_settings

AI_SCOPE = "https://ai.azure.com/.default"
COGNITIVE_SCOPE = "https://cognitiveservices.azure.com/.default"
ARM_SCOPE = "https://management.azure.com/.default"
MONITOR_SCOPE = "https://monitor.azure.com/.default"


def _running_in_azure() -> bool:
    return bool(os.environ.get("IDENTITY_ENDPOINT") or os.environ.get("MSI_ENDPOINT"))


def build_credential(settings: Settings) -> TokenCredential:
    if _running_in_azure():
        return ManagedIdentityCredential(client_id=settings.managed_identity_client_id)
    if settings.azure_client_id and settings.azure_client_secret and settings.azure_tenant_id:
        return ClientSecretCredential(settings.azure_tenant_id, settings.azure_client_id, settings.azure_client_secret)
    return ChainedTokenCredential(DefaultAzureCredential(exclude_interactive_browser_credential=True))


@lru_cache
def credential() -> TokenCredential:
    return build_credential(get_settings())


def token_provider(scope: str = AI_SCOPE):
    return get_bearer_token_provider(credential(), scope)


def bearer(scope: str) -> str:
    return credential().get_token(scope).token
