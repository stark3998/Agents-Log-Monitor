# APIM AI gateway (future phase)

> **Status: proposed, not implemented.** Nothing on this page exists in the code yet: no `apim` collector, none of the settings or Terraform module named below. It specifies the next phase so the work can be picked up directly. Everything else the fleet does today is in [fleet.md](fleet.md) and [fleet-sources.md](fleet-sources.md).

## Why

Today the fleet sees direct model inference through Foundry resource logs (`AzureDiagnostics`). Those logs carry **who, how much and the status, but no prompt or completion content** ([fleet-sources.md → Known gaps](fleet-sources.md#known-gaps)). Key-based calls carry no identity at all.

Azure API Management's AI gateway in front of Foundry and Azure OpenAI gives four things:

| Need | APIM capability |
|---|---|
| Content for direct callers | LLM logging to `ApiManagementGatewayLlmLog` (prompts and completions) |
| Caller identity on every call | Callers authenticate to APIM with Entra (`validate-azure-ad-token`); APIM authenticates to the backend with its **managed identity** |
| Inline controls | `llm-content-safety` (Prompt Shields and harm categories), `llm-token-limit` (TPM and quotas) |
| Near-real-time stream | `log-to-eventhub`, readable in seconds rather than minutes |

References: [AI gateway capabilities](https://learn.microsoft.com/azure/api-management/genai-gateway-capabilities), [AI gateway policies](https://learn.microsoft.com/azure/api-management/api-management-policies#ai-gateway), [Import a Microsoft Foundry API](https://learn.microsoft.com/azure/api-management/azure-ai-foundry-api).

## Target architecture

```text
 apps / pipelines / custom agents ──Entra token (aud = APIM API)──►  APIM AI gateway (v2 tier)
 Foundry agents (BYOM connection) ─────────────────────────────────►   inbound:  validate-azure-ad-token → trace(oid,appid)
                                                                              llm-token-limit → llm-emit-token-metric
                                                                              llm-content-safety (shield-prompt)
                                                                              authentication-managed-identity
                                                                     backend:  Foundry / Azure OpenAI (keys disabled)
                                                                     outbound: log-to-eventhub (response + caller)
          │ diagnostic setting "Logs related to generative AI gateway"          │ Event Hub logger (managed identity)
          ▼                                                                      ▼
  ApiManagementGatewayLlmLog + ApiManagementGatewayLogs (LAW)          Event Hub  agentmon-llm
          └───────────────────────────► fleet collector "apim" ◄──────────────────┘
                                              │ CanonicalEvent: inference + user/assistant messages + tool calls
                                              ▼
                     InferenceNetworkSentinel · IntentAnalyst · ActionAnalyst · EvasionMonitor → alerts
```

## APIM configuration

### 1. Gateway and backend

- An APIM **v2 tier** (Basic v2, Standard v2 or Premium v2). Foundry's built-in AI Gateway option (Foundry portal → Manage → AI Gateway) needs a v2 tier and fronts a single Foundry resource per gateway ([Learn](https://learn.microsoft.com/azure/foundry/configuration/enable-ai-api-management-gateway-portal)).
- Import the Foundry or Azure OpenAI API ([Learn](https://learn.microsoft.com/azure/api-management/azure-ai-foundry-api)).
- Enable APIM's managed identity and grant it **Cognitive Services OpenAI User** (or **Foundry User**) on each Foundry account.
- To route **Foundry agents' own model calls** through APIM, create an `ApiManagement` or `ModelGateway` connection in the project and set the agent model to `<connection-name>/<model-name>` ([Learn](https://learn.microsoft.com/azure/foundry/agents/how-to/ai-gateway)).
- Then **disable local (key) auth** on the Foundry accounts and restrict network access, so that APIM is the only path.

### 2. Policies

Here is the API-scope policy. Replace the `{{…}}` named values and `backend-id`s with yours.

```xml
<policies>
  <inbound>
    <base />
    <!-- Caller identity: only tokens from our tenant, for this API, from allow-listed apps -->
    <validate-azure-ad-token tenant-id="{{tenant-id}}" header-name="Authorization"
                             failed-validation-httpcode="401" output-token-variable-name="jwt">
      <audiences><audience>{{apim-ai-audience}}</audience></audiences>
    </validate-azure-ad-token>
    <set-variable name="oid" value="@(((Jwt)context.Variables["jwt"]).Claims.GetValueOrDefault("oid", ""))" />
    <set-variable name="appid" value="@(((Jwt)context.Variables["jwt"]).Claims.GetValueOrDefault("azp", ((Jwt)context.Variables["jwt"]).Claims.GetValueOrDefault("appid", "")))" />
    <!-- Keep the prompt for the outbound Event Hub record (the backend call consumes the body otherwise) -->
    <set-variable name="reqBody" value="@(context.Request.Body.As<string>(preserveContent: true))" />
    <!-- Caller identity into ApiManagementGatewayLogs.TraceRecords (resource-log verbosity must be >= information) -->
    <trace source="agentmon" severity="information">
      <message>caller</message>
      <metadata name="oid" value="@((string)context.Variables["oid"])" />
      <metadata name="appid" value="@((string)context.Variables["appid"])" />
      <metadata name="session" value="@(context.Request.Headers.GetValueOrDefault("x-agentmon-session", ""))" />
    </trace>
    <!-- Per-caller token rate limit and daily quota: 429 on TPM, 403 on quota -->
    <llm-token-limit counter-key="@((string)context.Variables["oid"])" tokens-per-minute="50000"
                     token-quota="2000000" token-quota-period="Daily" estimate-prompt-tokens="false" />
    <!-- Token metrics to Application Insights (<= 5 custom dimensions; keep cardinality low) -->
    <llm-emit-token-metric namespace="agentmon-llm">
      <dimension name="API ID" />
      <dimension name="Subscription ID" />
      <dimension name="Caller app" value="@((string)context.Variables["appid"])" />
    </llm-emit-token-metric>
    <!-- Prompt Shields + harm categories via Azure AI Content Safety: 403 on detection -->
    <llm-content-safety backend-id="content-safety" shield-prompt="true" enforce-on-completions="true">
      <categories output-type="FourSeverityLevels">
        <category name="Hate" threshold="4" />
        <category name="Violence" threshold="4" />
        <category name="SelfHarm" threshold="4" />
        <category name="Sexual" threshold="4" />
      </categories>
    </llm-content-safety>
    <!-- Backend auth with APIM's managed identity; no keys -->
    <authentication-managed-identity resource="https://cognitiveservices.azure.com" />
    <set-backend-service backend-id="foundry-openai" />
  </inbound>
  <backend><base /></backend>
  <outbound>
    <base />
    <log-to-eventhub logger-id="agentmon-llm" partition-key="@((string)context.Variables["oid"])">@{
      return new JObject(
        new JProperty("ts", DateTime.UtcNow.ToString("o")),
        new JProperty("correlationId", context.RequestId.ToString()),
        new JProperty("oid", (string)context.Variables["oid"]),
        new JProperty("appid", (string)context.Variables["appid"]),
        new JProperty("callerIp", context.Request.IpAddress),
        new JProperty("session", context.Request.Headers.GetValueOrDefault("x-agentmon-session", "")),
        new JProperty("api", context.Api.Id),
        new JProperty("operation", context.Operation.Id),
        new JProperty("status", context.Response.StatusCode),
        new JProperty("request", (string)context.Variables["reqBody"]),
        new JProperty("response", context.Response.Body?.As<string>(preserveContent: true))
      ).ToString();
    }</log-to-eventhub>
  </outbound>
  <on-error>
    <base />
    <!-- Same payload with status and context.LastError.Source / .Reason, so content-safety and quota blocks are streamed too -->
  </on-error>
</policies>
```

| Policy | Purpose | Reference |
|---|---|---|
| `validate-azure-ad-token` | Requires an Entra token. `output-token-variable-name` exposes the claims (`oid`, `azp`/`appid`). | [Learn](https://learn.microsoft.com/azure/api-management/validate-azure-ad-token-policy) |
| `trace` | Writes the caller identity into `ApiManagementGatewayLogs.TraceRecords` when the severity is at or above the diagnostic verbosity | [Learn](https://learn.microsoft.com/azure/api-management/trace-policy) |
| `llm-token-limit` | Per-key TPM (429) and quota (403) | [Learn](https://learn.microsoft.com/azure/api-management/llm-token-limit-policy) |
| `llm-emit-token-metric` | Token metrics to Application Insights. At most 5 custom dimensions, 100 values per dimension and 1,000 time series per namespace, so **don't** use `oid` as a dimension in large tenants. | [Learn](https://learn.microsoft.com/azure/api-management/llm-emit-token-metric-policy) |
| `llm-content-safety` | Calls Azure AI Content Safety through a backend (APIM managed identity with **Cognitive Services User**, backend URL `https://<name>.cognitiveservices.azure.com`, credential resource `https://cognitiveservices.azure.com`). `shield-prompt` checks for user attacks. Detections return **403**. | [Learn](https://learn.microsoft.com/azure/api-management/llm-content-safety-policy) |
| `authentication-managed-identity` | Backend token from APIM's managed identity | [Learn](https://learn.microsoft.com/azure/api-management/authentication-managed-identity-policy) |
| `log-to-eventhub` | Streams a caller-attributed record per call. Messages over **200 KB** are truncated. Not affected by sampling. | [Learn](https://learn.microsoft.com/azure/api-management/log-to-eventhub-policy) |

### 3. LLM logging to Log Analytics

- APIM → Diagnostic settings → **Logs related to generative AI gateway** → send to the fleet's workspace (resource-specific tables). Also enable the gateway logs (`ApiManagementGatewayLogs`).
- On each AI API: Settings → Diagnostic Logs → Azure Monitor → **Log LLM messages** = Enabled, with **Log prompts** and **Log completions** limits (for example 32768 bytes).
- Messages over 32 KB are split into chunks (correlate them by `CorrelationId` and order by `SequenceNumber`). Each request or response is capped at 2 MB. Token counts can be missing when a stream breaks ([Learn](https://learn.microsoft.com/azure/api-management/api-management-howto-llm-logs)).
- [`ApiManagementGatewayLlmLog`](https://learn.microsoft.com/azure/azure-monitor/reference/tables/apimanagementgatewayllmlog) columns: `TimeGenerated, CorrelationId, DeploymentName, ModelName, OperationName, ApiVersion, PromptTokens, CompletionTokens, TotalTokens, IsStreamCompletion, RequestId, RequestMessages (dynamic), ResponseMessages (dynamic), SequenceNumber, Region, _ResourceId`. The table has **no caller identity**. It comes from [`ApiManagementGatewayLogs`](https://learn.microsoft.com/azure/azure-monitor/reference/tables/apimanagementgatewaylogs) (`CallerIpAddress`, `ApimSubscriptionId`, `ApiId`, `ResponseCode`, `LastErrorSource`, `LastErrorReason`, `TraceRecords`), joined on `CorrelationId`.

### 4. Event Hub streaming

- Create an Event Hub (for example `agentmon-llm`, 2–4 partitions, 1-day retention) and an APIM **logger** that uses APIM's managed identity. The identity needs **Azure Event Hubs Data Sender** ([Learn](https://learn.microsoft.com/azure/api-management/api-management-howto-log-event-hubs)).
- Give the fleet identity **Azure Event Hubs Data Receiver** and a dedicated consumer group (`agentmon-fleet`).

---

## Fleet collector design (`collectors/apim.py`)

### Settings (proposed)

| Variable | Default | Purpose |
|---|---|---|
| `FLEET_APIM_MODE` | `off` | `off`, `law` (poll the tables) or `eventhub` (stream) |
| `FLEET_APIM_API_IDS` | `[]` | APIM API ids to include (empty means every API that has LLM log rows) |
| `FLEET_APIM_IDENTITY_OBJECT_IDS` | `[]` | APIM managed identity object ids. Registered as known callers (kind `gateway`). |
| `FLEET_APIM_EVENTHUB_NAMESPACE` / `FLEET_APIM_EVENTHUB_NAME` / `FLEET_APIM_EVENTHUB_CONSUMER_GROUP` | — / `agentmon-llm` / `agentmon-fleet` | Event Hub source |
| `FLEET_APIM_SESSION_HEADER` | `x-agentmon-session` | Header that callers set to group calls into sessions |

### LAW mode query

The query is driven by gateway logs, so blocked calls (403 content safety, 429 or 403 token limit) are included even when there is no LLM log row. Chunks are packed with their sequence number and reassembled in Python.

```kusto
let llm = ApiManagementGatewayLlmLog
| where TimeGenerated between (datetime({start}) - 5m .. datetime({end}) + 5m)
| summarize DeploymentName = take_any(DeploymentName), ModelName = take_any(ModelName),
    PromptTokens = max(PromptTokens), CompletionTokens = max(CompletionTokens), TotalTokens = max(TotalTokens),
    IsStream = take_any(IsStreamCompletion),
    Chunks = make_list(pack("seq", SequenceNumber, "req", RequestMessages, "resp", ResponseMessages), 200)
    by CorrelationId;
ApiManagementGatewayLogs
| where TimeGenerated between (datetime({start}) .. datetime({end}))
| where isnotempty(CorrelationId)
| project TimeGenerated, CorrelationId, ApiId, OperationId, ApimSubscriptionId, CallerIpAddress, ResponseCode,
    BackendResponseCode, LastErrorSource, LastErrorReason, TraceRecords, _ResourceId
| join kind=leftouter llm on CorrelationId
| where isnotempty(DeploymentName) or ResponseCode in (401, 403, 429)
| order by TimeGenerated asc
| take 20000
```

`oid`, `appid` and `session` come from the `TraceRecords` entry with `source == "agentmon"`. Before adding them to the collector, validate the `TraceRecords` shape and the `LastErrorSource` values against your own workspace.

### Event Hub mode

- Use `azure-eventhub`'s `EventHubConsumerClient` with `receive_batch` on each partition, bounded per cycle.
- Store per-partition offsets as fleet cursors (`apim.eh:<partition>`) rather than in a blob checkpoint store. That keeps the collector stateless apart from `fleet-state.db`, and deduplication by event id makes reprocessing safe.
- The hub uses the same `CanonicalEvent` mapping as LAW mode. Latency drops from minutes to seconds.

### Mapping to `CanonicalEvent`

| Event | From | Fields |
|---|---|---|
| `inference` | Every call | `platform` = `azure_openai` (or the agent's platform when `oid` or `appid` matches an Entra agent identity or a Foundry project identity), `source` = `law.apim` or `eventhub.apim`, `caller_object_id` = `oid`, `caller_ip`, `model` = `DeploymentName`, tokens, `status` = `ResponseCode`. `attributes`: `category="ApimLlm"`, `api`, `apim_subscription`, `app_id`, `correlation_id`. |
| `policy_decision` (`blocked`) | 403 from `llm-content-safety` | `decision_reason="content_filter: <LastErrorReason>"`, `text` = the last user message. It lands in the **user** denial ledger. |
| `inference` (`blocked`) | 401 or 403 from `validate-azure-ad-token` or the quota; 429 from TPM | `decision_reason` = `access denied (403)`, `access denied (401)` or `rate_limited` |
| `user_message` | Last `role=user` entry in the request messages | `session_id` = the session header, otherwise `apim:<oid>:<yyyy-mm-ddThh>` |
| `assistant_message` | Response messages | `attributes.system_instructions` = the request's system message (redacted) |
| `tool_call` (`pending`) | `tool_calls` in the response | Same as client-side `chat` spans in `law.genai` |

All events go through `redact_event()` before storage, as for every other collector.

### Detector and pipeline changes

1. **`InferenceNetworkSentinel.process`** accepts `inference` events whose `source` starts with `law.apim` or `eventhub.apim` (today it accepts only `law.inference` and `storage`). Baselines, `UNREGISTERED_INFERENCE_CALLER`, `ACCESS_DENIED_BURST` and `CONTENT_FILTER_TRIGGERED` then work **per real caller** instead of per API key.
2. **Double counting.** With backend managed identity, `AzureDiagnostics` attributes every call to APIM's identity. Register that identity with kind `gateway` and skip it in the `law.inference` baselines. APIM rows become the per-caller view, and `AzureDiagnostics` stays the view of any path that bypasses APIM. Once keys are disabled, a non-gateway caller in `AzureDiagnostics` is itself a finding.
3. **Charters for direct callers.** Synthesize an `AgentProfile` per `appid` (key `azure_openai:<appid>`) from the system prompt and tool definitions seen in requests. This reuses the `FoundryCollector.inline_profiles` approach, so the IntentAnalyst can judge scope and drift for apps that aren't registered agents. YAML charters can override them by `appid`.
4. **Intent and evasion.** User and assistant messages from APIM feed the IntentAnalyst (`JAILBREAK_ATTEMPT`, `INTENT_OUT_OF_SCOPE`, `GOAL_DRIFT`). Content-safety blocks with the prompt text enable `USER_PERSISTENCE_AFTER_BLOCK` for direct callers.
5. **Build wiring.** `build_collectors()` adds `ApimCollector` when `FLEET_APIM_MODE != off`. The `collect --source` and `run --source` choices gain `apim`.
6. **Tests.** Add fixture rows for a chunked 70 KB prompt, a content-safety 403, a 429, and a `TraceRecords` caller, and assert the mapping and the sentinel alerts.

### Roles

| Principal | Role | Scope |
|---|---|---|
| Fleet identity | Log Analytics Reader (already granted) | Workspace |
| Fleet identity | Azure Event Hubs Data Receiver | Event Hub |
| APIM managed identity | Cognitive Services OpenAI User (or Foundry User) | Foundry accounts |
| APIM managed identity | Cognitive Services User | Content Safety resource |
| APIM managed identity | Azure Event Hubs Data Sender | Event Hub |

### Rollout

1. Deploy APIM, import the API, and set up managed identity to the backend. Run policies in **observe** posture: logging, trace and metrics on; token limits set high; content safety on (it already blocks at the platform level).
2. Enable the collector in `law` mode, and compare its per-caller inventory with `agentmon-fleet stats`.
3. Switch to `eventhub` mode for low latency.
4. Move callers to APIM, and route Foundry agents through BYOM connections.
5. Disable keys on the Foundry accounts, and tighten the token limits.
6. Add a Terraform module (`modules/apim_ai_gateway`, behind an `enable_apim_gateway` variable) and the fleet `fleet_apim_*` variables, following the `modules/fleet` pattern.

### Limits

- APIM only sees traffic that is routed through it. An agent's internal model calls show up only with a BYOM connection, or through server-side traces.
- Stream interruptions can leave token counts missing or inaccurate.
- Large messages are chunked (32 KB) or truncated (2 MB for LLM logs, 200 KB for `log-to-eventhub`).
- Content logged by APIM is sensitive. Protect the workspace and the hub the same way as `AppGenAIContent`.
