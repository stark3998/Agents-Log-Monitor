variable "name" {
  description = "Content Safety account name (also used as the custom subdomain, required for Entra auth)."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "sku_name" {
  type    = string
  default = "S0"
}

variable "public_network_access_enabled" {
  type    = bool
  default = true
}

variable "user_principal_ids" {
  description = "Map key => principal id granted 'Cognitive Services User' (static keys)."
  type        = map(string)
  default     = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_cognitive_account" "this" {
  #checkov:skip=CKV_AZURE_134:Public network access is a variable; private endpoints optional.
  #checkov:skip=CKV2_AZURE_22:Customer-managed keys are optional.
  #checkov:skip=CKV_AZURE_247:Data-loss-prevention outbound restriction not applicable to Content Safety.
  name                  = var.name
  location              = var.location
  resource_group_name   = var.resource_group_name
  kind                  = "ContentSafety"
  sku_name              = var.sku_name
  custom_subdomain_name = var.name

  # Entra ID only — no API keys.
  local_auth_enabled            = false
  public_network_access_enabled = var.public_network_access_enabled

  identity {
    type = "SystemAssigned"
  }

  tags = var.tags
}

resource "azurerm_role_assignment" "user" {
  for_each = var.user_principal_ids

  scope                            = azurerm_cognitive_account.this.id
  role_definition_name             = "Cognitive Services User"
  principal_id                     = each.value
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

output "id" {
  value = azurerm_cognitive_account.this.id
}

output "endpoint" {
  value = azurerm_cognitive_account.this.endpoint
}
