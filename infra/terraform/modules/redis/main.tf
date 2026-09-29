variable "name" {
  description = "Azure Managed Redis name."
  type        = string
}

variable "location" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "sku_name" {
  type    = string
  default = "Balanced_B0"
}

variable "high_availability_enabled" {
  type    = bool
  default = true
}

variable "public_network_access_enabled" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}

# Azure Managed Redis (Redis Enterprise stack). Azure Cache for Redis Basic/Standard/Premium is
# retiring (30 Sep 2028) and new-tenant creation is being blocked, so AMR is the recommended target.
#  - TLS only (Encrypted client protocol, port 10000), TLS 1.2+.
#  - EnterpriseCluster policy exposes a single endpoint, so ioredis runs in standalone mode.
resource "azurerm_managed_redis" "this" {
  name                      = var.name
  location                  = var.location
  resource_group_name       = var.resource_group_name
  sku_name                  = var.sku_name
  high_availability_enabled = var.high_availability_enabled
  public_network_access     = var.public_network_access_enabled ? "Enabled" : "Disabled"

  default_database {
    client_protocol   = "Encrypted"
    clustering_policy = "EnterpriseCluster"
    eviction_policy   = "VolatileLRU"
    # ioredis authenticates with the access key from REDIS_URL (Key Vault secretRef).
    # Entra token auth (and disabling keys) is a follow-up once the app supports credential refresh.
    access_keys_authentication_enabled = true
  }

  tags = var.tags
}

locals {
  port = coalesce(azurerm_managed_redis.this.default_database[0].port, 10000)
}

output "id" {
  value = azurerm_managed_redis.this.id
}

output "hostname" {
  value = azurerm_managed_redis.this.hostname
}

output "port" {
  value = local.port
}

output "connection_url" {
  description = "REDIS_URL for ioredis (rediss:// = TLS). Written to Key Vault by the root module; never set as a plain env var."
  # Keys are base64 so they must be URL-encoded inside the userinfo part.
  value     = "rediss://:${urlencode(azurerm_managed_redis.this.default_database[0].primary_access_key)}@${azurerm_managed_redis.this.hostname}:${local.port}"
  sensitive = true
}
