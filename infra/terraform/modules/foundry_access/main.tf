variable "account_id" {
  description = "Resource id of the EXISTING Foundry / AI Services / Azure OpenAI account."
  type        = string
}

variable "openai_endpoint_override" {
  type    = string
  default = ""
}

variable "project_name" {
  description = "Optional Foundry project name (builds FOUNDRY_PROJECT_ENDPOINT)."
  type        = string
  default     = ""
}

variable "openai_user_principal_ids" {
  description = "Map key => principal id granted 'Cognitive Services OpenAI User' (inference only, static keys)."
  type        = map(string)
  default     = {}
}

variable "ai_user_principal_ids" {
  description = "Map key => principal id granted 'Azure AI User' (Foundry Agent Service / project data actions). Only applied when project_name is set."
  type        = map(string)
  default     = {}
}

locals {
  # /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<name>
  id_parts            = split("/", var.account_id)
  resource_group_name = local.id_parts[4]
  account_name        = local.id_parts[8]
}

# NOTE: the data source reads in the provider's subscription. For a Foundry account in another
# subscription, set foundry_openai_endpoint explicitly (role assignments work cross-subscription).
data "azurerm_cognitive_account" "foundry" {
  name                = local.account_name
  resource_group_name = local.resource_group_name
}

locals {
  subdomain       = coalesce(data.azurerm_cognitive_account.foundry.custom_subdomain_name, local.account_name)
  openai_endpoint = var.openai_endpoint_override != "" ? var.openai_endpoint_override : "https://${local.subdomain}.openai.azure.com/"
  project_endpoint = (
    var.project_name == "" ? "" :
    "https://${local.subdomain}.services.ai.azure.com/api/projects/${var.project_name}"
  )
}

resource "azurerm_role_assignment" "openai_user" {
  for_each = var.openai_user_principal_ids

  scope                            = var.account_id
  role_definition_name             = "Cognitive Services OpenAI User"
  principal_id                     = each.value
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "ai_user" {
  for_each = var.project_name == "" ? {} : var.ai_user_principal_ids

  scope                            = var.account_id
  role_definition_name             = "Azure AI User"
  principal_id                     = each.value
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

output "openai_endpoint" {
  value = local.openai_endpoint
}

output "project_endpoint" {
  value = local.project_endpoint
}

output "account_name" {
  value = local.account_name
}
