variable "name" {
  description = "Base name (e.g. agentgov-dev). Apps are <name>-control-plane / -mcp-gateway / -intelligence."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "log_analytics_workspace_id" {
  type = string
}

variable "infrastructure_subnet_id" {
  type    = string
  default = null
}

variable "internal_load_balancer_enabled" {
  type    = bool
  default = false
}

variable "deploy_apps" {
  type    = bool
  default = true
}

variable "acr_login_server" {
  type = string
}

variable "image_tag" {
  description = "Initial image tag (git SHA). Ignored after creation; CD rolls images with az containerapp update."
  type        = string
}

variable "identities" {
  description = "Map control-plane|mcp-gateway|intelligence => { id, client_id }."
  type = map(object({
    id        = string
    client_id = string
  }))
}

variable "control_plane" {
  type = object({
    cpu                 = number
    memory              = string
    min_replicas        = number
    max_replicas        = number
    concurrent_requests = number
  })
}

variable "gateway" {
  type = object({
    enabled             = bool
    external_ingress    = bool
    cpu                 = number
    memory              = string
    min_replicas        = number
    max_replicas        = number
    concurrent_requests = number
  })
}

variable "intelligence" {
  type = object({
    enabled             = bool
    cpu                 = number
    memory              = string
    min_replicas        = number
    max_replicas        = number
    concurrent_requests = number
  })
}

variable "control_plane_env" {
  description = "Plain (non-secret) env vars for the control plane."
  type        = map(string)
  default     = {}
}

variable "gateway_env" {
  type    = map(string)
  default = {}
}

variable "intelligence_env" {
  type    = map(string)
  default = {}
}

variable "control_plane_secret_env" {
  description = "Env var name => Container App secret name (secretRef)."
  type        = map(string)
  default     = {}
}

variable "gateway_secret_env" {
  type    = map(string)
  default = {}
}

variable "intelligence_secret_env" {
  type    = map(string)
  default = {}
}

variable "control_plane_secrets" {
  description = "Container App secret name => versionless Key Vault secret id."
  type        = map(string)
  default     = {}
}

variable "gateway_secrets" {
  type    = map(string)
  default = {}
}

variable "gateway_config_secret_name" {
  description = "Secret (from gateway_secrets) mounted as a file at /app/config/<name> for AGENT_GATEWAY_CONFIG."
  type        = string
  default     = "gateway-config"
}

variable "intelligence_secrets" {
  type    = map(string)
  default = {}
}

variable "tags" {
  type    = map(string)
  default = {}
}

locals {
  apps = {
    control_plane = "${var.name}-control-plane"
    gateway       = "${var.name}-mcp-gateway"
    intelligence  = "${var.name}-intelligence"
  }
  ports = {
    control_plane = 4317
    gateway       = 8080
    intelligence  = 8000
  }

  domain = azurerm_container_app_environment.this.default_domain

  # Container Apps FQDNs are deterministic: <app>.<env-domain> (external) and
  # <app>.internal.<env-domain> (internal ingress). Computing them avoids self-references.
  control_plane_url = "https://${local.apps.control_plane}.${local.domain}"
  gateway_url = (
    var.gateway.external_ingress
    ? "https://${local.apps.gateway}.${local.domain}"
    : "https://${local.apps.gateway}.internal.${local.domain}"
  )
  intelligence_url = "https://${local.apps.intelligence}.internal.${local.domain}"

  images = {
    control_plane = "${var.acr_login_server}/agentgov/control-plane:${var.image_tag}"
    gateway       = "${var.acr_login_server}/agentgov/mcp-gateway:${var.image_tag}"
    intelligence  = "${var.acr_login_server}/agentgov/intelligence:${var.image_tag}"
  }

  control_plane_env = merge(var.control_plane_env, {
    AZURE_CLIENT_ID      = var.identities["control-plane"].client_id
    DASHBOARD_PUBLIC_URL = local.control_plane_url
    INTELLIGENCE_URL     = var.intelligence.enabled ? local.intelligence_url : ""
  })

  gateway_env = merge(var.gateway_env, {
    AZURE_CLIENT_ID       = var.identities["mcp-gateway"].client_id
    AGENT_GATEWAY_PDP_URL = local.control_plane_url
    AGENT_GATEWAY_CONFIG  = "/app/config/${var.gateway_config_secret_name}"
  })

  intelligence_env = merge(var.intelligence_env, {
    AZURE_CLIENT_ID = var.identities["intelligence"].client_id
    MONITOR_API_URL = local.control_plane_url
    MONITOR_MCP_URL = "${local.control_plane_url}/mcp"
  })
}

resource "azurerm_container_app_environment" "this" {
  name                           = "cae-${var.name}"
  location                       = var.location
  resource_group_name            = var.resource_group_name
  log_analytics_workspace_id     = var.log_analytics_workspace_id
  logs_destination               = "log-analytics"
  infrastructure_subnet_id       = var.infrastructure_subnet_id
  internal_load_balancer_enabled = var.infrastructure_subnet_id == null ? null : var.internal_load_balancer_enabled

  # Consumption workload profile (required for VNet-integrated, UDR-capable environments).
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }

  tags = var.tags

  lifecycle {
    # Azure fills this in when workload profiles are used.
    ignore_changes = [infrastructure_resource_group_name]
  }
}

# ---------------------------------------------------------------------------------------------
# Control plane (TypeScript): PDP /v1/decide, hooks, dashboard, /mcp, sync API.
# ---------------------------------------------------------------------------------------------
resource "azurerm_container_app" "control_plane" {
  count = var.deploy_apps ? 1 : 0

  name                         = local.apps.control_plane
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  max_inactive_revisions       = 10
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identities["control-plane"].id]
  }

  registry {
    server   = var.acr_login_server
    identity = var.identities["control-plane"].id
  }

  dynamic "secret" {
    for_each = var.control_plane_secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = var.identities["control-plane"].id
    }
  }

  ingress {
    external_enabled           = true
    target_port                = local.ports.control_plane
    transport                  = "auto"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.control_plane.min_replicas
    max_replicas = var.control_plane.max_replicas

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = tostring(var.control_plane.concurrent_requests)
    }

    container {
      name   = "control-plane"
      image  = local.images.control_plane
      cpu    = var.control_plane.cpu
      memory = var.control_plane.memory

      dynamic "env" {
        for_each = local.control_plane_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.control_plane_secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = local.ports.control_plane
        path                    = "/health"
        interval_seconds        = 5
        failure_count_threshold = 24
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = local.ports.control_plane
        path                    = "/health"
        interval_seconds        = 15
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = local.ports.control_plane
        path                    = "/health"
        interval_seconds        = 10
        failure_count_threshold = 3
      }
    }
  }

  tags = var.tags

  lifecycle {
    precondition {
      condition     = var.image_tag != ""
      error_message = "image_tag (git SHA) is required when deploy_apps = true. Bootstrap with deploy_apps = false first."
    }
    # CD owns image rollouts (az containerapp update --image ... --revision-suffix <sha>).
    ignore_changes = [
      template[0].container[0].image,
      template[0].revision_suffix,
    ]
  }
}

# ---------------------------------------------------------------------------------------------
# Governance MCP gateway (TypeScript): proxies MCP tools/call through the PDP.
# ---------------------------------------------------------------------------------------------
resource "azurerm_container_app" "gateway" {
  count = var.deploy_apps && var.gateway.enabled ? 1 : 0

  name                         = local.apps.gateway
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  max_inactive_revisions       = 10
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identities["mcp-gateway"].id]
  }

  registry {
    server   = var.acr_login_server
    identity = var.identities["mcp-gateway"].id
  }

  dynamic "secret" {
    for_each = var.gateway_secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = var.identities["mcp-gateway"].id
    }
  }

  ingress {
    external_enabled           = var.gateway.external_ingress
    target_port                = local.ports.gateway
    transport                  = "http"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.gateway.min_replicas
    max_replicas = var.gateway.max_replicas

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = tostring(var.gateway.concurrent_requests)
    }

    # Every app secret is projected as a file; AGENT_GATEWAY_CONFIG points at the config secret.
    volume {
      name         = "gateway-config"
      storage_type = "Secret"
    }

    container {
      name   = "mcp-gateway"
      image  = local.images.gateway
      cpu    = var.gateway.cpu
      memory = var.gateway.memory

      dynamic "env" {
        for_each = local.gateway_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.gateway_secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      volume_mounts {
        name = "gateway-config"
        path = "/app/config"
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = local.ports.gateway
        path                    = "/health"
        interval_seconds        = 15
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = local.ports.gateway
        path                    = "/health"
        interval_seconds        = 10
        failure_count_threshold = 3
      }
    }
  }

  tags = var.tags

  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
      template[0].revision_suffix,
    ]
  }
}

# ---------------------------------------------------------------------------------------------
# Intelligence service (Python / FastAPI / Agent Framework): Guardian, lane drafter, chat.
# Internal ingress only — reached by the control plane inside the environment.
# ---------------------------------------------------------------------------------------------
resource "azurerm_container_app" "intelligence" {
  count = var.deploy_apps && var.intelligence.enabled ? 1 : 0

  name                         = local.apps.intelligence
  container_app_environment_id = azurerm_container_app_environment.this.id
  resource_group_name          = var.resource_group_name
  revision_mode                = "Single"
  max_inactive_revisions       = 10
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [var.identities["intelligence"].id]
  }

  registry {
    server   = var.acr_login_server
    identity = var.identities["intelligence"].id
  }

  dynamic "secret" {
    for_each = var.intelligence_secrets
    content {
      name                = secret.key
      key_vault_secret_id = secret.value
      identity            = var.identities["intelligence"].id
    }
  }

  ingress {
    external_enabled           = false
    target_port                = local.ports.intelligence
    transport                  = "http"
    allow_insecure_connections = false

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.intelligence.min_replicas
    max_replicas = var.intelligence.max_replicas

    http_scale_rule {
      name                = "http-concurrency"
      concurrent_requests = tostring(var.intelligence.concurrent_requests)
    }

    container {
      name   = "intelligence"
      image  = local.images.intelligence
      cpu    = var.intelligence.cpu
      memory = var.intelligence.memory

      dynamic "env" {
        for_each = local.intelligence_env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.intelligence_secret_env
        content {
          name        = env.key
          secret_name = env.value
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = local.ports.intelligence
        path                    = "/health"
        interval_seconds        = 5
        failure_count_threshold = 24
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = local.ports.intelligence
        path                    = "/health"
        interval_seconds        = 15
        failure_count_threshold = 3
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = local.ports.intelligence
        path                    = "/health"
        interval_seconds        = 10
        failure_count_threshold = 3
      }
    }
  }

  tags = var.tags

  lifecycle {
    ignore_changes = [
      template[0].container[0].image,
      template[0].revision_suffix,
    ]
  }
}

output "environment_id" {
  value = azurerm_container_app_environment.this.id
}

output "environment_name" {
  value = azurerm_container_app_environment.this.name
}

output "default_domain" {
  value = azurerm_container_app_environment.this.default_domain
}

output "app_names" {
  value = local.apps
}

output "control_plane_url" {
  value = local.control_plane_url
}

output "control_plane_fqdn" {
  value = "${local.apps.control_plane}.${local.domain}"
}

output "gateway_url" {
  value = var.gateway.enabled ? local.gateway_url : ""
}

output "intelligence_url" {
  value = var.intelligence.enabled ? local.intelligence_url : ""
}
