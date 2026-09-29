# Authentication:
#  - GitHub Actions: OIDC federated credential (ARM_USE_OIDC=true, ARM_CLIENT_ID, ARM_TENANT_ID,
#    ARM_SUBSCRIPTION_ID). No client secret anywhere.
#  - Local: `az login` (Azure CLI auth).
provider "azurerm" {
  subscription_id     = var.subscription_id
  storage_use_azuread = true

  features {
    key_vault {
      # Purge protection is on; never purge on destroy and recover soft-deleted vaults/secrets.
      purge_soft_delete_on_destroy          = false
      purge_soft_deleted_secrets_on_destroy = false
      recover_soft_deleted_key_vaults       = true
      recover_soft_deleted_secrets          = true
    }
    cognitive_account {
      purge_soft_delete_on_destroy = false
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }
}

provider "azuread" {
  tenant_id = var.tenant_id
}
