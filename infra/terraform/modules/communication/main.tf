variable "name" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "data_location" {
  type    = string
  default = "United States"
}

variable "sender_principal_ids" {
  description = "Map key => principal id allowed to send email via Entra auth (static keys)."
  type        = map(string)
  default     = {}
}

variable "sender_role_name" {
  description = "Least-privilege built-in role for sending mail with Entra ID."
  type        = string
  default     = "Communication and Email Service Owner"
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_email_communication_service" "this" {
  name                = "ecs-${var.name}"
  resource_group_name = var.resource_group_name
  data_location       = var.data_location
  tags                = var.tags
}

# Azure-managed domain (xxxx.azurecomm.net) — no DNS work. Bring a custom domain for prod.
resource "azurerm_email_communication_service_domain" "managed" {
  name                             = "AzureManagedDomain"
  email_service_id                 = azurerm_email_communication_service.this.id
  domain_management                = "AzureManaged"
  user_engagement_tracking_enabled = false
  tags                             = var.tags
}

resource "azurerm_communication_service" "this" {
  name                = "acs-${var.name}"
  resource_group_name = var.resource_group_name
  data_location       = var.data_location
  tags                = var.tags
}

resource "azurerm_communication_service_email_domain_association" "this" {
  communication_service_id = azurerm_communication_service.this.id
  email_service_domain_id  = azurerm_email_communication_service_domain.managed.id
}

resource "azurerm_role_assignment" "sender" {
  for_each = var.sender_principal_ids

  scope                            = azurerm_communication_service.this.id
  role_definition_name             = var.sender_role_name
  principal_id                     = each.value
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

output "endpoint" {
  description = "ACS_ENDPOINT"
  value       = "https://${azurerm_communication_service.this.hostname}"
}

output "sender_address" {
  description = "ALERT_EMAIL_FROM"
  value       = "DoNotReply@${azurerm_email_communication_service_domain.managed.mail_from_sender_domain}"
}
