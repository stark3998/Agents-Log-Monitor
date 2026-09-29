variable "name" {
  description = "Globally unique vault name (3-24 chars)."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "tenant_id" {
  type = string
}

variable "deployer_object_id" {
  description = "Object id of the principal running Terraform (gets Key Vault Secrets Officer to write secrets)."
  type        = string
}

variable "secret_readers" {
  description = "Least-privilege reads: map \"<app>/<secret>\" => { secret_name, principal_id }. Key Vault Secrets User is granted on the individual secret, not the vault."
  type = map(object({
    secret_name  = string
    principal_id = string
  }))
  default = {}
}

variable "secret_names" {
  description = "Names of secrets to create (non-sensitive so they can drive for_each)."
  type        = set(string)
  default     = []
}

variable "secret_values" {
  description = "Map secret name => value. Must contain every name in secret_names."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "network_default_action" {
  type    = string
  default = "Allow"
}

variable "allowed_ip_ranges" {
  type    = list(string)
  default = []
}

variable "log_analytics_workspace_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_key_vault" "this" {
  #checkov:skip=CKV_AZURE_109:Default action is a variable; Allow is needed for GitHub-hosted runners (see README: self-hosted runner + Deny for prod).
  #checkov:skip=CKV_AZURE_189:Public access is required for GitHub-hosted runners unless private endpoints + self-hosted runners are used.
  #checkov:skip=CKV2_AZURE_32:Private endpoint is optional and provisioned outside this configuration.
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  tenant_id           = var.tenant_id
  sku_name            = "standard"

  # RBAC data-plane authorization (no access policies), soft delete + purge protection.
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 90

  public_network_access_enabled = true

  network_acls {
    bypass = "AzureServices"
    #tfsec:ignore:azure-keyvault-specify-network-acl Default action is a variable (Allow needed for GitHub-hosted runners; set Deny + self-hosted runners for prod).
    default_action = var.network_default_action
    ip_rules       = var.allowed_ip_ranges
  }

  tags = var.tags
}

resource "azurerm_role_assignment" "deployer" {
  scope                = azurerm_key_vault.this.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = var.deployer_object_id
}

# Entra RBAC assignments take a while to propagate to the Key Vault data plane.
resource "time_sleep" "rbac_propagation" {
  create_duration = "60s"

  depends_on = [azurerm_role_assignment.deployer]
}

resource "azurerm_key_vault_secret" "this" {
  #checkov:skip=CKV_AZURE_41:Generated keys/connection strings are rotated by Terraform (taint/replace) — a hard expiry would break the running apps.
  for_each = var.secret_names

  name         = each.key
  value        = var.secret_values[each.key]
  key_vault_id = azurerm_key_vault.this.id
  content_type = "text/plain"
  tags         = var.tags

  depends_on = [time_sleep.rbac_propagation]
}

resource "azurerm_role_assignment" "secret_readers" {
  for_each = var.secret_readers

  scope                            = azurerm_key_vault_secret.this[each.value.secret_name].resource_versionless_id
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = each.value.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# Container Apps resolve secretRefs at revision creation � wait until the reads are authorised.
resource "time_sleep" "reader_propagation" {
  create_duration = "60s"

  triggers = {
    readers = join(",", sort(keys(var.secret_readers)))
  }

  depends_on = [azurerm_role_assignment.secret_readers]
}

resource "azurerm_monitor_diagnostic_setting" "this" {
  name                       = "diag-to-log-analytics"
  target_resource_id         = azurerm_key_vault.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category_group = "audit"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

output "id" {
  description = "Vault id. Waits for RBAC propagation so dependents can write/read secrets immediately."
  value       = azurerm_key_vault.this.id
  depends_on  = [time_sleep.rbac_propagation]
}

output "name" {
  value = azurerm_key_vault.this.name
}

output "vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}

output "secret_ids" {
  description = "Map secret name => versionless secret id (Container Apps always resolve the latest version). Available once reader RBAC has propagated."
  value       = { for k, v in azurerm_key_vault_secret.this : k => v.versionless_id }
  depends_on  = [time_sleep.reader_propagation]
}
