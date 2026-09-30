variable "name" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "sku" {
  type    = string
  default = "F0"
}

variable "tenant_id" {
  type = string
}

variable "identity" {
  description = "User-assigned managed identity the bot authenticates as (the control plane's)."
  type = object({
    id        = string
    client_id = string
  })
}

variable "messaging_endpoint" {
  description = "https://<control-plane>/api/gov/teams/messages"
  type        = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

# Optional add-on: Teams Action.Execute approval cards. The default path uses deep-link cards via
# TEAMS_WEBHOOK_URL and needs no bot.
resource "azurerm_bot_service_azure_bot" "this" {
  name                = "bot-${var.name}"
  resource_group_name = var.resource_group_name
  location            = "global"
  sku                 = var.sku
  display_name        = "Agent Governance approvals"
  endpoint            = var.messaging_endpoint

  # Managed-identity bot: no app password / client secret.
  microsoft_app_type      = "UserAssignedMSI"
  microsoft_app_id        = var.identity.client_id
  microsoft_app_msi_id    = var.identity.id
  microsoft_app_tenant_id = var.tenant_id

  local_authentication_enabled = false
  tags                         = var.tags
}

resource "azurerm_bot_channel_ms_teams" "this" {
  bot_name            = azurerm_bot_service_azure_bot.this.name
  location            = azurerm_bot_service_azure_bot.this.location
  resource_group_name = var.resource_group_name
}

output "bot_name" {
  value = azurerm_bot_service_azure_bot.this.name
}

output "microsoft_app_id" {
  value = var.identity.client_id
}
