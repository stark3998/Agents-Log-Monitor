# AgentMon Fleet — telemetry sources

This page covers what each collector reads, how fresh the data is, the exact KQL or API calls, the permissions each needs, and what the source can't show. For the architecture and detectors, see [fleet.md](fleet.md). For the synchronous hook path, see [fleet-realtime-hooks.md](fleet-realtime-hooks.md).

## Source matrix

| Data | Foundry agents | Copilot Studio agents | Direct model inference (no agent) |
|---|---|---|---|
| **Inventory** | ARM discovery of accounts and projects; data plane `/agents` and `/assistants`; Entra Agent ID¹; Defender `AgentsInfo`¹ | Dataverse `bots` / `botcomponents`; Entra Agent ID¹; Defender `AgentsInfo`¹ | ARM discovery of accounts; the inference inventory built from diagnostics (`agentmon-fleet stats`); profiles synthesized from Responses API apps |
| **Content** (prompts, replies) | Responses API items (`foundry.responses`); classic threads and messages (`foundry.classic`); GenAI spans + `AppGenAIContent` (`law.genai`) | Dataverse transcripts (`dataverse.transcripts`); `AppEvents` text (agent-level App Insights); environment-level OTel spans; webhook (`hook.copilot_studio`) | Stored Responses on the project endpoint (`foundry.responses`, platform `azure_openai`). Diagnostics carry **no content**. APIM is the [future phase](apim-ai-gateway.md). |
| **Tool calls** | Responses items (`function_call`, `mcp_call`, `mcp_approval_request`, built-in tool calls); classic run steps; `execute_tool` spans; `/evaluate` | Transcript `DynamicPlanStep*`; `AppEvents` `TopicAction`; `ExecuteTool` spans; webhook | Only when the app instruments itself: `chat` spans with tool calls, SDK middleware (`/evaluate`, `/events`) |
| **Blocks and denials** | Content filter / jailbreak errors on responses; MCP approval denied; tool output matching block patterns; `/evaluate` enforce blocks | Blocked plan steps; guardrail-blocked replies; model refusals; Purview `JailbreakDetected`¹; webhook enforce blocks | `AzureDiagnostics` 400 content filter and 401/403 |
| **Inference metadata** | `AzureDiagnostics` (`RequestResponse`, `AzureOpenAIRequestUsage`); `chat` span tokens | Model on environment-level spans | `AzureDiagnostics`: caller `objectId`, IP, deployment, tokens |
| **Network** | `NTANetAnalytics` for tools routed through your VNet (private MCP, OpenAPI, Functions) | `NTANetAnalytics` only for VNet-injected environments | `NTANetAnalytics` from the calling subnets |
| **Control plane** | `AzureActivity`; `AzureDiagnostics` `Audit` (ListKey); definition-hash changes | Purview `Bot*` operations¹; Defender `CloudAppEvents`¹; `BOTSERVICE` / `POWERPLATFORM` activity; definition-hash changes | `AzureActivity` (keys, deployments, RAI policies, role assignments, diagnostic settings) |
| **Threat intel** | `SecurityAlert` `AI.*` (Defender for Cloud); Defender XDR `AlertInfo` / `BehaviorInfo`¹ | Defender XDR `BehaviorInfo` (real-time protection)¹, `AlertInfo`¹ | `SecurityAlert` `AI.*` |
| **Tenant** | Entra agent sign-ins¹ | Purview `CopilotInteraction`¹, Entra agent sign-ins¹ | — |

¹ Optional tenant collectors, off by default. See [Tenant collectors](#tenant-collectors-opt-in).

## Latency at a glance

| Source | Collector | Typical latency |
|---|---|---|
| Real-time hooks | `hook.*` | Synchronous, under 1 s |
| Foundry data plane | `foundry` | The poll interval (`FLEET_POLL_INTERVAL_S`, 120 s) |
| Foundry resource logs (`AzureDiagnostics`) | `law.inference`, `law.audit` | Minutes; can take up to 2 h ([Learn](https://learn.microsoft.com/azure/foundry/how-to/diagnostic-logging)) |
| Foundry server-side traces (`AppDependencies` + `AppGenAIContent`) | `law.genai` | Minutes (Application Insights ingestion) |
| Copilot Studio agent-level App Insights (`AppEvents`) | `law.cs_events` | Minutes |
| Copilot Studio environment-level OTel export | `law.genai` | Up to 24 h, preview ([Learn](https://learn.microsoft.com/power-platform/admin/set-up-export-application-insights)) |
| `AzureActivity` | `law.activity` | Minutes |
| VNet flow logs and Traffic Analytics (`NTANetAnalytics`) | `law.network` | The Traffic Analytics processing interval (10 or 60 min) plus ingestion |
| `SecurityAlert` | `law.defender` | Minutes after Defender raises the alert (needs continuous export or Sentinel) |
| Dataverse transcripts | `dataverse` | About 30 min after the conversation goes inactive ([Learn](https://learn.microsoft.com/microsoft-copilot-studio/analytics-transcripts-powerapps)) |
| Diagnostics archive (`insights-logs-*`) | `storage` | Hourly `PT1H.json` blobs |
| O365 Management Activity API | `purview` | Not stated on Learn; minutes to hours in practice |
| Entra sign-ins / Defender XDR hunting | `entra` / `defender` | Minutes |

Each collector keeps a cursor per query. Every cycle it re-reads `FLEET_OVERLAP_MINUTES` (default 45; Dataverse at least 90, Purview at least 60) because late rows are common. Events are deduplicated by id.

---

## Log Analytics — `collectors/law.py`

Enabled by `FLEET_LAW_WORKSPACE_ID` (the workspace GUID). The collector runs six queries from [law_queries.py](../fleet/src/agentmon_fleet/collectors/law_queries.py) through `azure-monitor-query`, with `{start}` and `{end}` set to the cursor window. A table that doesn't exist yet (`Failed to resolve table`) is skipped quietly.

### 1. Model inference — `AzureDiagnostics` (`law.inference`, `law.audit`)

This covers Foundry / Azure OpenAI resource logs. `Audit` rows (for example `ListKey`) become `control_plane` events. `400` with a filter operation becomes `blocked: content_filter`, and `401`/`403` becomes `blocked: access denied`.

```kusto
AzureDiagnostics
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where ResourceProvider == "MICROSOFT.COGNITIVESERVICES" and Category in ("RequestResponse", "AzureOpenAIRequestUsage", "Audit")
| extend p = parse_json(properties_s)
// AzureOpenAIRequestUsage reports token counts as arrays ([n]); RequestResponse reports scalars.
| project TimeGenerated, ResourceId = _ResourceId, Resource, Category, OperationName, ResultSignature, DurationMs,
    CallerIPAddress, CorrelationId, objectId = tostring(p.objectId), callerObjectId = tostring(p.callerObjectId),
    apiName = tostring(p.apiName), deployment = tostring(p.modelDeploymentName), model = tostring(p.modelName),
    promptTokens = coalesce(toint(p.promptTokens), toint(p.promptTokens[0])),
    completionTokens = coalesce(toint(p.completionTokens), toint(p.generatedTokens[0])),
    cachedTokens = toint(p.cachedTokens[0]), streamType = tostring(p.streamType), requestLength = tolong(p.requestLength),
    responseLength = tolong(p.responseLength)
| order by TimeGenerated asc
| take 20000
```

Setup: add a diagnostic setting (`allLogs`) on each Foundry account and project that sends to the workspace. `infra/lab/enable-ai-diagnostics.ps1` does this idempotently for a subscription; `infra/lab/provision-lab.ps1 -Steps diagnostics` reports the gaps. Categories are listed in [supported logs](https://learn.microsoft.com/azure/azure-monitor/reference/supported-logs/microsoft-cognitiveservices-accounts-logs). The `properties_s` keys are observed rather than documented ([monitoring reference](https://learn.microsoft.com/azure/foundry/openai/monitor-openai-reference)).

### 2. Agent traces — `AppDependencies` + `AppGenAIContent` (`law.genai`)

This covers Foundry server-side agent tracing and Copilot Studio environment-level OTel export. Spans named `InvokeAgent`, `ExecuteTool` or `OutputMessages`, or with `telemetry.sdk.name = A365ObservabilitySDK`, are marked as `copilot_studio`. `execute_tool` becomes `tool_call`. `invoke_agent` and `chat` become user, assistant and inference events.

Foundry spans for a session the Responses API collector (`foundry.responses`) already covers are dropped before storage, so a conversation isn't analysed twice. Spans still matter for projects outside `FLEET_CONTENT_PROJECTS`, for Copilot Studio, and for Code Interpreter and function calls that never reach network logs.

```kusto
let spans = AppDependencies
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where isnotempty(Properties["gen_ai.operation.name"]) or Name in ("InvokeAgent", "ExecuteTool", "OutputMessages")
| project TimeGenerated, SpanId = Id, TraceId = OperationId, ParentId, Name, Success, ResultCode, DurationMs, AppRoleName,
    _ResourceId, Properties;
let content = AppGenAIContent
| where TimeGenerated between (datetime({start}) - 10m .. datetime({end}) + 10m)
| project SpanId, InputMessages, OutputMessages, SystemInstructions, ToolDefinitions, ToolCallArguments, ToolCallResult;
spans
| join kind=leftouter content on SpanId
| order by TimeGenerated asc
| take 20000
```

- Foundry: connect Application Insights to the project, and the Agent Service traces prompt and hosted agents automatically ([trace-agent-setup](https://learn.microsoft.com/azure/foundry/observability/how-to/trace-agent-setup)).
- **Starting 2026-09-30, GenAI content attributes are written only to [`AppGenAIContent`](https://learn.microsoft.com/azure/azure-monitor/reference/tables/appgenaicontent)** ([traces-sensitive-content](https://learn.microsoft.com/azure/foundry/observability/how-to/traces-sensitive-content)). The query joins on `SpanId` and falls back to `Properties` for older rows. If you set the table to Protected, the fleet identity also needs **Privileged Monitoring Data Reader**.
- Copilot Studio environment-level export: in PPAC go to Manage → Data export → App Insights, then choose type **Copilot Studio**. It requires a Managed Environment ([Learn](https://learn.microsoft.com/microsoft-copilot-studio/advanced-environment-level-agent-telemetry)).

### 3. Copilot Studio agent telemetry — `AppEvents` (`law.cs_events`)

This covers agent-level Application Insights (the agent's **Settings → Advanced → Application Insights** page, [Learn](https://learn.microsoft.com/microsoft-copilot-studio/advanced-bot-framework-composer-capture-telemetry)). Design-mode (test pane) events are dropped.

| Event | Maps to |
|---|---|
| `BotMessageReceived` | `user_message` |
| `BotMessageSend`, `GenerativeAnswers` | `assistant_message` (block patterns set `blocked`) |
| `TopicAction` with `Kind` = Flow, Connector, HTTP, Skill or AI Builder | `tool_call` |
| `OnErrorLog` | `error` |

```kusto
AppEvents
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where Name in ("BotMessageReceived", "BotMessageSend", "TopicStart", "TopicAction", "TopicEnd", "GenerativeAnswers", "OnErrorLog")
    or isnotempty(Properties["conversationId"])
| project TimeGenerated, Name, Properties, SessionId, UserId, AppRoleName, _ResourceId
| order by TimeGenerated asc
| take 20000
```

Turn on **Log conversation details** in the agent settings, or `text` is empty.

### 4. Control plane — `AzureActivity` (`law.activity`)

Needs the subscription activity log sent to the workspace (`az monitor diagnostic-settings subscription create … --logs '[{"category":"Administrative","enabled":true}]'`).

```kusto
AzureActivity
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where ResourceProviderValue in~ ("MICROSOFT.COGNITIVESERVICES", "MICROSOFT.MACHINELEARNINGSERVICES", "MICROSOFT.AUTHORIZATION",
    "MICROSOFT.KEYVAULT", "MICROSOFT.INSIGHTS", "MICROSOFT.POWERPLATFORM", "MICROSOFT.BOTSERVICE",
    "MICROSOFT.OPERATIONALINSIGHTS", "MICROSOFT.APIMANAGEMENT")
| where ActivityStatusValue in~ ("Success", "Succeeded", "Failure", "Failed") and CategoryValue == "Administrative"
| project TimeGenerated, OperationNameValue, ActivityStatusValue, Caller, CallerIpAddress, ResourceId = _ResourceId,
    CorrelationId, Claims_d = Claims, Properties_d = Properties
| order by TimeGenerated asc
| take 5000
```

### 5. Network — `NTANetAnalytics` (`law.network`)

Needs VNet flow logs with Traffic Analytics on the agent and tool subnets. New NSG flow logs can no longer be created ([Learn](https://learn.microsoft.com/azure/network-watcher/nsg-flow-logs-overview)). Flows are summarized per source, destination, port and direction. Public endpoints come from `SrcPublicIps`/`DestPublicIps` (`"ip|counters ..."`) when `SrcIp`/`DestIp` are empty. `FlowStatus` is `Allowed`/`Denied` (older rows use `A`/`D`); a flow is `blocked` when every status seen is a denial. `FlowDirection` is kept, so the Sentinel treats inbound flows (scanners hitting a public tool endpoint) separately from agent egress. Column reference: [NTANetAnalytics](https://learn.microsoft.com/azure/azure-monitor/reference/tables/ntanetanalytics).

```kusto
NTANetAnalytics
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where SubType == "FlowLog" and FlowType in ("ExternalPublic", "MaliciousFlow", "AzurePublic", "UnknownPrivate", "Unknown")
| extend Src = iff(isempty(SrcIp), extract(@"(\d+\.\d+\.\d+\.\d+)", 1, tostring(SrcPublicIps)), SrcIp),
    Dst = iff(isempty(DestIp), extract(@"(\d+\.\d+\.\d+\.\d+)", 1, tostring(DestPublicIps)), DestIp)
| summarize TimeGenerated = min(TimeGenerated), Bytes = sum(BytesSrcToDest), Flows = count(), Statuses = make_set(FlowStatus, 4)
    by SrcIp = Src, DestIp = Dst, DestPort, L7Protocol, FlowType, FlowDirection, SrcSubnet, DestSubnet, TargetResourceId, Country
| take 5000
```

The lab generates agent-driven flows by pointing an OpenAPI tool at the vendor directory VM (`provision-lab.ps1 -Steps network`).

### 6. Defender for AI — `SecurityAlert` (`law.defender`)

Needs Defender for Cloud **AI threat protection** on the subscription ([ai-onboarding](https://learn.microsoft.com/azure/defender-for-cloud/ai-onboarding)). Alerts must also reach the workspace, through Sentinel or Defender for Cloud continuous export. Alert types are listed in [alerts-ai-workloads](https://learn.microsoft.com/azure/defender-for-cloud/alerts-ai-workloads). Alert types that contain `Blocked` are recorded as denials. The mapping onto fleet alerts is in [fleet.md](fleet.md#inference--network-sentinel--detectorsinferencepy).

```kusto
SecurityAlert
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where AlertType startswith "AI."
| project TimeGenerated, AlertName, AlertType, AlertSeverity, Description, CompromisedEntity, ExtendedProperties, Entities,
    SystemAlertId, ResourceId = AzureResourceId
| take 1000
```

---

## Foundry data plane — `collectors/foundry.py`

Enabled when `FLEET_FOUNDRY_PROJECT_ENDPOINT`, `FLEET_SUBSCRIPTION_ID` or `FLEET_FOUNDRY_PROJECTS` is set. It calls Entra with scope `https://ai.azure.com/.default`.

| Step | Call | Result |
|---|---|---|
| Discovery (`discovery.py`) | `GET https://management.azure.com/subscriptions/{sub}/providers/Microsoft.CognitiveServices/accounts?api-version=2025-06-01`, then `GET {account}/projects` for `AIServices` accounts | Projects with their `AI Foundry API` endpoint. Account and project managed identities are registered as known callers. |
| Agent definitions (v2) | `GET {project}/agents?api-version=v1` | Charter input: instructions, tools (including MCP `require_approval` and `allowed_tools`), model, version |
| Agent definitions (classic) | `GET {project}/assistants?api-version=v1` | Charter input |
| Responses | `GET {project}/openai/v1/responses?order=desc&limit=100` (at most 200 new per cycle), then `GET …/responses/{id}/input_items` | User and assistant messages, tool calls and outputs, MCP approval requests and responses, reasoning, content-filter blocks, token usage. Responses without an agent reference are grouped as direct apps (`metadata.agent_name` / `metadata.app`, otherwise the tool set) with platform `azure_openai`, and a charter is synthesized from their instructions and tools. |
| Classic threads | `GET {project}/threads`, then `/runs`, `/messages`, `/runs/{id}/steps` (at most 60 threads) | Messages and run steps (`foundry.classic`) |

- `FLEET_CONTENT_PROJECTS` limits this deep collection to specific projects. The other projects are still covered by diagnostics.
- A 401 or 403 on a project is logged once and the project is skipped until restart.
- The classic Agent Service retires 2027-03-31 ([migrate](https://learn.microsoft.com/azure/foundry/agents/how-to/migrate)).

## Dataverse (Copilot Studio) — `collectors/dataverse.py`

Enabled by `FLEET_DATAVERSE_ORG_URL`. It uses the Web API v9.2 with scope `{org}/.default`.

| Table | Query | Result |
|---|---|---|
| `bots` | `$select=botid,name,schemaname,configuration,publishedon,statecode,authenticationmode` | Agent inventory and charter input |
| `botcomponents` | Topics, skills, knowledge sources, custom GPT instructions, settings | Charter input (tools and instructions) |
| `conversationtranscripts` | `$filter=createdon gt {start}`, ordered by `createdon` | Parsed by [dataverse_transcripts.py](../fleet/src/agentmon_fleet/collectors/dataverse_transcripts.py): message activities, `DynamicPlanReceived`, `DynamicPlanStepTriggered`, `DynamicPlanStepBindUpdate` and `DynamicPlanStepFinished` (tool calls with arguments, results and blocks), error traces. Design-mode conversations are skipped. |

Table reference: [conversationtranscript](https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/conversationtranscript), [bot](https://learn.microsoft.com/power-apps/developer/data-platform/reference/entities/bot).

## Diagnostics archive — `collectors/storage.py`

This is a fallback for accounts whose diagnostic settings write only to storage. It reads `insights-logs-requestresponse` and `insights-logs-azureopenairequestusage` (JSON lines) from `FLEET_STORAGE_ACCOUNT`, tracking a byte offset per blob, and reuses the LAW row mappers. It is skipped when LAW is configured unless you run `--source storage`.

## Tenant collectors (opt-in)

[collectors/tenant.py](../fleet/src/agentmon_fleet/collectors/tenant.py). Each collector is off until you set its flag. Each needs **application permissions on the fleet's app registration, granted with tenant-wide admin consent** (a Global Administrator or Privileged Role Administrator). A managed identity has no **API permissions** page in the portal. Either assign the app roles to its service principal with Microsoft Graph (`appRoleAssignments`), or run the tenant collectors as an app registration.

| Flag | API | Application permission | What the fleet reads |
|---|---|---|---|
| `FLEET_TENANT_PURVIEW=true` | O365 Management Activity API: `https://manage.office.com/api/v1.0/{tenant}/activity/feed/subscriptions/content?contentType=Audit.General` (24 h pages, last 7 days only), then each `contentUri` | **Office 365 Management APIs → `ActivityFeed.Read`** | `CopilotInteraction` (RecordType 261): accessed resources with sensitivity labels, plugins, `JailbreakDetected` (a user denial). Copilot Studio `Bot*` / `AgentCreate`-style authoring operations (control plane). Needs `FLEET_AZURE_TENANT_ID`. |
| `FLEET_PURVIEW_START_SUBSCRIPTION=true` | `POST …/subscriptions/start?contentType=Audit.General` | Same | Starts the subscription once ("already enabled" is fine). Otherwise start it yourself. |
| `FLEET_TENANT_ENTRA=true` | Graph `GET /v1.0/servicePrincipals/microsoft.graph.agentIdentity` (hourly) and `GET /beta/auditLogs/signIns?$filter=signInEventTypes/any(t: t eq 'servicePrincipal') and agent/agentType eq 'AgentIdentity' and createdDateTime ge {start}` | **Graph → `Application.Read.All`** (or `AgentIdentity.Read.All`) **and `AuditLog.Read.All`** | Registers agent identities as known callers and matches them to charters by name. Agent sign-ins become control-plane events; failures become denials. Sign-in logs through Graph need Entra ID P1/P2. |
| `FLEET_TENANT_DEFENDER=true` | Graph `POST /v1.0/security/runHuntingQuery` | **Graph → `ThreatHunting.Read.All`** | `AlertInfo` + `AlertEvidence`, `BehaviorInfo`, Copilot Studio `CloudAppEvents` (configuration changes only), and `AgentsInfo` (agent identities). Tables that are missing or not licensed are skipped for the rest of the process. |

Defender hunting queries (from `tenant.py`):

```kusto
AlertInfo
| where Timestamp between (datetime({start}) .. datetime({end}))
| where Title has_any ("AI", "agent", "Copilot", "prompt", "jailbreak", "LLM", "model")
    or Category has_any ("AI", "Agent") or DetectionSource has_any ("AI", "Agent")
| join kind=leftouter (AlertEvidence | where Timestamp between (datetime({start}) .. datetime({end}))
    | summarize Entities = make_set(pack("type", EntityType, "role", EvidenceRole, "account", AccountObjectId,
        "app", Application, "ip", RemoteIP, "url", RemoteUrl, "resource", CloudResource), 20) by AlertId) on AlertId
| project Timestamp, AlertId, Title, Category, Severity, ServiceSource, DetectionSource, AttackTechniques, Entities
| take 500
```

```kusto
BehaviorInfo
| where Timestamp between (datetime({start}) .. datetime({end}))
| where ServiceSource has_any ("AI", "Agent") or Description has_any ("agent", "Copilot", "AI ")
| project Timestamp, BehaviorId, ActionType, Description, Categories, AttackTechniques, ServiceSource,
    AccountObjectId, AccountUpn
| take 500
```

```kusto
CloudAppEvents
| where Timestamp between (datetime({start}) .. datetime({end}))
| where Application has_any ("Copilot Studio", "Power Virtual Agents", "Microsoft Power Platform")
| project Timestamp, ReportId, ActionType, Application, AccountObjectId, AccountDisplayName, IPAddress, ObjectId,
    ObjectName, RawEventData
| take 2000
```

```kusto
AgentsInfo | take 1000
```

To grant: go to App registrations → *fleet app* → **API permissions** → **Add a permission**. Choose *Microsoft Graph* or *Office 365 Management APIs*, then **Application permissions**, and select the permissions above. Then select **Grant admin consent**. Or:

```powershell
az ad app permission admin-consent --id <fleet-app-id>
```

References: [Management Activity API](https://learn.microsoft.com/office/office-365-management-api/office-365-management-activity-api-reference), [Copilot audit schema](https://learn.microsoft.com/office/office-365-management-api/copilot-schema), [Entra agent identities](https://learn.microsoft.com/entra/agent-id/manage-agent-identities-admin), [Defender agent tables and Agent 365](https://learn.microsoft.com/defender-xdr/security-for-ai/transition-agent-security-to-agent-365).

---

## Permissions

### Azure RBAC (fleet identity)

The lab service principal and the Terraform-managed identity get read-only roles, plus one publisher role:

| Role | Scope | Used by |
|---|---|---|
| **Log Analytics Reader** | Workspace | `law` collector, the Fleet Commander `run_kql` tool |
| **Monitoring Reader** | Subscriptions in scope and monitored resources | ARM discovery (`*/read`), diagnostic-setting and metric reads |
| **Storage Blob Data Reader** | Diagnostics storage account | `storage` collector |
| **Azure AI User** (renamed **Foundry User**; same role id, [rbac-foundry](https://learn.microsoft.com/azure/foundry/concepts/rbac-foundry)) | Foundry accounts | `foundry` collector, LLM calls, scenario runner |
| **Security Reader** | Subscriptions in scope | Defender for Cloud alerts |
| **Monitoring Metrics Publisher** | The alerts DCR | LAW sink (`Custom-AgentMonAlerts` → `AgentMonAlerts_CL`) |
| Privileged Monitoring Data Reader (only if `AppGenAIContent` is Protected) | Workspace | GenAI content |

The Terraform module rejects Owner, Contributor and User Access Administrator (see [infra/README.md](../infra/README.md#monitoring-fleet-optional)).

### Dataverse

Add the fleet's app or managed identity as a Dataverse **application user** in the Power Platform environment, with a **read-only security role**. `infra/lab/provision-lab.ps1 -Steps dataverse` creates the role **"AgentMon Fleet Reader"** (read on `bot`, `botcomponent`, `conversationtranscript` and `audit`), creates the application user, and enables auditing on `bot` and `botcomponent`. Terraform doesn't manage this step.

### Hooks

See [fleet-realtime-hooks.md](fleet-realtime-hooks.md#authentication).

---

## Known gaps

| Gap | Impact | Mitigation |
|---|---|---|
| Foundry resource logs (`AzureDiagnostics`) carry **no prompt or completion content**, and `properties_s` isn't documented | You can see who, how much and the status, but not what was asked | Foundry data-plane Responses, GenAI traces, or the [APIM AI gateway](apim-ai-gateway.md) |
| Key-based inference has no caller `objectId` | You can't tell who called | `ListKey` audit and key-enumeration detection; disable local auth |
| **Code Interpreter and function calling run on the Microsoft backbone.** Bing, Web search and SharePoint tools use public endpoints. None of them appear in your flow logs or firewall ([private link](https://learn.microsoft.com/azure/foundry/how-to/configure-private-link)). | No network evidence for those tools | Tool-call content from Responses and traces; code analysis |
| Copilot Studio environment-level OTel needs a **Managed Environment**; it's preview, can take up to 24 h, has no topic events, and truncates payloads | Slow or partial spans | Dataverse transcripts, agent-level `AppEvents`, the webhook |
| Copilot Studio agent-level App Insights is configured per agent and has no OTel spans | Only covers agents where a maker turned it on | Enforce with DLP on the "Application Insights in Copilot Studio" connector |
| Dataverse transcripts arrive about 30 min after inactivity and aren't written in every environment type | Delayed detection | Webhook for tool calls |
| The Copilot Studio webhook runs only for **generative orchestration**, and only for tool calls (not final answers or knowledge retrieval) | Classic agents aren't gated | Transcripts and `AppEvents` |
| Purview `CopilotInteraction` has message **ids only, no text** | Can't analyse intent | Transcripts, or DSPM for AI |
| **Defender agent tables** (`AgentsInfo`, Agent 365 `CloudAppEvents`) need **Agent 365 licensing**; `AIAgentsInfo` ends 2026-07-01 | The Defender collector skips missing tables | Entra Agent ID inventory |
| `SecurityAlert` reaches the workspace only through Sentinel or continuous export. In the lab, Sentinel isn't enabled. | No Defender passthrough without export | Enable continuous export, or turn on `FLEET_TENANT_DEFENDER` |
| Traffic outside VNet-injected subnets (generic connectors, unlisted MCP servers, Microsoft-hosted LLM calls from Copilot Studio) isn't in flow logs | No network view for those calls | `ExecuteTool` spans; DLP endpoint filtering |
| The Power Platform inventory API accepts delegated user tokens only | Not used by the fleet | Dataverse `bots` + Entra Agent ID |
