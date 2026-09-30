variable "name" {
  description = "Globally unique Cosmos DB account name."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "database_name" {
  type    = string
  default = "agentgov"
}

variable "capacity_mode" {
  description = "serverless or autoscale."
  type        = string
  default     = "serverless"
}

variable "autoscale_max_throughput" {
  type    = number
  default = 1000
}

variable "zone_redundant" {
  type    = bool
  default = false
}

variable "public_network_access_enabled" {
  type    = bool
  default = true
}

variable "data_contributor_principal_ids" {
  description = "Map key => principal id granted 'Cosmos DB Built-in Data Contributor' (static keys)."
  type        = map(string)
  default     = {}
}

variable "log_analytics_workspace_id" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  serverless = var.capacity_mode == "serverless"

  # Container => partition key path (see plan: data model / Cosmos partition keys).
  # jev_shadow: non-authoritative TypeSafe Jev shadow comparisons (pk = sessionId or "tenant:<id>").
  containers = {
    lanes      = "/tenantId"
    agents     = "/tenantId"
    sessions   = "/sessionId"
    decisions  = "/sessionId"
    audit      = "/tenantId"
    approvals  = "/tenantId"
    incidents  = "/tenantId"
    outbox     = "/box"
    events     = "/sessionId"
    posture    = "/tenantId"
    jev_shadow = "/pk"
    fleet      = "/tenantId"
  }

  # TTL: -1 = enabled but items never expire unless they carry their own `ttl` (outbox, events, jev_shadow).
  ttl_enabled = toset(["outbox", "events", "jev_shadow"])

  # Built-in data-plane role: Cosmos DB Built-in Data Contributor.
  data_contributor_role_id = "00000000-0000-0000-0000-000000000002"
}

resource "azurerm_cosmosdb_account" "this" {
  #checkov:skip=CKV_AZURE_101:Public network access is a variable; private endpoints are optional and provisioned outside this config.
  #checkov:skip=CKV_AZURE_99:IP firewall not used — access is Entra RBAC only (local/key auth disabled).
  #checkov:skip=CKV_AZURE_100:Customer-managed keys are optional (Microsoft-managed encryption at rest by default).
  #checkov:skip=CKV2_AZURE_49:Serverless accounts are single-region.
  #checkov:skip=CKV_AZURE_140:False positive — checks the deprecated local_authentication_disabled; local_authentication_enabled = false is set below.
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  # Entra ID (managed identity) only — no primary keys / connection strings usable.
  local_authentication_enabled       = false
  access_key_metadata_writes_enabled = false
  public_network_access_enabled      = var.public_network_access_enabled
  minimal_tls_version                = "Tls12"
  automatic_failover_enabled         = false

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    location          = var.location
    failover_priority = 0
    zone_redundant    = var.zone_redundant
  }

  dynamic "capabilities" {
    for_each = local.serverless ? ["EnableServerless"] : []
    content {
      name = capabilities.value
    }
  }

  # Point-in-time restore (7 days, no extra cost) — the audit chain must be recoverable.
  backup {
    type = "Continuous"
    tier = "Continuous7Days"
  }

  tags = var.tags
}

resource "azurerm_cosmosdb_sql_database" "this" {
  name                = var.database_name
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name

  dynamic "autoscale_settings" {
    for_each = local.serverless ? [] : [var.autoscale_max_throughput]
    content {
      max_throughput = autoscale_settings.value
    }
  }
}

resource "azurerm_cosmosdb_sql_container" "this" {
  for_each = local.containers

  name                  = each.key
  resource_group_name   = var.resource_group_name
  account_name          = azurerm_cosmosdb_account.this.name
  database_name         = azurerm_cosmosdb_sql_database.this.name
  partition_key_paths   = [each.value]
  partition_key_kind    = "Hash"
  partition_key_version = 2
  default_ttl           = contains(local.ttl_enabled, each.key) ? -1 : null

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    # Large / untrusted blobs are never queried — keep them out of the index (RU + storage cost).
    excluded_path {
      path = "/args/*"
    }
    excluded_path {
      path = "/judge/*"
    }
    excluded_path {
      path = "/payload/*"
    }
    excluded_path {
      path = "/\"_etag\"/?"
    }

    # Tenant-scoped "latest first" listings (ORDER BY c.createdAt DESC WHERE c.tenantId = ...).
    composite_index {
      index {
        path  = "/tenantId"
        order = "ascending"
      }
      index {
        path  = "/createdAt"
        order = "descending"
      }
    }
  }
}

resource "azurerm_cosmosdb_sql_role_assignment" "data_contributor" {
  for_each = var.data_contributor_principal_ids

  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
  role_definition_id  = "${azurerm_cosmosdb_account.this.id}/sqlRoleDefinitions/${local.data_contributor_role_id}"
  principal_id        = each.value
  scope               = azurerm_cosmosdb_account.this.id
}

resource "azurerm_monitor_diagnostic_setting" "this" {
  name                           = "diag-to-log-analytics"
  target_resource_id             = azurerm_cosmosdb_account.this.id
  log_analytics_workspace_id     = var.log_analytics_workspace_id
  log_analytics_destination_type = "Dedicated"

  enabled_log {
    category = "DataPlaneRequests"
  }
  enabled_log {
    category = "ControlPlaneRequests"
  }

  enabled_metric {
    category = "Requests"
  }
}

output "id" {
  value = azurerm_cosmosdb_account.this.id
}

output "name" {
  value = azurerm_cosmosdb_account.this.name
}

output "endpoint" {
  value = azurerm_cosmosdb_account.this.endpoint
}

output "database_name" {
  value = azurerm_cosmosdb_sql_database.this.name
}

output "containers" {
  value = local.containers
}
