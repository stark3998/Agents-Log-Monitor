# ---------------------------------------------------------------------------------------------
# Core
# ---------------------------------------------------------------------------------------------
variable "subscription_id" {
  description = "Azure subscription id. Leave null to use ARM_SUBSCRIPTION_ID (GitHub OIDC) or the Azure CLI default."
  type        = string
  default     = null
}

variable "tenant_id" {
  description = "Entra tenant id for the azuread provider. Leave null to use ARM_TENANT_ID / Azure CLI."
  type        = string
  default     = null
}

variable "environment" {
  description = "Deployment environment name."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of dev, staging, prod."
  }
}

variable "location" {
  description = "Azure region for all regional resources."
  type        = string
  default     = "eastus2"
}

variable "name_prefix" {
  description = "Short lowercase prefix used in every resource name (3-10 chars, letters/digits)."
  type        = string
  default     = "agentgov"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,9}$", var.name_prefix))
    error_message = "name_prefix must be 3-10 lowercase letters/digits and start with a letter."
  }
}

variable "resource_group_name" {
  description = "Existing resource group to deploy into. Empty = create rg-<prefix>-<env>."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Extra tags merged onto every resource."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------------------------
# Images / apps
# ---------------------------------------------------------------------------------------------
variable "deploy_apps" {
  description = "Create the Container Apps. Set false for the first bootstrap run (before any image exists in ACR)."
  type        = bool
  default     = true
}

variable "image_tag" {
  description = "Image tag (git SHA) used when the Container Apps are first created. Later rollouts are done by `az containerapp update` in CD, so Terraform ignores image drift."
  type        = string
  default     = ""

  validation {
    condition     = var.image_tag != "latest"
    error_message = "Never deploy the :latest tag — use the git SHA."
  }
}

variable "acr_sku" {
  description = "ACR SKU. Premium enables private endpoints, geo-replication, retention and trust policies."
  type        = string
  default     = "Standard"

  validation {
    condition     = contains(["Basic", "Standard", "Premium"], var.acr_sku)
    error_message = "acr_sku must be Basic, Standard or Premium."
  }
}

variable "control_plane" {
  description = "Sizing/scaling for the TypeScript control plane."
  type = object({
    cpu                 = optional(number, 0.5)
    memory              = optional(string, "1Gi")
    min_replicas        = optional(number, 1)
    max_replicas        = optional(number, 5)
    concurrent_requests = optional(number, 50)
  })
  default = {}
}

variable "gateway" {
  description = "Sizing/ingress for the governance MCP gateway."
  type = object({
    enabled             = optional(bool, true)
    external_ingress    = optional(bool, false)
    cpu                 = optional(number, 0.25)
    memory              = optional(string, "0.5Gi")
    min_replicas        = optional(number, 1)
    max_replicas        = optional(number, 5)
    concurrent_requests = optional(number, 50)
  })
  default = {}
}

variable "gateway_config_json" {
  description = "agent-gateway.json content (upstream MCP servers). Stored in Key Vault and mounted as a secret volume. May contain upstream credentials."
  type        = string
  default     = "{\"upstreams\":[]}"
  sensitive   = true
}

variable "intelligence" {
  description = "Sizing for the Python intelligence service (Guardian, lane drafter, chat)."
  type = object({
    enabled             = optional(bool, true)
    cpu                 = optional(number, 0.5)
    memory              = optional(string, "1Gi")
    min_replicas        = optional(number, 1)
    max_replicas        = optional(number, 3)
    concurrent_requests = optional(number, 20)
  })
  default = {}
}

variable "governance_tenant_id" {
  description = "Logical tenant id used for Cosmos partitioning (GOVERNANCE_TENANT_ID)."
  type        = string
  default     = "default"
}

variable "governance_enforce" {
  description = "GOVERNANCE_ENFORCE master switch. false forces every lane into observe mode."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------------------------
variable "infrastructure_subnet_id" {
  description = "Optional subnet id (/23 or larger, delegated to Microsoft.App/environments) for VNet-integrated Container Apps. null = Microsoft-managed network."
  type        = string
  default     = null
}

variable "internal_load_balancer_enabled" {
  description = "Only valid with infrastructure_subnet_id: make the environment's ingress VNet-internal (no public IP)."
  type        = bool
  default     = false
}

variable "public_network_access_enabled" {
  description = "Public network access for Cosmos / Content Safety / Redis. Set false only when private endpoints are provisioned (not managed by this configuration)."
  type        = bool
  default     = true
}

variable "key_vault_network_default_action" {
  description = "Key Vault firewall default action. Allow is required for GitHub-hosted runners to write secrets unless you use self-hosted runners in the VNet."
  type        = string
  default     = "Allow"

  validation {
    condition     = contains(["Allow", "Deny"], var.key_vault_network_default_action)
    error_message = "key_vault_network_default_action must be Allow or Deny."
  }
}

variable "key_vault_allowed_ip_ranges" {
  description = "CIDRs allowed through the Key Vault firewall when default action is Deny."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------------------------
variable "cosmos_capacity_mode" {
  description = "serverless (pay-per-request, single region) or autoscale (provisioned autoscale RU/s shared at database level)."
  type        = string
  default     = "serverless"

  validation {
    condition     = contains(["serverless", "autoscale"], var.cosmos_capacity_mode)
    error_message = "cosmos_capacity_mode must be serverless or autoscale."
  }
}

variable "cosmos_autoscale_max_throughput" {
  description = "Database-level autoscale max RU/s (only when cosmos_capacity_mode = autoscale)."
  type        = number
  default     = 1000
}

variable "cosmos_zone_redundant" {
  description = "Zone redundancy for the Cosmos primary region (not supported for serverless in all regions)."
  type        = bool
  default     = false
}

variable "redis_sku_name" {
  description = "Azure Managed Redis SKU (e.g. Balanced_B0 dev, Balanced_B1/B3 prod)."
  type        = string
  default     = "Balanced_B0"
}

variable "redis_high_availability_enabled" {
  description = "Azure Managed Redis high availability (replica). Disable only for dev to halve the cost."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  description = "Log Analytics / App Insights retention."
  type        = number
  default     = 30
}

# ---------------------------------------------------------------------------------------------
# AI: existing Microsoft Foundry resource + Content Safety
# ---------------------------------------------------------------------------------------------
variable "foundry_account_id" {
  description = "Resource id of the EXISTING Foundry / AI Services (or Azure OpenAI) account, e.g. /subscriptions/.../providers/Microsoft.CognitiveServices/accounts/my-foundry. Empty = no LLM judge."
  type        = string
  default     = ""

  validation {
    condition     = var.foundry_account_id == "" || can(regex("(?i)^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft.CognitiveServices/accounts/[^/]+$", var.foundry_account_id))
    error_message = "foundry_account_id must be a Microsoft.CognitiveServices/accounts resource id."
  }
}

variable "foundry_openai_endpoint" {
  description = "Override for FOUNDRY_OPENAI_ENDPOINT. Empty = https://<custom-subdomain>.openai.azure.com/ derived from the account."
  type        = string
  default     = ""
}

variable "foundry_project_name" {
  description = "Foundry project name under the account (for FOUNDRY_PROJECT_ENDPOINT used by the intelligence service). Empty = not set."
  type        = string
  default     = ""
}

variable "judge_fast_deployment" {
  description = "Model deployment name for the fast judge (JUDGE_FAST_DEPLOYMENT)."
  type        = string
  default     = "gpt-4.1-mini"
}

variable "judge_escalation_deployment" {
  description = "Model deployment name for the escalation judge (JUDGE_ESCALATION_DEPLOYMENT)."
  type        = string
  default     = "gpt-5"
}

variable "guardian_deployment" {
  description = "Model deployment name for the Guardian / chat agent (GUARDIAN_DEPLOYMENT)."
  type        = string
  default     = "gpt-5"
}

variable "content_safety_enabled" {
  description = "Create an Azure AI Content Safety account (Prompt Shields)."
  type        = bool
  default     = true
}

variable "content_safety_sku" {
  description = "Content Safety SKU (F0 free tier allows one per subscription; S0 standard)."
  type        = string
  default     = "S0"
}

# ---------------------------------------------------------------------------------------------
# Entra ID
# ---------------------------------------------------------------------------------------------
variable "api_identifier_uri" {
  description = "Identifier URI of the API app. Empty = api://<prefix>-<env>-api. Some tenants' app-management policies only allow api://<appId> or verified domains."
  type        = string
  default     = ""
}

variable "spa_extra_redirect_uris" {
  description = "Additional SPA redirect URIs (custom domains)."
  type        = list(string)
  default     = []
}

variable "create_service_principals" {
  description = "Create enterprise apps (service principals) for the API and SPA registrations (required for app role assignments)."
  type        = bool
  default     = true
}

variable "app_role_principals" {
  description = "Entra object ids (users or groups) to assign to each API app role, e.g. { Viewer = [\"<group-oid>\"], Approver = [...], PolicyAdmin = [...] }."
  type        = map(list(string))
  default     = {}

  validation {
    condition     = alltrue([for k in keys(var.app_role_principals) : contains(["Viewer", "Approver", "PolicyAdmin", "Agent"], k)])
    error_message = "app_role_principals keys must be Viewer, Approver, PolicyAdmin or Agent."
  }
}

# ---------------------------------------------------------------------------------------------
# Alerts / integrations
# ---------------------------------------------------------------------------------------------
variable "teams_webhook_url" {
  description = "Teams incoming webhook / Workflows URL (TEAMS_WEBHOOK_URL). Stored in Key Vault. Empty = disabled."
  type        = string
  default     = ""
  sensitive   = true
}

variable "alert_webhook_urls" {
  description = "Comma-separated generic webhook URLs (ALERT_WEBHOOK_URLS). Stored in Key Vault (URLs can embed tokens). Empty = disabled."
  type        = string
  default     = ""
  sensitive   = true
}

variable "communication_enabled" {
  description = "Create Azure Communication Services + Email (Azure-managed domain) for email alerts."
  type        = bool
  default     = false
}

variable "communication_data_location" {
  description = "ACS data location (e.g. United States, Europe)."
  type        = string
  default     = "United States"
}

variable "alert_email_to" {
  description = "Recipients for email alerts (ALERT_EMAIL_TO)."
  type        = list(string)
  default     = []
}

variable "bot_enabled" {
  description = "Create an Azure Bot (Teams channel) for Action.Execute approval cards. Uses the control-plane managed identity."
  type        = bool
  default     = false
}

variable "bot_sku" {
  description = "Azure Bot SKU (F0 or S1)."
  type        = string
  default     = "F0"
}

variable "bot_messaging_path" {
  description = "Path on the control plane that receives Bot Framework activities."
  type        = string
  default     = "/api/teams/messages"
}
