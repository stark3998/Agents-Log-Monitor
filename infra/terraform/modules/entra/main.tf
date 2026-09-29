variable "name" {
  description = "Base display name (e.g. agentgov-dev)."
  type        = string
}

variable "identifier_uri" {
  description = "API identifier URI. Empty = api://<name>-api."
  type        = string
  default     = ""
}

variable "owners" {
  description = "Object ids that own the app registrations (the deployer is always added)."
  type        = list(string)
  default     = []
}

variable "create_service_principals" {
  type    = bool
  default = true
}

variable "managed_identity_agent_principals" {
  description = "Map key => managed identity principal id granted the Agent app role (workload-to-control-plane calls)."
  type        = map(string)
  default     = {}
}

variable "app_role_principals" {
  description = "Role value => list of user/group object ids."
  type        = map(list(string))
  default     = {}
}

data "azuread_client_config" "current" {}

locals {
  identifier_uri = var.identifier_uri != "" ? var.identifier_uri : "api://${var.name}-api"
  owners         = distinct(concat([data.azuread_client_config.current.object_id], var.owners))

  roles = {
    Viewer = {
      display_name = "Viewer"
      description  = "Read agents, sessions, decisions, lanes, incidents and audit."
      member_types = ["User"]
    }
    Approver = {
      display_name = "Approver"
      description  = "Approve or deny pending governed actions."
      member_types = ["User"]
    }
    PolicyAdmin = {
      display_name = "Policy administrator"
      description  = "Author/activate lanes, pause/quarantine agents, manage enrollment."
      member_types = ["User"]
    }
    Agent = {
      display_name = "Agent"
      description  = "Workload identity of a governed agent / enforcer calling the PDP and sync APIs."
      member_types = ["Application", "User"]
    }
  }

  # Flatten { role => [oid...] } into assignable pairs with static keys.
  role_assignments = merge([
    for role, oids in var.app_role_principals : {
      for oid in oids : "${role}/${oid}" => { role = role, principal = oid }
    }
  ]...)
}

resource "random_uuid" "role" {
  for_each = local.roles
}

resource "random_uuid" "scope" {}

# ---------------------------------------------------------------------------------------------
# API app: audience for the control plane, /mcp and the MCP gateway.
# ---------------------------------------------------------------------------------------------
resource "azuread_application" "api" {
  display_name     = "${var.name}-api"
  sign_in_audience = "AzureADMyOrg"
  identifier_uris  = [local.identifier_uri]
  owners           = local.owners

  api {
    # v2 tokens: aud = client id (ENTRA_API_AUDIENCE).
    requested_access_token_version = 2

    oauth2_permission_scope {
      id                         = random_uuid.scope.result
      value                      = "access_as_user"
      type                       = "User"
      enabled                    = true
      admin_consent_display_name = "Access the agent governance control plane"
      admin_consent_description  = "Allows the app to call the agent governance control plane on behalf of the signed-in user."
      user_consent_display_name  = "Access the agent governance control plane"
      user_consent_description   = "Allows the app to call the agent governance control plane on your behalf."
    }
  }

  dynamic "app_role" {
    for_each = local.roles
    content {
      id                   = random_uuid.role[app_role.key].result
      value                = app_role.key
      display_name         = app_role.value.display_name
      description          = app_role.value.description
      allowed_member_types = app_role.value.member_types
      enabled              = true
    }
  }

  optional_claims {
    access_token {
      name = "idtyp"
    }
  }
}

# ---------------------------------------------------------------------------------------------
# SPA app: MSAL sign-in for the dashboard (auth code + PKCE). Redirect URIs are managed by
# azuread_application_redirect_uris in the root module (they depend on the Container App FQDN).
# ---------------------------------------------------------------------------------------------
resource "azuread_application" "spa" {
  display_name     = "${var.name}-dashboard"
  sign_in_audience = "AzureADMyOrg"
  owners           = local.owners

  required_resource_access {
    resource_app_id = azuread_application.api.client_id

    resource_access {
      id   = random_uuid.scope.result
      type = "Scope"
    }
  }

  lifecycle {
    ignore_changes = [single_page_application]
  }
}

resource "azuread_service_principal" "api" {
  count = var.create_service_principals ? 1 : 0

  client_id = azuread_application.api.client_id
  owners    = local.owners
  # Only principals with an app role assignment can get tokens for the API.
  app_role_assignment_required = true
}

resource "azuread_service_principal" "spa" {
  count = var.create_service_principals ? 1 : 0

  client_id = azuread_application.spa.client_id
  owners    = local.owners
}

# Container App managed identities call the control plane with the Agent role.
resource "azuread_app_role_assignment" "managed_identities" {
  for_each = var.create_service_principals ? var.managed_identity_agent_principals : {}

  app_role_id         = random_uuid.role["Agent"].result
  principal_object_id = each.value
  resource_object_id  = azuread_service_principal.api[0].object_id
}

resource "azuread_app_role_assignment" "principals" {
  for_each = var.create_service_principals ? local.role_assignments : {}

  app_role_id         = random_uuid.role[each.value.role].result
  principal_object_id = each.value.principal
  resource_object_id  = azuread_service_principal.api[0].object_id
}

output "tenant_id" {
  value = data.azuread_client_config.current.tenant_id
}

output "api_client_id" {
  description = "ENTRA_API_AUDIENCE (v2 tokens carry aud = client id)."
  value       = azuread_application.api.client_id
}

output "api_identifier_uri" {
  value = local.identifier_uri
}

output "api_scope" {
  description = "Scope the dashboard / CLI requests."
  value       = "${local.identifier_uri}/access_as_user"
}

output "api_app_role_ids" {
  value = { for k, v in random_uuid.role : k => v.result }
}

output "spa_client_id" {
  value = azuread_application.spa.client_id
}

output "spa_application_id" {
  description = "Resource id of the SPA application (for azuread_application_redirect_uris)."
  value       = azuread_application.spa.id
}
