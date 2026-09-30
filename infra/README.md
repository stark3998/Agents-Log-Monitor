# Agent Governance — Azure control plane (Terraform + GitHub Actions)

This folder deploys the **central control plane** of the agent-governance platform to Azure. Local
enforcers (the same TypeScript codebase in `local` mode) sync lanes down and events/decisions up to it.

## Architecture

```
                         GitHub Actions (OIDC -> Entra ID, no secrets)
                         ci.yml: build/test/scan  ·  deploy.yml: images -> plan -> [approval] -> apply -> roll
                                           │ push :<git-sha>                     │ terraform (azurerm backend)
                                           ▼                                     ▼
 Local enforcers ──┐        ┌──────────────── Container Apps environment (Log Analytics) ────────────────┐
 (device token)    │ HTTPS  │                                                                             │
 Copilot cloud ────┼───────►│  control-plane  :4317  external   PDP /v1/decide · hooks · dashboard · /mcp │
 agent / SDKs      │        │     │  ▲                          KEDA http scaling, min 1 replica          │
                   │        │     │  └──── https://<cp>/mcp ─────────────┐                                │
 Foundry agents ───┼───────►│  mcp-gateway    :8080  external*  tools/call -> PDP -> upstream MCP         │
 Copilot Studio    │        │     │                                      │                                │
                   │        │     ▼ internal                             │                                │
 Browser (MSAL) ───┘        │  intelligence   :8000  internal   Guardian · lane drafter · chat (MAF)      │
                            └─────┬──────────────┬──────────────┬───────────┬─────────────┬──────────────┘
                                  │ user-assigned managed identity per app (no keys, no connection strings)
                                  ▼              ▼              ▼           ▼             ▼
                   Cosmos DB (NoSQL, Entra-only)  Azure Managed Redis  Key Vault (RBAC)  ACR (AcrPull)
                   db agentgov: lanes, agents,    (TLS :10000,         secretRefs for    admin disabled
                   sessions, decisions, audit,     REDIS_URL in KV)    Redis/HMAC/device
                   approvals, incidents, outbox,                       key/webhooks
                   events
                   AI Content Safety (Prompt Shields, Entra-only)   EXISTING Foundry account (OpenAI User role)
                   App Insights (workspace-based)   Entra ID: API app (roles + access_as_user) + SPA app
                   optional: ACS Email · Azure Bot (Teams)
```
`*` gateway ingress is internal by default (`gateway.external_ingress = false`). Expose it only through a private network or authenticated ingress, and keep `AGENT_GATEWAY_AUDIENCE` configured for caller Entra tokens.

### Modules (`infra/terraform/modules/`)

| Module | Creates |
|---|---|
| `observability` | Log Analytics workspace + workspace-based Application Insights |
| `identity` | One user-assigned managed identity per app (`control-plane`, `mcp-gateway`, `intelligence`) |
| `acr` | Container Registry (admin disabled), AcrPull for each identity, AcrPush for the deployer |
| `keyvault` | Key Vault (RBAC, purge protection, 90-day soft delete), secrets, **per-secret** `Key Vault Secrets User` assignments |
| `cosmos` | Cosmos DB NoSQL account (serverless or autoscale, local auth disabled, continuous backup), database `agentgov`, 12 containers, `Cosmos DB Built-in Data Contributor` |
| `redis` | Azure Managed Redis (TLS only), connection URL written to Key Vault |
| `content_safety` | Content Safety account (local auth disabled), `Cognitive Services User` |
| `foundry_access` | Reads the **existing** Foundry account; `Cognitive Services OpenAI User` (+ `Azure AI User` for intelligence when a project is set) |
| `container_apps` | Environment wired to Log Analytics (optional VNet) + the three apps with probes, KEDA http scaling, Key Vault secretRefs |
| `entra` | API app registration (roles `Viewer`/`Approver`/`PolicyAdmin`/`Agent`, scope `access_as_user`, `api://<name>-api`), SPA app, service principals, Agent-role assignments for the workload identities |
| `communication` | *(optional)* ACS + Email service with an Azure-managed domain |
| `bot` | *(optional)* Azure Bot (managed-identity auth) + Teams channel for `Action.Execute` approvals |

### Cosmos containers

| Container | Partition key | Notes |
|---|---|---|
| lanes, agents, audit, approvals, incidents | `/tenantId` | `lanes` also holds policies (`kind: policy`) and settings documents (`kind: setting`) |
| posture | `/tenantId` | Endpoint posture: endpoints + inventories (`kind: endpoint`) and findings (`kind: finding`) |
| sessions, decisions, events | `/sessionId` | `events` has TTL enabled (per-item `ttl`) |
| outbox | `/box` | TTL enabled |
| jev_shadow | `/pk` | TypeSafe Jev shadow comparisons (non-authoritative, not in the audit chain). `pk` = sessionId or `tenant:<id>`; per-item `ttl` = `JEV_SHADOW_RETENTION_DAYS` |
| fleet | `/tenantId` | Monitoring-fleet alerts (`kind: fleet_alert`) posted to `/api/gov/fleet/alerts`; evidence is stored but not indexed |

Indexing: everything except `/args/*`, `/judge/*`, `/payload/*`; composite index `(tenantId ASC, createdAt DESC)`.

### Why Azure Managed Redis (not Azure Cache for Redis)

Azure Cache for Redis Basic/Standard/Premium retires on **30 Sep 2028** (Enterprise tiers 31 Mar 2027) and
new-tenant creation of those tiers is being blocked; Microsoft's recommended target is **Azure Managed Redis**
(<https://learn.microsoft.com/azure/azure-cache-for-redis/retirement-faq>). AMR also gives zone redundancy by
default, Entra auth and better price/performance. The cache is created with the `EnterpriseCluster` policy
(a single endpoint, so `ioredis` runs unchanged in standalone mode), the `Encrypted` (TLS) protocol on port
10000, and `VolatileLRU` eviction. `Balanced_B0` (HA off in dev) is the smallest SKU; check the pricing
calculator for your region before choosing prod sizing.

### Container App configuration

| App | Plain env vars | Key Vault secretRefs |
|---|---|---|
| control-plane | `AGENT_MONITOR_MODE=cloud`, `HOST`, `PORT=4317`, `COSMOS_ENDPOINT`, `COSMOS_DATABASE`, `FOUNDRY_OPENAI_ENDPOINT`, `JUDGE_FAST_DEPLOYMENT`, `JUDGE_ESCALATION_DEPLOYMENT`, `CONTENT_SAFETY_ENDPOINT`, `ENTRA_API_AUDIENCE`, `ENTRA_TENANT_ID`, `ACS_ENDPOINT`, `ALERT_EMAIL_FROM/TO`, `DASHBOARD_PUBLIC_URL`, `INTELLIGENCE_URL`, `GOVERNANCE_*`, `AGENT_MONITOR_DB`, `AZURE_CLIENT_ID` | `REDIS_URL`, `ALERT_WEBHOOK_SECRET`, `GOVERNANCE_DEVICE_SIGNING_KEY`, `APPLICATIONINSIGHTS_CONNECTION_STRING`, `TEAMS_WEBHOOK_URL`*, `ALERT_WEBHOOK_URLS`* |
| mcp-gateway | `GATEWAY_HOST`, `AGENT_GATEWAY_PORT=8080`, `AGENT_GATEWAY_PDP_URL`, `AGENT_GATEWAY_CONFIG`, `AGENT_GATEWAY_AUDIENCE`, `AGENT_GATEWAY_PDP_AUDIENCE`, `ENTRA_*`, `AZURE_CLIENT_ID` | `APPLICATIONINSIGHTS_CONNECTION_STRING`; `gateway-config` mounted as a file |
| intelligence | `AZURE_OPENAI_ENDPOINT`, `FOUNDRY_PROJECT_ENDPOINT`, `GUARDIAN_DEPLOYMENT`, `MONITOR_API_URL`, `MONITOR_MCP_URL`, `ENTRA_API_AUDIENCE`, `AZURE_CLIENT_ID` | `APPLICATIONINSIGHTS_CONNECTION_STRING` |

`*` only when the corresponding variable is set. Foundry and Content Safety use **managed identity**, so there
is no Foundry key anywhere (`FOUNDRY_OPENAI_API_KEY` stays unset). Secrets are versionless references, so
rotating a Key Vault secret is picked up on the next revision/restart.

## Prerequisites

- Azure subscription + permission to create role assignments (Owner, or Contributor + *Role Based Access
  Control Administrator*) for the bootstrap below.
- Entra ID permission to create app registrations.
- An existing Microsoft Foundry (AI Services) account with the model deployments named in `*.tfvars`
  (`gpt-4.1-mini`, `gpt-5` by default).
- Terraform ≥ 1.9 (CI uses 1.16.2), Azure CLI ≥ 2.60, `gh` CLI, Docker (for local image builds).
- Resource providers registered: `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.DocumentDB`,
  `Microsoft.Cache`, `Microsoft.KeyVault`, `Microsoft.CognitiveServices`, `Microsoft.OperationalInsights`,
  `Microsoft.Insights`, `Microsoft.Communication` (optional), `Microsoft.BotService` (optional).

## Bootstrap (once per subscription / environment)

PowerShell, run by an administrator:

```powershell
$env:SUB   = '<subscription-id>'
$env:LOC   = 'eastus2'
$env:REPO  = 'stark3998/Agents-Log-Monitor'
$env:ENV   = 'dev'
az account set --subscription $env:SUB

# 1) Terraform state: storage account with Entra-only access, versioning + soft delete.
az group create -n rg-agentgov-tfstate -l $env:LOC
az storage account create -n stagentgovtfstate001 -g rg-agentgov-tfstate -l $env:LOC `
  --sku Standard_ZRS --kind StorageV2 --min-tls-version TLS1_2 `
  --allow-blob-public-access false --allow-shared-key-access false
az storage account blob-service-properties update -n stagentgovtfstate001 -g rg-agentgov-tfstate `
  --enable-versioning true --enable-delete-retention true --delete-retention-days 30
az storage container create -n tfstate --account-name stagentgovtfstate001 --auth-mode login

# 2) Deployer identity for GitHub Actions (app registration + federated credentials, NO secret).
$app = az ad app create --display-name "github-agentgov-deployer" | ConvertFrom-Json
az ad sp create --id $app.appId | Out-Null
foreach ($subject in @("environment:$($env:ENV)", "environment:$($env:ENV)-plan")) {
  $fc = @{ name = ($subject -replace '[:]','-'); issuer = 'https://token.actions.githubusercontent.com';
           subject = "repo:$($env:REPO):$subject"; audiences = @('api://AzureADTokenExchange') } | ConvertTo-Json
  [IO.File]::WriteAllText("$PWD\fc.json", $fc)   # UTF-8 without BOM
  az ad app federated-credential create --id $app.appId --parameters fc.json
}
Remove-Item fc.json

# 3) Azure RBAC for the deployer (scope to the subscription only because Terraform creates the RG;
#    pre-create rg-agentgov-<env> and scope to it for least privilege).
$sp = az ad sp show --id $app.appId --query id -o tsv
az role assignment create --assignee-object-id $sp --assignee-principal-type ServicePrincipal `
  --role Contributor --scope "/subscriptions/$($env:SUB)"
# Needed because Terraform creates role assignments (AcrPull, KV Secrets User, Cognitive Services ...).
# Constrain it with an ABAC condition in the portal to the roles listed in this README.
az role assignment create --assignee-object-id $sp --assignee-principal-type ServicePrincipal `
  --role "Role Based Access Control Administrator" --scope "/subscriptions/$($env:SUB)"
# Role assignments on the EXISTING Foundry account (may live in another RG/subscription).
az role assignment create --assignee-object-id $sp --assignee-principal-type ServicePrincipal `
  --role "Role Based Access Control Administrator" --scope '<foundry-account-resource-id>'
# Terraform state data access.
az role assignment create --assignee-object-id $sp --assignee-principal-type ServicePrincipal `
  --role "Storage Blob Data Contributor" `
  --scope "$(az storage account show -n stagentgovtfstate001 -g rg-agentgov-tfstate --query id -o tsv)/blobServices/default/containers/tfstate"
```

4) **Microsoft Graph application permissions** for the deployer (admin consent required):
   `Application.ReadWrite.OwnedBy` (create/own the API + SPA registrations) and
   `AppRoleAssignment.ReadWrite.All` (assign the `Agent` role to the workload identities and the roles in
   `app_role_principals`). If `AppRoleAssignment.ReadWrite.All` is not acceptable, set
   `create_service_principals = false`, and create the enterprise apps and role assignments manually.

5) **GitHub configuration** (`Settings → Environments`): create `dev-plan` (no reviewers) and `dev`
   (required reviewers; add `staging`/`prod` pairs the same way, prod with ≥ 2 reviewers and a branch
   policy of `main` only).

   | Kind | Name | Value |
   |---|---|---|
   | secret (repo or env) | `AZURE_CLIENT_ID` | deployer app `appId` |
   | secret | `AZURE_TENANT_ID` | tenant id |
   | secret | `AZURE_SUBSCRIPTION_ID` | subscription id |
   | variable | `TFSTATE_RESOURCE_GROUP` | `rg-agentgov-tfstate` |
   | variable | `TFSTATE_STORAGE_ACCOUNT` | `stagentgovtfstate001` |
   | variable | `TFSTATE_CONTAINER` | `tfstate` |
   | secret (optional, on `<env>-plan`) | `TEAMS_WEBHOOK_URL`, `ALERT_WEBHOOK_URLS`, `GATEWAY_CONFIG_JSON` | written to Key Vault by Terraform |

   The three `AZURE_*` values are identifiers, not credentials — there is **no** `AZURE_CLIENT_SECRET`.

6) Copy `environments/dev.tfvars.example` → `environments/dev.tfvars`, fill in `foundry_account_id` etc.,
   and commit it (it must contain no secrets). State keys are `agentgov-<env>.tfstate`.

## Variables (most used)

| Variable | Default | Purpose |
|---|---|---|
| `environment` | — | `dev` / `staging` / `prod` |
| `location`, `name_prefix` | `eastus2`, `agentgov` | naming: `<type>-<prefix>-<env>-<suffix>` |
| `deploy_apps`, `image_tag` | `true`, `""` | bootstrap switch / initial image (git SHA; `latest` is rejected) |
| `foundry_account_id`, `foundry_project_name` | `""` | existing Foundry account (empty = deterministic lanes only) |
| `judge_fast_deployment`, `judge_escalation_deployment`, `guardian_deployment` | `gpt-4.1-mini`, `gpt-5`, `gpt-5` | model deployment names |
| `cosmos_capacity_mode`, `cosmos_autoscale_max_throughput` | `serverless`, `1000` | Cosmos capacity |
| `redis_sku_name`, `redis_high_availability_enabled` | `Balanced_B0`, `true` | Azure Managed Redis |
| `acr_sku` | `Standard` | `Premium` for private endpoints / retention |
| `control_plane`, `gateway`, `intelligence` | see `variables.tf` | cpu/memory/replicas/concurrency, gateway ingress |
| `infrastructure_subnet_id`, `internal_load_balancer_enabled` | `null`, `false` | VNet integration |
| `app_role_principals` | `{}` | `{ Viewer = [oid], Approver = [...], PolicyAdmin = [...] }` |
| `communication_enabled`, `alert_email_to` | `false`, `[]` | ACS email alerts |
| `bot_enabled` | `false` | Azure Bot for Teams `Action.Execute` |
| `teams_webhook_url`, `alert_webhook_urls`, `gateway_config_json` | `""` (sensitive) | pass via `TF_VAR_*` only |

## Deploy

**Via GitHub Actions (normal path)**

1. First time only: *Actions → Deploy → Run workflow* with `bootstrap = true`. This provisions everything
   except the Container Apps (no image exists yet).
2. Push to `main` (or run *Deploy* with `bootstrap = false`): CI → build 3 images → Trivy (fails on
   CRITICAL) → push `:<git-sha>` → `terraform plan` (summary in the run) → **approval on the `dev`
   environment** → `terraform apply tfplan` → `az containerapp update --image … --revision-suffix g<sha8>-r<run>-<attempt>`
   → smoke test (`/health` + revision health). A failed smoke test rolls the apps back to the previous image.

**Locally (plan only recommended)**

```powershell
az login
cd infra/terraform
Copy-Item environments/dev.backend.hcl.example environments/dev.backend.hcl   # edit values
terraform init -backend-config=environments/dev.backend.hcl
terraform validate
terraform plan -var-file=environments/dev.tfvars -var "image_tag=$(git rev-parse HEAD)" -out tfplan
terraform test          # offline plan tests with mocked providers — no Azure access needed
```

Images are **always** tagged with the git SHA and pushed to `<acr>.azurecr.io/agentgov/{control-plane|mcp-gateway|intelligence}`.

## Post-deploy

1. **Assign app roles**: either set `app_role_principals` in `<env>.tfvars` (recommended; group object ids),
   or *Entra ID → Enterprise applications → agentgov-<env>-api → Users and groups*. The API service
   principal has *assignment required* = on, so un-assigned users cannot get tokens.
2. **Grant consent** for the dashboard SPA to call `api://agentgov-<env>-api/access_as_user`
   (*App registrations → agentgov-<env>-dashboard → API permissions → Grant admin consent*).
3. **Teams webhook**: create a Teams *Workflows* webhook for the approvals channel, save it as the
   `TEAMS_WEBHOOK_URL` secret on `<env>-plan`, and rerun *Deploy*. (Optional bot: `bot_enabled = true`, then
   publish a Teams app manifest that uses `terraform output bot_name`'s app id.)
4. **Enroll local devices**: a `PolicyAdmin` calls
   `POST <control_plane_url>/api/gov/devices/enroll` with `{ "deviceId": "<machine>", "ttlDays": 30 }` and a
   bearer token for `api://agentgov-<env>-api/access_as_user`. On the device set
   `GOVERNANCE_CONTROL_PLANE_URL=<control_plane_url>` and `GOVERNANCE_DEVICE_TOKEN=<token>`.
5. **Connect MCP clients**: expose the gateway only when required, point Foundry agents / Copilot Studio at
   `<mcp_gateway_url>/mcp`, and configure clients to send Entra tokens for `AGENT_GATEWAY_AUDIENCE` with the
   `Agent` app role. Configure upstream servers via the `GATEWAY_CONFIG_JSON` secret (same shape as
   `agent-gateway.example.json`).
6. **Custom domain** (optional): bind it to the control-plane app and add it to `spa_extra_redirect_uris`.

## Cost notes (dev, rough order of magnitude — confirm with the Azure pricing calculator)

| Resource | Driver | Dev ballpark |
|---|---|---|
| Container Apps (consumption) | control-plane + gateway keep 1 replica warm; intelligence can scale to 0 | ~$30–60 / month |
| Azure Managed Redis `Balanced_B0` | fixed hourly (HA doubles it) | ~$25–50 / month |
| Cosmos DB serverless | per RU + storage; switch to autoscale above ~steady load | a few $ at low volume |
| ACR Standard | fixed | ~$20 / month (Basic ~$5) |
| Log Analytics / App Insights | GB ingested; 30-day retention | usage based |
| Content Safety S0 / Foundry | per call / per token (judge is only invoked on gated actions) | usage based |

Set `min_replicas = 0` for the gateway in dev to save more (adds cold-start latency to MCP calls).

## Security notes

- **No long-lived credentials**: GitHub → Azure via OIDC; apps → Azure via user-assigned managed identities;
  ACR admin user disabled; Cosmos, Content Safety and Foundry use **Entra ID only** (local/key auth disabled).
  Redis access keys exist only inside Key Vault (Entra auth for Redis is a planned follow-up).
- **Key Vault**: RBAC mode, purge protection, audit logs to Log Analytics; each app can read only the
  secrets it needs (role assignments at secret scope). Container Apps consume secrets as Key Vault
  **secretRefs** — never plain env vars.
- **Least privilege roles**: AcrPull, Key Vault Secrets User (per secret), Cosmos Built-in Data Contributor,
  Cognitive Services User / OpenAI User, Azure AI User (intelligence only). No Owner/Contributor for workloads.
  The *deployer* has Contributor + RBAC Administrator — scope these to the environment RG and constrain RBAC
  Administrator with an ABAC condition for production.
- **Network**: public endpoints are on by default so GitHub-hosted runners can deploy. For locked-down
  environments: set `infrastructure_subnet_id` (+ `internal_load_balancer_enabled`), add private endpoints
  for Cosmos / Key Vault / Redis / ACR (Premium) / Content Safety, set `public_network_access_enabled = false`
  and `key_vault_network_default_action = "Deny"`, and run deployments from self-hosted runners in the VNet.
- The intelligence service has **internal ingress only**. `GOVERNANCE_TRUST_LOOPBACK=false` in the cloud.
- **Terraform plans** can contain sensitive values: the plan artifact lives for 1 day and is only consumed by
  the approval-gated job. Restrict repository read access accordingly.
- Scanning: tfsec + Checkov on `infra/` (justified exceptions are inline next to each resource), Trivy on the
  filesystem and on every image (CRITICAL fails the pipeline, before the image is pushed).

## Monitoring fleet (optional)

The Python fleet (`fleet/`, image `agentgov/fleet:<git-sha>`) is **off by default** — nothing is planned,
built or rolled out until you opt in, so existing deployments are unchanged.

- **Enable**: set the repository variable `ENABLE_FLEET=true` (repo-level, so the `<env>-plan` and `<env>`
  environments agree). *Deploy* then builds/scans/pushes the fleet image and plans with
  `-var enable_fleet=true -var fleet_image_tag=<sha>`. Setting `enable_fleet = true` in tfvars alone fails
  the plan (no image tag) instead of creating apps with a missing image.
- **What gets created** (`modules/fleet`): user-assigned identity `id-<prefix>-<env>-fleet` (AcrPull; Key Vault
  Secrets User on its own secrets only), Container App `<prefix>-<env>-fleet` (`agentmon-fleet run`, no
  ingress, exactly 1 replica) and `<prefix>-<env>-fleet-hooks` (`agentmon-fleet hooks`, port 8787, external
  ingress, `GET /health`; Copilot Studio webhook = `terraform output fleet_hooks_url` +
  `/copilot-studio/analyze-tool-execution`).
- **RBAC (read-only + one publisher)**: Log Analytics Reader on the workspace, Monitoring Reader + Security
  Reader on each `fleet_scope_subscriptions` entry (default: this subscription), Azure AI User on
  `foundry_account_id` + `fleet_foundry_account_ids`, Storage Blob Data Reader on
  `fleet_diagnostics_storage_account_id`, Monitoring Metrics Publisher on `fleet_alerts_dcr_resource_id`,
  Monitoring Reader on `fleet_monitored_resource_ids`. Owner/Contributor/UAA are rejected by a precondition.
  Dataverse transcripts need the identity (`terraform output fleet_identity_client_id`) added as a Dataverse
  **application user** in the Power Platform environment — not managed by Terraform.
- **Config**: all `FLEET_*` settings come from `fleet_*` variables (see `variables.tf`); list settings are
  JSON-encoded. `FLEET_MONITOR_URL` defaults to this deployment's control plane. Secrets
  (`FLEET_MONITOR_TOKEN`, `FLEET_FOUNDRY_API_KEY`, `FLEET_TYPESAFE_API_KEY`) are GitHub environment secrets →
  `TF_VAR_fleet_*` → Key Vault → `secretRef`; never plain env vars. Auth to Azure is the managed identity
  (`FLEET_MANAGED_IDENTITY_CLIENT_ID`) — no client secret. Hooks are never anonymous; set
  `fleet_hooks_audience` / `fleet_hooks_allowed_app_ids` (the plan fails when hooks are enabled and the audience is empty; set `fleet_sizing.hooks_enabled = false` to run without hooks).
- **State is ephemeral**: SQLite (WAL) at `/data` on an **EmptyDir** volume per app. Azure Files was not used
  because SQLite WAL locking is unreliable over SMB and ACA Azure Files mounts require a storage account key.
  State survives container restarts but not new revisions/replica moves; the worker then re-reads the last
  `FLEET_LOOKBACK_MINUTES` of logs, so a few duplicate alerts are possible after a rollout. Keep
  `fleet_sizing.hooks_max_replicas = 1` unless you accept per-replica session context.

```powershell
terraform -chdir=infra/terraform output fleet_app_names
curl.exe -fsS "$(terraform -chdir=infra/terraform output -raw fleet_hooks_url)/health"   # {"ok":true,...}
az containerapp logs show -n agentgov-dev-fleet -g rg-agentgov-dev --tail 50
```

## How to verify this worked

```powershell
terraform -chdir=infra/terraform output control_plane_url
curl.exe -fsS "$(terraform -chdir=infra/terraform output -raw control_plane_url)/health"      # {"ok":true,...}
az containerapp revision list -n agentgov-dev-control-plane -g rg-agentgov-dev -o table        # Healthy, suffix g<sha8>-…
az acr repository show-tags -n "$(terraform -chdir=infra/terraform output -raw acr_name)" --repository agentgov/control-plane -o table
az containerapp logs show -n agentgov-dev-control-plane -g rg-agentgov-dev --tail 50
```

Rollback: `az containerapp update -n <app> -g <rg> --image <acr>/agentgov/<app>:<previous-sha>` (or activate a
previous revision — up to 10 inactive revisions are kept). Never `terraform destroy`: revert the commit and
re-run *Deploy*.
