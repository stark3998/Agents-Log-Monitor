terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.81"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.14"
    }
  }

  # Remote state in an Azure Storage Account (state locking via blob leases is automatic).
  # Values are supplied per environment with `terraform init -backend-config=environments/<env>.backend.hcl`
  # (see environments/dev.backend.hcl.example). Required keys:
  #   resource_group_name, storage_account_name, container_name, key
  # Auth is Entra ID only (use_azuread_auth) + OIDC in GitHub Actions — no storage account keys.
  backend "azurerm" {}
}
