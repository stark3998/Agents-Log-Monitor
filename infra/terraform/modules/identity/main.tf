variable "name" {
  description = "Base name (e.g. agentgov-dev)."
  type        = string
}

variable "apps" {
  description = "App keys that each get a dedicated user-assigned managed identity."
  type        = set(string)
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

resource "azurerm_user_assigned_identity" "this" {
  for_each = var.apps

  name                = "id-${var.name}-${each.key}"
  location            = var.location
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

output "identities" {
  description = "Map app => { id, principal_id, client_id }."
  value = {
    for k, v in azurerm_user_assigned_identity.this : k => {
      id           = v.id
      principal_id = v.principal_id
      client_id    = v.client_id
      name         = v.name
    }
  }
}
