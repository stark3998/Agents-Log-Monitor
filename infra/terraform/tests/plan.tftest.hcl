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
