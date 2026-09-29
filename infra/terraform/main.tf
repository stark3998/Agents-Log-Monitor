data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 4
  lower   = true
  upper   = false
  numeric = true
  special = false
}

locals {
  base    = "${var.name_prefix}-${var.environment}"                              # agentgov-dev
  compact = "${var.name_prefix}${var.environment}${random_string.suffix.result}" # agentgovdevx1y2 (alnum only)
  unique  = "${local.base}-${random_string.suffix.result}"                       # agentgov-dev-x1y2

  tags = merge({
    application = "agent-governance"
    environment = var.environment
    managed-by  = "terraform"
    repository  = "stark3998/Agents-Log-Monitor"
  }, var.tags)

  apps = toset(["control-plane", "mcp-gateway", "intelligence"])

  foundry_enabled       = var.foundry_account_id != ""
  teams_webhook_enabled = nonsensitive(var.teams_webhook_url != "")
  alert_webhook_enabled = nonsensitive(var.alert_webhook_urls != "")
}

resource "azurerm_resource_group" "this" {
  count = var.resource_group_name == "" ? 1 : 0

  name     = "rg-${local.base}"
  location = var.location
  tags     = local.tags
}

data "azurerm_resource_group" "existing" {
  count = var.resource_group_name == "" ? 0 : 1
  name  = var.resource_group_name
}

locals {
  resource_group_name = var.resource_group_name == "" ? azurerm_resource_group.this[0].name : data.azurerm_resource_group.existing[0].name
}

# ---------------------------------------------------------------------------------------------
# Foundation: logs, identities, registry
# ---------------------------------------------------------------------------------------------
module "observability" {
  source = "./modules/observability"

  name                = local.base
  location            = var.location
  resource_group_name = local.resource_group_name
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

module "identity" {
  source = "./modules/identity"

  name                = local.base
  apps                = local.apps
  location            = var.location
  resource_group_name = local.resource_group_name
  tags                = local.tags
}

locals {
  identities    = module.identity.identities
  principal_ids = { for k, v in module.identity.identities : k => v.principal_id }
}

module "acr" {
  source = "./modules/acr"

  name                       = "acr${local.compact}"
  location                   = var.location
  resource_group_name        = local.resource_group_name
  sku                        = var.acr_sku
  pull_principal_ids         = local.principal_ids
  push_principal_ids         = { deployer = data.azurerm_client_config.current.object_id }
  log_analytics_workspace_id = module.observability.log_analytics_workspace_id
  tags                       = local.tags
}

# ---------------------------------------------------------------------------------------------
# Data plane: Cosmos DB (Entra-only), Azure Managed Redis
# ---------------------------------------------------------------------------------------------
module "cosmos" {
  source = "./modules/cosmos"

  name                           = "cosmos-${local.unique}"
  location                       = var.location
  resource_group_name            = local.resource_group_name
  database_name                  = "agentgov"
  capacity_mode                  = var.cosmos_capacity_mode
  autoscale_max_throughput       = var.cosmos_autoscale_max_throughput
  zone_redundant                 = var.cosmos_zone_redundant
  public_network_access_enabled  = var.public_network_access_enabled
  data_contributor_principal_ids = { for k in ["control-plane", "intelligence"] : k => local.principal_ids[k] }
  log_analytics_workspace_id     = module.observability.log_analytics_workspace_id
  tags                           = local.tags
}

module "redis" {
  source = "./modules/redis"

  name                          = "redis-${local.unique}"
  location                      = var.location
  resource_group_name           = local.resource_group_name
  sku_name                      = var.redis_sku_name
  high_availability_enabled     = var.redis_high_availability_enabled
  public_network_access_enabled = var.public_network_access_enabled
  tags                          = local.tags
}

# ---------------------------------------------------------------------------------------------
# AI: Content Safety (Prompt Shields) + role assignments on the EXISTING Foundry account
# ---------------------------------------------------------------------------------------------
module "content_safety" {
  source = "./modules/content_safety"
  count  = var.content_safety_enabled ? 1 : 0

  name                          = "cs-${local.unique}"
  location                      = var.location
  resource_group_name           = local.resource_group_name
  sku_name                      = var.content_safety_sku
  public_network_access_enabled = var.public_network_access_enabled
  user_principal_ids            = { for k in ["control-plane", "mcp-gateway"] : k => local.principal_ids[k] }
  tags                          = local.tags
}

module "foundry_access" {
  source = "./modules/foundry_access"
  count  = local.foundry_enabled ? 1 : 0

  account_id                = var.foundry_account_id
  openai_endpoint_override  = var.foundry_openai_endpoint
  project_name              = var.foundry_project_name
  openai_user_principal_ids = { for k in ["control-plane", "intelligence"] : k => local.principal_ids[k] }
  ai_user_principal_ids     = { intelligence = local.principal_ids["intelligence"] }
}

module "communication" {
  source = "./modules/communication"
  count  = var.communication_enabled ? 1 : 0

  name                 = local.unique
  resource_group_name  = local.resource_group_name
  data_location        = var.communication_data_location
  sender_principal_ids = { control-plane = local.principal_ids["control-plane"] }
  tags                 = local.tags
}

# ---------------------------------------------------------------------------------------------
# Secrets (Key Vault, RBAC, per-secret reader assignments)
# ---------------------------------------------------------------------------------------------
resource "random_password" "alert_webhook_secret" {
  length  = 48
  special = false
}

resource "random_password" "device_signing_key" {
  length  = 64
  special = false
}

locals {
  # secret name => apps that may read it. Names are non-sensitive so they can drive for_each.
  secret_readers_by_secret = merge(
    {
      "redis-url"                     = ["control-plane"]
      "alert-webhook-secret"          = ["control-plane"]
      "device-signing-key"            = ["control-plane"]
      "appinsights-connection-string" = ["control-plane", "mcp-gateway", "intelligence"]
      "gateway-config"                = ["mcp-gateway"]
    },
    local.teams_webhook_enabled ? { "teams-webhook-url" = ["control-plane"] } : {},
    local.alert_webhook_enabled ? { "alert-webhook-urls" = ["control-plane"] } : {},
  )

  secret_values = {
    "redis-url"                     = module.redis.connection_url
    "alert-webhook-secret"          = random_password.alert_webhook_secret.result
    "device-signing-key"            = random_password.device_signing_key.result
    "appinsights-connection-string" = module.observability.app_insights_connection_string
    "gateway-config"                = var.gateway_config_json == "" ? "{\"upstreams\":[]}" : var.gateway_config_json
    "teams-webhook-url"             = var.teams_webhook_url
    "alert-webhook-urls"            = var.alert_webhook_urls
  }

  secret_readers = merge([
    for secret, readers in local.secret_readers_by_secret : {
      for app in readers : "${app}/${secret}" => {
        secret_name  = secret
        principal_id = local.principal_ids[app]
      }
    }
  ]...)
}

module "keyvault" {
  source = "./modules/keyvault"

  name                       = "kv${local.compact}"
  location                   = var.location
  resource_group_name        = local.resource_group_name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  deployer_object_id         = data.azurerm_client_config.current.object_id
  secret_names               = toset(keys(local.secret_readers_by_secret))
  secret_values              = local.secret_values
  secret_readers             = local.secret_readers
  network_default_action     = var.key_vault_network_default_action
  allowed_ip_ranges          = var.key_vault_allowed_ip_ranges
  log_analytics_workspace_id = module.observability.log_analytics_workspace_id
  tags                       = local.tags
}

# ---------------------------------------------------------------------------------------------
# Entra ID: API (app roles + access_as_user) and dashboard SPA
# ---------------------------------------------------------------------------------------------
module "entra" {
  source = "./modules/entra"

  name                              = local.base
  identifier_uri                    = var.api_identifier_uri
  create_service_principals         = var.create_service_principals
  managed_identity_agent_principals = { for k in ["mcp-gateway", "intelligence"] : k => local.principal_ids[k] }
  app_role_principals               = var.app_role_principals
}

# ---------------------------------------------------------------------------------------------
# Container Apps
# ---------------------------------------------------------------------------------------------
locals {
  secret_ids = module.keyvault.secret_ids

  control_plane_env = { for k, v in {
    AGENT_MONITOR_MODE          = "cloud"
    NODE_ENV                    = "production"
    HOST                        = "0.0.0.0"
    PORT                        = "4317"
    COSMOS_ENDPOINT             = module.cosmos.endpoint
    COSMOS_DATABASE             = module.cosmos.database_name
    FOUNDRY_OPENAI_ENDPOINT     = local.foundry_enabled ? module.foundry_access[0].openai_endpoint : ""
    JUDGE_FAST_DEPLOYMENT       = var.judge_fast_deployment
    JUDGE_ESCALATION_DEPLOYMENT = var.judge_escalation_deployment
    CONTENT_SAFETY_ENDPOINT     = var.content_safety_enabled ? module.content_safety[0].endpoint : ""
    ENTRA_API_AUDIENCE          = module.entra.api_client_id
    ENTRA_SPA_CLIENT_ID         = module.entra.spa_client_id
    ENTRA_TENANT_ID             = module.entra.tenant_id
    AZURE_TENANT_ID             = module.entra.tenant_id
    GOVERNANCE_TENANT_ID        = var.governance_tenant_id
    GOVERNANCE_ENFORCE          = tostring(var.governance_enforce)
    GOVERNANCE_TRUST_LOOPBACK   = "false" # never trust loopback callers in the cloud
    GOVERNANCE_LANES_DIR        = "/app/lanes"
    AGENT_MONITOR_DB            = "/app/data/agent-monitor.db"
    ACS_ENDPOINT                = var.communication_enabled ? module.communication[0].endpoint : ""
    ALERT_EMAIL_FROM            = var.communication_enabled ? module.communication[0].sender_address : ""
    ALERT_EMAIL_TO              = join(",", var.alert_email_to)
  } : k => v if v != "" }

  control_plane_secret_env = merge(
    {
      REDIS_URL                             = "redis-url"
      ALERT_WEBHOOK_SECRET                  = "alert-webhook-secret"
      GOVERNANCE_DEVICE_SIGNING_KEY         = "device-signing-key"
      APPLICATIONINSIGHTS_CONNECTION_STRING = "appinsights-connection-string"
    },
    local.teams_webhook_enabled ? { TEAMS_WEBHOOK_URL = "teams-webhook-url" } : {},
    local.alert_webhook_enabled ? { ALERT_WEBHOOK_URLS = "alert-webhook-urls" } : {},
  )

  gateway_env = { for k, v in {
    NODE_ENV                   = "production"
    GATEWAY_HOST               = "0.0.0.0"
    AGENT_GATEWAY_PORT         = "8080"
    AGENT_GATEWAY_AUDIENCE     = module.entra.api_client_id
    AGENT_GATEWAY_PDP_AUDIENCE = module.entra.api_client_id
    ENTRA_API_AUDIENCE         = module.entra.api_client_id
    ENTRA_TENANT_ID            = module.entra.tenant_id
    AZURE_TENANT_ID            = module.entra.tenant_id
    CONTENT_SAFETY_ENDPOINT    = var.content_safety_enabled ? module.content_safety[0].endpoint : ""
  } : k => v if v != "" }

  gateway_secret_env = {
    APPLICATIONINSIGHTS_CONNECTION_STRING = "appinsights-connection-string"
  }

  intelligence_env = { for k, v in {
    AZURE_OPENAI_ENDPOINT    = local.foundry_enabled ? module.foundry_access[0].openai_endpoint : ""
    FOUNDRY_PROJECT_ENDPOINT = local.foundry_enabled ? module.foundry_access[0].project_endpoint : ""
    GUARDIAN_DEPLOYMENT      = var.guardian_deployment
    ENTRA_API_AUDIENCE       = module.entra.api_client_id
    AZURE_TENANT_ID          = module.entra.tenant_id
  } : k => v if v != "" }

  intelligence_secret_env = {
    APPLICATIONINSIGHTS_CONNECTION_STRING = "appinsights-connection-string"
  }
}

module "container_apps" {
  source = "./modules/container_apps"

  name                           = local.base
  location                       = var.location
  resource_group_name            = local.resource_group_name
  log_analytics_workspace_id     = module.observability.log_analytics_workspace_id
  infrastructure_subnet_id       = var.infrastructure_subnet_id
  internal_load_balancer_enabled = var.internal_load_balancer_enabled
  deploy_apps                    = var.deploy_apps
  acr_login_server               = module.acr.login_server
  image_tag                      = var.image_tag
  identities                     = { for k, v in local.identities : k => { id = v.id, client_id = v.client_id } }
  tags                           = local.tags

  control_plane = {
    cpu                 = var.control_plane.cpu
    memory              = var.control_plane.memory
    min_replicas        = var.control_plane.min_replicas
    max_replicas        = var.control_plane.max_replicas
    concurrent_requests = var.control_plane.concurrent_requests
  }
  gateway = {
    enabled             = var.gateway.enabled
    external_ingress    = var.gateway.external_ingress
    cpu                 = var.gateway.cpu
    memory              = var.gateway.memory
    min_replicas        = var.gateway.min_replicas
    max_replicas        = var.gateway.max_replicas
    concurrent_requests = var.gateway.concurrent_requests
  }
  intelligence = {
    enabled             = var.intelligence.enabled
    cpu                 = var.intelligence.cpu
    memory              = var.intelligence.memory
    min_replicas        = var.intelligence.min_replicas
    max_replicas        = var.intelligence.max_replicas
    concurrent_requests = var.intelligence.concurrent_requests
  }

  control_plane_env        = local.control_plane_env
  control_plane_secret_env = local.control_plane_secret_env
  control_plane_secrets    = { for s in values(local.control_plane_secret_env) : s => local.secret_ids[s] }

  gateway_env                = local.gateway_env
  gateway_secret_env         = local.gateway_secret_env
  gateway_config_secret_name = "gateway-config"
  gateway_secrets = {
    for s in concat(values(local.gateway_secret_env), ["gateway-config"]) : s => local.secret_ids[s]
  }

  intelligence_env        = local.intelligence_env
  intelligence_secret_env = local.intelligence_secret_env
  intelligence_secrets    = { for s in values(local.intelligence_secret_env) : s => local.secret_ids[s] }

  # Image pulls need AcrPull; Foundry/Cosmos roles are needed at first request, not start-up.
  depends_on = [module.acr]
}

# SPA redirect URIs depend on the Container App FQDN, so they're managed outside the entra module.
resource "azuread_application_redirect_uris" "spa" {
  application_id = module.entra.spa_application_id
  type           = "SPA"
  redirect_uris = distinct(concat(
    ["${module.container_apps.control_plane_url}/"],
    ["http://localhost:5173/", "http://127.0.0.1:4317/"],
    var.spa_extra_redirect_uris,
  ))
}

# ---------------------------------------------------------------------------------------------
# Optional: Azure Bot (Teams Action.Execute approvals)
# ---------------------------------------------------------------------------------------------
module "bot" {
  source = "./modules/bot"
  count  = var.bot_enabled ? 1 : 0

  name                = local.unique
  resource_group_name = local.resource_group_name
  sku                 = var.bot_sku
  tenant_id           = data.azurerm_client_config.current.tenant_id
  identity = {
    id        = local.identities["control-plane"].id
    client_id = local.identities["control-plane"].client_id
  }
  messaging_endpoint = "${module.container_apps.control_plane_url}${var.bot_messaging_path}"
  tags               = local.tags
}
