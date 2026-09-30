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
  # The optional monitoring fleet gets its own identity (AcrPull + secret reads flow from local.principal_ids).
  identity_apps = var.enable_fleet ? setunion(local.apps, ["fleet"]) : local.apps

  foundry_enabled       = var.foundry_account_id != ""
  teams_webhook_enabled = nonsensitive(var.teams_webhook_url != "")
  alert_webhook_enabled = nonsensitive(var.alert_webhook_urls != "")

  # Optional fleet secrets: env var => Key Vault secret name, created only when a value is supplied.
  fleet_secret_names = {
    FLEET_MONITOR_TOKEN    = "fleet-monitor-token"
    FLEET_FOUNDRY_API_KEY  = "fleet-foundry-api-key"
    FLEET_TYPESAFE_API_KEY = "fleet-typesafe-api-key"
  }
  fleet_secret_enabled = {
    FLEET_MONITOR_TOKEN    = var.enable_fleet && nonsensitive(var.fleet_monitor_token != "")
    FLEET_FOUNDRY_API_KEY  = var.enable_fleet && nonsensitive(var.fleet_foundry_api_key != "")
    FLEET_TYPESAFE_API_KEY = var.enable_fleet && nonsensitive(var.fleet_typesafe_api_key != "")
  }
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
  apps                = local.identity_apps
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
      "appinsights-connection-string" = concat(["control-plane", "mcp-gateway", "intelligence"], var.enable_fleet ? ["fleet"] : [])
      "gateway-config"                = ["mcp-gateway"]
    },
    local.teams_webhook_enabled ? { "teams-webhook-url" = ["control-plane"] } : {},
    local.alert_webhook_enabled ? { "alert-webhook-urls" = ["control-plane"] } : {},
    { for name, s in local.fleet_secret_names : s => ["fleet"] if local.fleet_secret_enabled[name] },
  )

  secret_values = {
    "redis-url"                     = module.redis.connection_url
    "alert-webhook-secret"          = random_password.alert_webhook_secret.result
    "device-signing-key"            = random_password.device_signing_key.result
    "appinsights-connection-string" = module.observability.app_insights_connection_string
    "gateway-config"                = var.gateway_config_json == "" ? "{\"upstreams\":[]}" : var.gateway_config_json
    "teams-webhook-url"             = var.teams_webhook_url
    "alert-webhook-urls"            = var.alert_webhook_urls
    "fleet-monitor-token"           = var.fleet_monitor_token
    "fleet-foundry-api-key"         = var.fleet_foundry_api_key
    "fleet-typesafe-api-key"        = var.fleet_typesafe_api_key
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
    GOVERNANCE_POLICIES_DIR     = "/app/policies"
    AGENT_MONITOR_DB            = "/app/data/agent-monitor.db"
    ACS_ENDPOINT                = var.communication_enabled ? module.communication[0].endpoint : ""
    ALERT_EMAIL_FROM            = var.communication_enabled ? module.communication[0].sender_address : ""
    ALERT_EMAIL_TO              = join(",", var.alert_email_to)
    # The Azure Bot authenticates as the control-plane managed identity; the Teams route validates tokens for it.
    TEAMS_BOT_APP_ID          = var.bot_enabled ? local.identities["control-plane"].client_id : ""
    TEAMS_APPROVER_OBJECT_IDS = var.bot_enabled ? join(",", var.teams_approver_object_ids) : ""
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

# ---------------------------------------------------------------------------------------------
# Optional: monitoring fleet (fleet/) — worker + real-time hooks. Off unless enable_fleet = true.
# ---------------------------------------------------------------------------------------------
locals {
  fleet_law_resource_id  = var.fleet_law_resource_id != "" ? var.fleet_law_resource_id : module.observability.log_analytics_workspace_id
  fleet_law_workspace_id = var.fleet_law_workspace_id != "" ? var.fleet_law_workspace_id : module.observability.log_analytics_customer_id
  fleet_scope_subscriptions = (
    length(var.fleet_scope_subscriptions) > 0
    ? var.fleet_scope_subscriptions
    : [data.azurerm_client_config.current.subscription_id]
  )
  fleet_foundry_account_ids = distinct(compact(concat([var.foundry_account_id], var.fleet_foundry_account_ids)))

  # Least privilege, mirroring the lab service principal: read logs/metrics/security posture, use
  # Foundry models, read diagnostic blobs, publish alerts to one DCR. Keys are static (plan-time known).
  fleet_role_assignments = merge(
    { "law-log-analytics-reader" = { scope = local.fleet_law_resource_id, role = "Log Analytics Reader" } },
    { for s in local.fleet_scope_subscriptions : "sub-monitoring-reader-${lower(s)}" => { scope = "/subscriptions/${s}", role = "Monitoring Reader" } },
    { for s in local.fleet_scope_subscriptions : "sub-security-reader-${lower(s)}" => { scope = "/subscriptions/${s}", role = "Security Reader" } },
    { for id in local.fleet_foundry_account_ids : "foundry-ai-user-${lower(id)}" => { scope = id, role = "Azure AI User" } },
    { for id in var.fleet_monitored_resource_ids : "monitored-reader-${lower(id)}" => { scope = id, role = "Monitoring Reader" } },
    var.fleet_diagnostics_storage_account_id == "" ? {} : {
      "diag-storage-blob-reader" = { scope = var.fleet_diagnostics_storage_account_id, role = "Storage Blob Data Reader" }
    },
    var.fleet_alerts_dcr_resource_id == "" ? {} : {
      "alerts-dcr-metrics-publisher" = { scope = var.fleet_alerts_dcr_resource_id, role = "Monitoring Metrics Publisher" }
    },
  )

  # pydantic-settings parses list[str] settings from JSON.
  fleet_env = merge({ for k, v in {
    FLEET_AZURE_TENANT_ID          = data.azurerm_client_config.current.tenant_id
    FLEET_SUBSCRIPTION_ID          = local.fleet_scope_subscriptions[0]
    FLEET_SCOPE_SUBSCRIPTIONS      = jsonencode(local.fleet_scope_subscriptions)
    FLEET_FOUNDRY_PROJECT_ENDPOINT = var.fleet_foundry_project_endpoint != "" ? var.fleet_foundry_project_endpoint : (local.foundry_enabled ? module.foundry_access[0].project_endpoint : "")
    FLEET_FOUNDRY_RESOURCE_ID      = length(local.fleet_foundry_account_ids) > 0 ? local.fleet_foundry_account_ids[0] : ""
    FLEET_MODEL_DEPLOYMENT         = var.fleet_model_deployment
    FLEET_FAST_MODEL_DEPLOYMENT    = var.fleet_fast_model_deployment
    FLEET_LAW_WORKSPACE_ID         = local.fleet_law_workspace_id
    FLEET_LAW_RESOURCE_ID          = local.fleet_law_resource_id
    FLEET_APPINSIGHTS_RESOURCE_ID  = var.fleet_appinsights_resource_id
    FLEET_STORAGE_ACCOUNT          = var.fleet_diagnostics_storage_account_id == "" ? "" : element(split("/", var.fleet_diagnostics_storage_account_id), 8)
    FLEET_DATAVERSE_ORG_URL        = var.fleet_dataverse_org_url
    FLEET_PP_ENVIRONMENT_ID        = var.fleet_pp_environment_id
    FLEET_ALERTS_DCE               = var.fleet_alerts_dce
    FLEET_ALERTS_DCR_ID            = var.fleet_alerts_dcr_immutable_id
    FLEET_MONITOR_URL              = var.fleet_monitor_url != "" ? var.fleet_monitor_url : module.container_apps.control_plane_url
  } : k => v if v != "" }, var.fleet_extra_env)

  fleet_hooks_env = {
    FLEET_HOOKS_AUDIENCE        = jsonencode(var.fleet_hooks_audience)
    FLEET_HOOKS_ALLOWED_APP_IDS = jsonencode(var.fleet_hooks_allowed_app_ids)
    FLEET_HOOKS_MODE            = var.fleet_hooks_mode
    FLEET_HOOKS_ALLOW_ANONYMOUS = "false" # never anonymous in Azure
  }

  # Secrets only via Key Vault secretRef — never plain env vars.
  fleet_secret_env = merge(
    { FLEET_APPINSIGHTS_CONNECTION_STRING = "appinsights-connection-string" },
    { for env, s in local.fleet_secret_names : env => s if local.fleet_secret_enabled[env] },
  )
}

module "fleet" {
  source = "./modules/fleet"
  count  = var.enable_fleet ? 1 : 0

  name                         = local.base
  resource_group_name          = local.resource_group_name
  container_app_environment_id = module.container_apps.environment_id
  acr_login_server             = module.acr.login_server
  image_tag                    = var.fleet_image_tag
  deploy_apps                  = var.deploy_apps
  identity = {
    id           = local.identities["fleet"].id
    client_id    = local.identities["fleet"].client_id
    principal_id = local.identities["fleet"].principal_id
  }
  sizing = {
    cpu                    = var.fleet_sizing.cpu
    memory                 = var.fleet_sizing.memory
    hooks_enabled          = var.fleet_sizing.hooks_enabled
    hooks_external_ingress = var.fleet_sizing.hooks_external_ingress
    hooks_cpu              = var.fleet_sizing.hooks_cpu
    hooks_memory           = var.fleet_sizing.hooks_memory
    hooks_min_replicas     = var.fleet_sizing.hooks_min_replicas
    hooks_max_replicas     = var.fleet_sizing.hooks_max_replicas
    hooks_concurrent       = var.fleet_sizing.hooks_concurrent
  }
  worker_args      = var.fleet_worker_args
  env              = local.fleet_env
  hooks_env        = local.fleet_hooks_env
  secret_env       = local.fleet_secret_env
  secrets          = { for s in values(local.fleet_secret_env) : s => local.secret_ids[s] }
  role_assignments = local.fleet_role_assignments
  tags             = local.tags

  # Image pulls need AcrPull (granted to every identity in module.acr).
  depends_on = [module.acr]
}
