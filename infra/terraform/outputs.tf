output "resource_group_name" {
  value = local.resource_group_name
}

output "location" {
  value = var.location
}

# --- Registry / images --------------------------------------------------------------------
output "acr_name" {
  description = "Set as the GitHub environment variable ACR_NAME."
  value       = module.acr.name
}

output "acr_login_server" {
  value = module.acr.login_server
}

output "image_repositories" {
  description = "Image repositories; tags are always the git SHA."
  value = {
    control_plane = "${module.acr.login_server}/agentgov/control-plane"
    mcp_gateway   = "${module.acr.login_server}/agentgov/mcp-gateway"
    intelligence  = "${module.acr.login_server}/agentgov/intelligence"
  }
}

# --- Container Apps ---------------------------------------------------------------------
output "container_app_environment_name" {
  value = module.container_apps.environment_name
}

output "container_app_names" {
  value = module.container_apps.app_names
}

output "control_plane_url" {
  description = "Dashboard, PDP (/v1/decide), hooks and /mcp. Local enforcers use it as GOVERNANCE_CONTROL_PLANE_URL."
  value       = module.container_apps.control_plane_url
}

output "mcp_gateway_url" {
  description = "Point Foundry agents / Copilot Studio MCP tool connections at <url>/mcp."
  value       = module.container_apps.gateway_url
}

output "intelligence_url" {
  description = "Internal-only URL of the intelligence service."
  value       = module.container_apps.intelligence_url
}

output "managed_identities" {
  description = "Per-app user-assigned managed identity client ids."
  value       = { for k, v in local.identities : k => v.client_id }
}

# --- Data / secrets ---------------------------------------------------------------------
output "cosmos_endpoint" {
  value = module.cosmos.endpoint
}

output "cosmos_account_name" {
  value = module.cosmos.name
}

output "redis_hostname" {
  value = module.redis.hostname
}

output "key_vault_name" {
  value = module.keyvault.name
}

output "key_vault_uri" {
  value = module.keyvault.vault_uri
}

output "log_analytics_workspace_id" {
  value = module.observability.log_analytics_customer_id
}

output "content_safety_endpoint" {
  value = var.content_safety_enabled ? module.content_safety[0].endpoint : ""
}

output "foundry_openai_endpoint" {
  value = local.foundry_enabled ? module.foundry_access[0].openai_endpoint : ""
}

# --- Entra ID ---------------------------------------------------------------------------
output "entra_tenant_id" {
  value = module.entra.tenant_id
}

output "entra_api_client_id" {
  description = "ENTRA_API_AUDIENCE."
  value       = module.entra.api_client_id
}

output "entra_api_scope" {
  description = "Scope requested by the dashboard (MSAL) and CLI clients."
  value       = module.entra.api_scope
}

output "entra_spa_client_id" {
  description = "Dashboard (MSAL) client id."
  value       = module.entra.spa_client_id
}

output "entra_app_role_ids" {
  value = module.entra.api_app_role_ids
}

output "email_sender_address" {
  value = var.communication_enabled ? module.communication[0].sender_address : ""
}

output "bot_name" {
  value = var.bot_enabled ? module.bot[0].bot_name : ""
}

# --- Monitoring fleet (optional) --------------------------------------------------------
output "fleet_enabled" {
  value = var.enable_fleet
}

output "fleet_app_names" {
  description = "Fleet Container App names ({} when enable_fleet = false). CD rolls these to agentgov/fleet:<sha>."
  value       = var.enable_fleet ? module.fleet[0].app_names : {}
}

output "fleet_hooks_url" {
  description = "Copilot Studio webhook base URL (<url>/copilot-studio/analyze-tool-execution). Empty when disabled."
  value       = var.enable_fleet ? module.fleet[0].hooks_url : ""

  # Hooks without an accepted audience reject every webhook call (fail closed), so fail the plan instead.
  # (A precondition rather than a top-level `check` block: tfsec cannot parse `check` blocks.)
  precondition {
    condition     = !var.enable_fleet || !var.fleet_sizing.hooks_enabled || length(var.fleet_hooks_audience) > 0
    error_message = "enable_fleet: fleet_hooks_audience is empty, so the hooks app would reject all webhook calls. Set it to the hooks app registration's app id / app id URI, or set fleet_sizing.hooks_enabled = false."
  }
}

output "fleet_identity_client_id" {
  description = "Fleet managed identity client id (add it as a Dataverse application user for transcript collection)."
  value       = var.enable_fleet ? local.identities["fleet"].client_id : ""
}

output "fleet_image_repository" {
  value = "${module.acr.login_server}/agentgov/fleet"
}
