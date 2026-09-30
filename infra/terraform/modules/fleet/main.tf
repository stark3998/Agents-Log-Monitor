# Monitoring fleet (fleet/): worker loop + real-time hooks API on the shared Container Apps environment.
# Instantiated from the root module only when var.enable_fleet = true.
#
# State: the fleet keeps SQLite (WAL mode) at FLEET_STATE_DB. SQLite WAL needs shared-memory locking,
# which Azure Files (SMB) does not provide reliably, and ACA Azure Files mounts need a storage account
# key. Each app therefore gets an EmptyDir volume at /data: state survives container restarts within a
# replica but not revision changes / replica moves. On a fresh replica the worker re-reads the last
# FLEET_LOOKBACK_MINUTES of logs, so dedup is best-effort across restarts (see infra/README.md).

variable "name" {
  description = "Base name (e.g. agentgov-dev). Apps are <name>-fleet and <name>-fleet-hooks."
  type        = string
}

variable "resource_group_name" {
  type = string
}

variable "container_app_environment_id" {
  type = string
}

variable "acr_login_server" {
  type = string
}

variable "image_tag" {
  description = "Initial fleet image tag (git SHA). Ignored after creation; CD rolls images with az containerapp update."
  type        = string
}

variable "deploy_apps" {
  description = "Create the Container Apps (false during the bootstrap run, before any image exists)."
  type        = bool
  default     = true
}

variable "identity" {
  description = "Fleet user-assigned managed identity."
  type = object({
    id           = string
    client_id    = string
    principal_id = string
  })
}

variable "env" {
  description = "Plain (non-secret) env vars shared by the worker and hooks apps."
  type        = map(string)
  default     = {}
}

variable "hooks_env" {
  description = "Extra plain env vars for the hooks app only."
  type        = map(string)
  default     = {}
}

variable "secret_env" {
  description = "Env var name => Container App secret name (secretRef)."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Container App secret name => versionless Key Vault secret id."
  type        = map(string)
  default     = {}
}

variable "worker_args" {
  description = "Arguments to the agentmon-fleet entrypoint for the worker."
  type        = list(string)
  default     = ["run"]
}

variable "sizing" {
  type = object({
    cpu                    = number
    memory                 = string
    hooks_enabled          = bool
    hooks_external_ingress = bool
    hooks_cpu              = number
    hooks_memory           = string
    hooks_min_replicas     = number
    hooks_max_replicas     = number
    hooks_concurrent       = number
  })
}

variable "role_assignments" {
  description = "Static key => { scope, role }. Least-privilege reads for the fleet identity."
  type = map(object({
    scope = string
    role  = string
  }))
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  apps = {
    worker = "${var.name}-fleet"
    hooks  = "${var.name}-fleet-hooks"
  }
  hooks_port = 8787
  image      = "${var.acr_login_server}/agentgov/fleet:${var.image_tag}"

  base_env = merge(var.env, {
    AZURE_CLIENT_ID                  = var.identity.client_id
    FLEET_MANAGED_IDENTITY_CLIENT_ID = var.identity.client_id
    FLEET_STATE_DB                   = "/data/fleet-state.db"
    FLEET_ALERTS_JSONL               = "/data/fleet-alerts.jsonl"
    FLEET_JEV_SHADOW_JSONL           = "/data/fleet-jev-shadow.jsonl"
  })
  hooks_env = merge(local.base_env, var.hooks_env)

  blocked_roles = ["Owner", "Contributor", "User Access Administrator", "Role Based Access Control Administrator"]
}

# ---------------------------------------------------------------------------------------------
# RBAC — read-only data access + DCR ingestion. Never Owner/Contributor.
# ---------------------------------------------------------------------------------------------
resource "azurerm_role_assignment" "fleet" {
  for_each = var.role_assignments

  scope                            = each.value.scope
  role_definition_name             = each.value.role
  principal_id                     = var.identity.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true

  lifecycle {
    precondition {
      condition     = !contains(local.blocked_roles, each.value.role)
      error_message = "The fleet identity must not receive broad write/IAM roles."
    }
  }
}

# ---------------------------------------------------------------------------------------------
# Worker: `agentmon-fleet run` — single replica (SQLite state, cursor ownership), no ingress.
# ---------------------------------------------------------------------------------------------
resource "azurerm_container_app" "worker" {
  count = var.deploy_apps ? 1 : 0

  name                         = local.apps.worker
  container_app_environment_id = var.container_app_environment_id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  max_inactive_revisions       = 10
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity.id]
  }

  registry {
    server   = var.acr_login_server
    identity = var.identity.id
  }

  dynamic "secret" {
    for_each = var.secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = var.identity.id
    }
  }

  template {
    # Exactly one replica: two workers would double-poll sources and race on alert dedup.
    min_replicas = 1
    max_replicas = 1

    volume {
      name         = "state"
      storage_type = "EmptyDir"
    }

    container {
      name   = "fleet"
      image  = local.image
      args   = var.worker_args
      cpu    = var.sizing.cpu
      memory = var.sizing.memory

      dynamic "env" {
        for_each = local.base_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      volume_mounts {
        name = "state"
        path = "/data"
      }
    }
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition     = var.image_tag != "" && var.image_tag != "latest"
      error_message = "fleet_image_tag (git SHA) is required when enable_fleet = true and deploy_apps = true (never :latest)."
    }
    # CD owns image rollouts (az containerapp update --image ... --revision-suffix <sha>).
    ignore_changes = [
      template[0].container[0].image,
      template[0].revision_suffix,
    ]
  }

  depends_on = [azurerm_role_assignment.fleet]
}

# ---------------------------------------------------------------------------------------------
# Hooks: Copilot Studio webhook (/copilot-studio/*), /evaluate, /events. Entra-token authenticated
# (FLEET_HOOKS_AUDIENCE / FLEET_HOOKS_ALLOWED_APP_IDS); anonymous access is never enabled here.
# ---------------------------------------------------------------------------------------------
resource "azurerm_container_app" "hooks" {
  count = var.deploy_apps && var.sizing.hooks_enabled ? 1 : 0

  name                         = local.apps.hooks
  container_app_environment_id = var.container_app_environment_id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  max_inactive_revisions       = 10
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identity.id]
  }

  registry {
    server   = var.acr_login_server
    identity = var.identity.id
  }

  dynamic "secret" {
    for_each = var.secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = var.identity.id
    }
  }

  ingress {
    external_enabled           = var.sizing.hooks_external_ingress
    target_port                = local.hooks_port
    transport                  = "http"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.sizing.hooks_min_replicas
    max_replicas = var.sizing.hooks_max_replicas

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = tostring(var.sizing.hooks_concurrent)
    }

    volume {
      name         = "state"
      storage_type = "EmptyDir"
    }

    container {
      name   = "fleet-hooks"
      image  = local.image
      args   = ["hooks", "--host", "0.0.0.0", "--port", tostring(local.hooks_port)]
      cpu    = var.sizing.hooks_cpu
      memory = var.sizing.hooks_memory

      dynamic "env" {
        for_each = local.hooks_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      volume_mounts {
        name = "state"
        path = "/data"
      }

      startup_probe {
        transport               = "HTTP"
        port                    = local.hooks_port
        path                    = "/health"
        interval_seconds        = 5
        failure_count_threshold = 24
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = local.hooks_port
        path                    = "/health"
        interval_seconds        = 15
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = local.hooks_port
        path                    = "/health"
        interval_seconds        = 10
        failure_count_threshold = 3
      }
    }
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition     = var.image_tag != "" && var.image_tag != "latest"
      error_message = "fleet_image_tag (git SHA) is required when enable_fleet = true and deploy_apps = true (never :latest)."
    }
    ignore_changes = [
      template[0].container[0].image,
      template[0].revision_suffix,
    ]
  }

  depends_on = [azurerm_role_assignment.fleet]
}

output "app_names" {
  description = "Container App names: worker, and hooks when enabled."
  value = merge(
    { worker = local.apps.worker },
    var.sizing.hooks_enabled ? { hooks = local.apps.hooks } : {},
  )
}

output "hooks_url" {
  description = "Hooks base URL (Copilot Studio webhook: <url>/copilot-studio/analyze-tool-execution)."
  value       = var.deploy_apps && var.sizing.hooks_enabled ? "https://${azurerm_container_app.hooks[0].ingress[0].fqdn}" : ""
}

output "role_assignments" {
  description = "Role assignment key => { scope, role }."
  value       = var.role_assignments
}
