variable "name" {
  description = "Globally unique registry name (5-50 alphanumerics)."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "sku" {
  type    = string
  default = "Standard"
}

variable "pull_principal_ids" {
  description = "Map key => principal id granted AcrPull (static keys required)."
  type        = map(string)
  default     = {}
}

variable "push_principal_ids" {
  description = "Map key => principal id granted AcrPush (e.g. the CI/CD deployer)."
  type        = map(string)
  default     = {}
}

variable "log_analytics_workspace_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  premium = var.sku == "Premium"
}

resource "azurerm_container_registry" "this" {
  #checkov:skip=CKV_AZURE_139:Public endpoint required for GitHub-hosted runners; use Premium + private endpoint for locked-down tenants.
  #checkov:skip=CKV_AZURE_165:Geo-replication is optional (Premium) and a cost decision per environment.
  #checkov:skip=CKV_AZURE_233:Zone redundancy is Premium-only and optional.
  #checkov:skip=CKV_AZURE_166:Quarantine requires an external scanner integration; images are Trivy-gated in CI before push.
  #checkov:skip=CKV_AZURE_164:Content trust (DCT) is deprecated by ACR in favour of Notary v2 signing.
  #checkov:skip=CKV_AZURE_237:Dedicated data endpoints are Premium-only.
  #checkov:skip=CKV_AZURE_167:Retention policy is Premium-only; enabled automatically when sku = Premium.
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = var.sku

  # Managed identity / Entra only — never the admin user.
  admin_enabled          = false
  anonymous_pull_enabled = false
  export_policy_enabled  = local.premium ? false : true

  retention_policy_in_days = local.premium ? 7 : null

  tags = var.tags
}

resource "azurerm_role_assignment" "pull" {
  for_each = var.pull_principal_ids

  scope                            = azurerm_container_registry.this.id
  role_definition_name             = "AcrPull"
  principal_id                     = each.value
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "push" {
  for_each = var.push_principal_ids

  scope                = azurerm_container_registry.this.id
  role_definition_name = "AcrPush"
  principal_id         = each.value
}

resource "azurerm_monitor_diagnostic_setting" "this" {
  name                       = "diag-to-log-analytics"
  target_resource_id         = azurerm_container_registry.this.id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category_group = "audit"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

output "id" {
  value = azurerm_container_registry.this.id
}

output "name" {
  value = azurerm_container_registry.this.name
}

output "login_server" {
  value = azurerm_container_registry.this.login_server
}
