# Offline plan tests — no Azure credentials needed (all providers are mocked).
# Run: terraform -chdir=infra/terraform init -backend=false && terraform -chdir=infra/terraform test

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "00000000-0000-0000-0000-000000000001"
      object_id       = "00000000-0000-0000-0000-000000000002"
      subscription_id = "00000000-0000-0000-0000-000000000003"
    }
  }
  mock_data "azurerm_cognitive_account" {
    defaults = {
      custom_subdomain_name = "my-foundry"
    }
  }
}

mock_provider "azuread" {
  mock_data "azuread_client_config" {
    defaults = {
      tenant_id = "00000000-0000-0000-0000-000000000001"
      object_id = "00000000-0000-0000-0000-000000000002"
    }
  }
}

mock_provider "random" {}
mock_provider "time" {}

variables {
  environment = "dev"
  image_tag   = "0123456789abcdef0123456789abcdef01234567"
}

run "bootstrap_without_apps" {
  command = plan

  variables {
    deploy_apps = false
    image_tag   = ""
  }

  assert {
    condition     = length(module.container_apps.app_names) == 3
    error_message = "App names should still be computed during bootstrap."
  }
}

run "full_dev_plan" {
  command = plan

  variables {
    foundry_account_id    = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-foundry/providers/Microsoft.CognitiveServices/accounts/my-foundry"
    foundry_project_name  = "agent-governance"
    communication_enabled = true
    bot_enabled           = true
    teams_webhook_url     = "https://example.invalid/webhook"
    app_role_principals = {
      Approver = ["00000000-0000-0000-0000-00000000000a"]
    }
  }

  assert {
    condition     = output.foundry_openai_endpoint == "https://my-foundry.openai.azure.com/"
    error_message = "Foundry OpenAI endpoint should derive from the account's custom subdomain."
  }

  assert {
    condition     = length(module.keyvault.secret_ids) == 6
    error_message = "Expected 6 Key Vault secrets (incl. teams-webhook-url)."
  }
}

run "rejects_latest_tag" {
  command = plan

  variables {
    image_tag = "latest"
  }

  expect_failures = [var.image_tag]
}

run "fleet_disabled_by_default" {
  command = plan

  assert {
    condition     = length(module.fleet) == 0
    error_message = "enable_fleet defaults to false: no fleet module instance expected."
  }

  assert {
    condition     = !contains(keys(module.identity.identities), "fleet")
    error_message = "No fleet managed identity should be created when enable_fleet = false."
  }

  assert {
    condition     = length(output.fleet_app_names) == 0 && output.fleet_hooks_url == "" && output.fleet_identity_client_id == ""
    error_message = "Fleet outputs should be empty when enable_fleet = false."
  }

  assert {
    condition     = length([for k in keys(module.keyvault.secret_ids) : k if startswith(k, "fleet-")]) == 0
    error_message = "No fleet Key Vault secrets should be created when enable_fleet = false."
  }
}

run "fleet_enabled" {
  command = plan

  variables {
    enable_fleet                         = true
    fleet_image_tag                      = "0123456789abcdef0123456789abcdef01234567"
    foundry_account_id                   = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-foundry/providers/Microsoft.CognitiveServices/accounts/my-foundry"
    foundry_project_name                 = "agent-governance"
    fleet_scope_subscriptions            = ["00000000-0000-0000-0000-000000000003", "00000000-0000-0000-0000-000000000004"]
    fleet_diagnostics_storage_account_id = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-diag/providers/Microsoft.Storage/storageAccounts/stdiag"
    fleet_alerts_dcr_resource_id         = "/subscriptions/00000000-0000-0000-0000-000000000003/resourceGroups/rg-mon/providers/Microsoft.Insights/dataCollectionRules/dcr-fleet-alerts"
    fleet_alerts_dcr_immutable_id        = "dcr-00000000000000000000000000000000"
    fleet_alerts_dce                     = "https://dce-fleet.eastus2-1.ingest.monitor.azure.com"
    fleet_hooks_audience                 = ["api://agentmon-fleet-hooks"]
    fleet_hooks_allowed_app_ids          = ["00000000-0000-0000-0000-00000000000b"]
    fleet_monitor_token                  = "not-a-real-token"
  }

  assert {
    condition     = length(module.fleet) == 1
    error_message = "enable_fleet = true should instantiate the fleet module."
  }

  assert {
    condition     = contains(keys(module.identity.identities), "fleet")
    error_message = "The fleet should get its own user-assigned managed identity."
  }

  assert {
    condition     = output.fleet_app_names["worker"] == "agentgov-dev-fleet" && output.fleet_app_names["hooks"] == "agentgov-dev-fleet-hooks"
    error_message = "Expected worker and hooks Container Apps."
  }

  assert {
    condition = alltrue([for k in [
      "law-log-analytics-reader",
      "sub-monitoring-reader-00000000-0000-0000-0000-000000000003",
      "sub-security-reader-00000000-0000-0000-0000-000000000004",
      "foundry-ai-user-/subscriptions/00000000-0000-0000-0000-000000000003/resourcegroups/rg-foundry/providers/microsoft.cognitiveservices/accounts/my-foundry",
      "diag-storage-blob-reader",
      "alerts-dcr-metrics-publisher",
    ] : contains(keys(module.fleet[0].role_assignments), k)])
    error_message = "Fleet least-privilege role assignments are missing."
  }

  assert {
    condition     = length(module.fleet[0].role_assignments) == 8
    error_message = "Expected exactly 8 fleet role assignments (LAW, 2x2 subscription, Foundry, storage, DCR)."
  }

  assert {
    condition     = alltrue([for r in values(module.fleet[0].role_assignments) : !contains(["Owner", "Contributor"], r.role)])
    error_message = "The fleet must never get Owner/Contributor."
  }

  assert {
    condition     = contains(keys(module.keyvault.secret_ids), "fleet-monitor-token") && !contains(keys(module.keyvault.secret_ids), "fleet-foundry-api-key")
    error_message = "Only supplied fleet secrets should be stored in Key Vault."
  }
}

run "fleet_rejects_latest_tag" {
  command = plan

  variables {
    enable_fleet         = true
    fleet_image_tag      = "latest"
    fleet_hooks_audience = ["api://agentmon-fleet-hooks"]
  }

  expect_failures = [var.fleet_image_tag]
}

run "fleet_flags_missing_hooks_audience" {
  command = plan

  variables {
    enable_fleet    = true
    fleet_image_tag = "0123456789abcdef0123456789abcdef01234567"
  }

  expect_failures = [output.fleet_hooks_url]
}