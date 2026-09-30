# AgentMon Fleet — real-time hooks

`agentmon-fleet hooks` serves a FastAPI app ([hooks/server.py](../fleet/src/agentmon_fleet/hooks/server.py)) that checks **pending tool calls** before they run. It uses the same charters, state database and detectors as the batch pipeline ([fleet.md](fleet.md)).

| Endpoint | Caller | Purpose |
|---|---|---|
| `GET /health` | Probes | `{"ok": true, "mode": "<FLEET_HOOKS_MODE>", "llm": <bool>}` (no auth) |
| `POST /copilot-studio/validate` | Copilot Studio | Threat-detection handshake |
| `POST /copilot-studio/analyze-tool-execution` | Copilot Studio | Pre-tool gate, api-version `2025-05-01` |
| `POST /evaluate` | Agent Framework middleware, Foundry MCP approval controller, the scenario runner, custom agents | Generic pre-tool gate |
| `POST /events` | SDK middleware, custom agents | Push `CanonicalEvent[]` (user turns, tool results) for the batch detectors |

Every response carries an `x-agentmon-ms` timing header.

```powershell
cd fleet; .\.venv\Scripts\Activate.ps1
agentmon-fleet hooks --host 127.0.0.1 --port 8787      # in Container Apps: --host 0.0.0.0 (see fleet/Dockerfile)
```

---

## How a verdict is made

`RealtimeEvaluator.evaluate()` in [hooks/realtime.py](../fleet/src/agentmon_fleet/hooks/realtime.py):

1. **Resolve the charter.** It looks up the agent key first, then falls back to a case-insensitive name match on the same platform.
2. **Redact and store context.** User turns and earlier tool outputs from the request are redacted, stored (deduplicated by id) and run through IntentAnalyst, ActionAnalyst and EvasionMonitor **with no LLM**. That updates the intent ledger, injection taint and denial ledger before the pending call is judged.
3. **Score the pending call** with the same three detectors. The score is the highest alert score.
4. **Fast triage (optional).** If the score is between 35 and 90 and more than 350 ms of the `FLEET_HOOKS_DEADLINE_MS` budget (default 850 ms) remains, the fast model (`FLEET_FAST_MODEL_DEPLOYMENT`, gpt-4.1-mini) rates the risk from 0 to 100. Its timeout is `min(time left − 100 ms, FLEET_FAST_LLM_TIMEOUT_S)` (default 0.6 s). A higher triage score replaces the deterministic score; otherwise the two are averaged.
5. **Decide.**
   - `enforce` = the charter's `enforce` when a YAML charter sets it (`true` or `false`). Otherwise, including agents with no charter or an LLM-derived charter only, it is `FLEET_HOOKS_MODE == "enforce"`.
   - `block` = `enforce and score >= threshold`. The threshold is the charter's `block_threshold`, otherwise `FLEET_HOOKS_BLOCK_THRESHOLD` (70).
6. **Record.**
   - The pending call is stored with `decision = blocked` (or `pending`).
   - A block is written to the denial ledger **immediately**, so the agent's next attempt is compared with it.
   - New alerts get `action = "block"` or `"alert"` and are delivered to the sinks on a background thread.

**Observe vs enforce.** Observe is the default: the call is allowed and alerts are raised as usual. Turn on enforce per agent in its charter (`enforce: true`, optionally `block_threshold: 80`) once the observe-mode alert rate looks right. See [fleet.md → Charters](fleet.md#charters).

**Fail-open.** If anything in `/copilot-studio/analyze-tool-execution` raises an exception, the fleet returns `{"blockAction": false, "diagnostics": "agentmon error <Type> corr=<id>"}`. It never returns an HTTP error to Copilot Studio. On timeouts and non-2xx responses, the environment's **Set error behavior** applies (default: allow). `FleetClient` fails open by default too (`fail_open=True`). Pass `fail_open=False` to block when the monitor can't be reached.

**Reason codes** (`reasonCode` / `reason_code`) come from the highest-scoring alert:

| Code | Alert | Code | Alert |
|---|---|---|---|
| 101 | `DATA_EXFILTRATION` | 107 | `OUT_OF_BOUNDS_SCRIPT` |
| 102 | `CREDENTIAL_ACCESS` | 108 | `OBFUSCATED_CODE` |
| 103 | `BLOCKED_ACTION_WORKAROUND` | 109 | `DESTRUCTIVE_ACTION` |
| 104 | `PROMPT_INJECTION_SUSPECTED` | 110 | `UNAPPROVED_DESTINATION` |
| 105 | `GOAL_DRIFT` | 111 | `OUT_OF_CHARTER_ACTION` |
| 106 | `FORBIDDEN_CAPABILITY` | 199 | Any other alert, or none |

---

## Authentication

[hooks/auth.py](../fleet/src/agentmon_fleet/hooks/auth.py) applies to every endpoint except `/health`:

| Check | Behaviour |
|---|---|
| No bearer token | `401`, unless `FLEET_HOOKS_ALLOW_ANONYMOUS=true` (isolated dev only) |
| Token equals `FLEET_HOOKS_TOKEN` | Accepted (constant-time compare). This is the shared secret for local and dev use. |
| Otherwise, Entra JWT | Needs `FLEET_AZURE_TENANT_ID` and `FLEET_HOOKS_AUDIENCE`, or returns `401`. RS256 is verified against `https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys`. `exp`, `iat`, `aud` and `iss` are required, with 60 s leeway. |
| Issuer | `https://login.microsoftonline.com/{tenant}/v2.0` or `https://sts.windows.net/{tenant}/` (single tenant) |
| Audience | Must be one of `FLEET_HOOKS_AUDIENCE`. List every form you expect: the endpoint base URL, the app id URI and the app id GUID. |
| Caller | `azp` (v2) or `appid` (v1) must be in `FLEET_HOOKS_ALLOWED_APP_IDS` when that list is set. Otherwise the response is `403`. |

Rejected tokens are logged at INFO as `hook token rejected: <reason>`. That line shows audience or issuer mismatches.

---

## Copilot Studio: external threat detection

Copilot Studio calls the webhook **every time the orchestrator is about to invoke a tool**. This happens only for agents that use **generative orchestration** ([Learn: external security provider](https://learn.microsoft.com/microsoft-copilot-studio/external-security-provider), [Learn: developer interface](https://learn.microsoft.com/microsoft-copilot-studio/external-security-webhooks-interface-developers)).

### 1. Expose the hooks endpoint

The **base URL** is the hooks host followed by `/copilot-studio`. Copilot Studio appends `/validate` and `/analyze-tool-execution`.

| Where | Base URL |
|---|---|
| Azure (Terraform `enable_fleet`) | `$(terraform -chdir=infra/terraform output -raw fleet_hooks_url)/copilot-studio` |
| Local (dev tunnel) | `https://<tunnel-id>-8787.<region>.devtunnels.ms/copilot-studio` |

A local dev tunnel needs a **persistent** tunnel, because the federated credential encodes the exact URL:

```powershell
devtunnel user login
devtunnel create agentmon-hooks --allow-anonymous      # tunnel-level anonymous; the fleet still validates the JWT
devtunnel port create agentmon-hooks -p 8787
agentmon-fleet hooks --port 8787                       # in another terminal
devtunnel host agentmon-hooks                          # prints the https URL
```

### 2. Create the Entra app with a federated identity credential

Copilot Studio authenticates with a **single-tenant app registration** that has a **federated identity credential** (FIC). There's no secret.

**Option A (recommended):** run the repo's idempotent [infra/lab/create-webhook-app.ps1](../infra/lab/create-webhook-app.ps1). It mirrors Microsoft's script (single-tenant app, service principal, FIC) through `az rest` on Graph, prints the App ID, and adds a new FIC if the endpoint changes. The full Copilot Studio lab walkthrough is in [infra/lab/COPILOT-STUDIO-SETUP.md](../infra/lab/COPILOT-STUDIO-SETUP.md).

```powershell
./infra/lab/create-webhook-app.ps1 -Endpoint "https://<tunnel>.devtunnels.ms/copilot-studio" -TenantId "<tenant-guid>" [-WhatIf]
```

Microsoft's [Create-CopilotWebhookApp.ps1](https://www.powershellgallery.com/packages/Create-CopilotWebhookApp/1.0.1) from the PowerShell Gallery does the same thing:

```powershell
.\Create-CopilotWebhookApp.ps1 -TenantId "<tenant-guid>" -Endpoint "<base-url>" `
  -DisplayName "AgentMon Fleet threat detection" -FICName "agentmon-fleet"
```

**Option B (manual):** go to App registrations → New registration (single tenant) → Certificates & secrets → Federated credentials → Add credential → **Other issuer**, and fill in:

- **Issuer:** `https://login.microsoftonline.com/<tenant-guid>/v2.0`
- **Type:** Explicit subject identifier
- **Value:** `/eid1/c/pub/t/<b64url(tenant GUID bytes)>/a/m1WPnYRZpEaQKq1Cceg--g/<b64url(base URL)>`

```powershell
$tenantId = [Guid]::Parse("<tenant-guid>")
[Convert]::ToBase64String($tenantId.ToByteArray()).Replace('+','-').Replace('/','_').TrimEnd('=')
$endpointURL = "<base-url>"
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($endpointURL)).Replace('+','-').Replace('/','_').TrimEnd('=')
```

### 3. Configure the fleet

```dotenv
FLEET_AZURE_TENANT_ID=<tenant-guid>
FLEET_HOOKS_AUDIENCE=["<base-url>","<hooks-host-origin>","<app-id-guid>"]
FLEET_HOOKS_ALLOWED_APP_IDS=["<app-id-guid-from-step-2>"]
FLEET_HOOKS_MODE=observe
```

In Terraform, set `fleet_hooks_audience`, `fleet_hooks_allowed_app_ids` and `fleet_hooks_mode`. The plan fails when hooks are enabled and the audience is empty, because every webhook call would be rejected; set `fleet_sizing.hooks_enabled = false` to deploy without hooks.

### 4. Connect in the Power Platform admin center

1. As a **Power Platform Administrator**, go to PPAC → **Security** → **Threat detection** → **Additional threat detection**.
2. Select the environment (or environment group), then **Set up**.
3. Enter the **App ID** from step 2 and the **endpoint link** (the base URL).
4. Choose **Set error behavior**: *Allow the agent to respond* (default, fail-open) or *Block the query*.

This is per environment. There's no API and no tenant-wide default, so enable new environments by hand. Copilot Studio calls `/validate` during setup.

### 5. Verify

```powershell
curl.exe -s "<hooks-host>/health"
# Local, with the shared token:
curl.exe -s -X POST "http://127.0.0.1:8787/copilot-studio/validate?api-version=2025-05-01" -H "Authorization: Bearer $env:FLEET_HOOKS_TOKEN"
# {"isSuccessful":true,"status":"OK"}
```

Then chat with a generative agent in that environment. For each tool call the hooks log shows `cs gate <agent> tool=<tool> score=<n> block=<bool> <ms>ms`. Alerts show up on the dashboard **Fleet** page.

### Request and response contract

The request is `POST {base}/analyze-tool-execution?api-version=2025-05-01` with headers `Authorization: Bearer`, `x-ms-correlation-id`. [hooks/copilot_studio.py](../fleet/src/agentmon_fleet/hooks/copilot_studio.py) maps it as follows, and ignores unknown fields and newer api-versions:

| Request field | Fleet event |
|---|---|
| `plannerContext.chatHistory[role=user]`, `plannerContext.userMessage` | `user_message` context events (these drive intent) |
| `plannerContext.previousToolOutputs[]` (the schema table spells it `previousToolsOutputs`; both are accepted) | `tool_result` context events, checked for indirect injection. Each `ToolExecutionOutput` maps as `toolName` → `tool_name`, `toolId` → `tool_call_id`, `outputs[].{name,value}` → `result`, `timestamp` → `occurred_at` |
| `plannerContext.thought` | `thought` on the pending call (reasoning that mentions evasion is a signal) |
| `toolDefinition.{id,name,type,description}` | `tool_name`, `tool_type`, `attributes.tool_description` |
| `inputValues` | `arguments` (turned into effects, code analysis, destinations) |
| `conversationMetadata.conversationId` | `session_id` |
| `conversationMetadata.agent.{id,name,environmentId,version,tenantId,isPublished}` | Agent identity, `resource_id` = environment |
| `conversationMetadata.user.id` | `user_id` |
| `planId` + `planStepId` | `tool_call_id`. Used so the same call later seen in the transcript isn't counted as a retry. |

Responses:

```json
{"blockAction": false, "diagnostics": "agentmon score=12.0 mode=observe latency_ms=41 corr=<x-ms-correlation-id>"}
```

```json
{"blockAction": true, "reasonCode": 101, "reason": "Blocked by the organization's AI agent monitoring policy.",
 "diagnostics": "agentmon score=86.0 mode=enforce latency_ms=212 corr=<x-ms-correlation-id>"}
```

**Latency budget:** Copilot Studio allows **1,000 ms** end to end. The fleet reserves 850 ms (`FLEET_HOOKS_DEADLINE_MS`) for itself. Deterministic detectors take milliseconds, and the fast model runs only if enough time is left. The fleet never calls gpt-5.5 on this path. Run the hooks app close to the tenant region, keep 1 replica (session context is per replica), and set min replicas ≥ 1 to avoid cold starts.

**Microsoft Defender as the provider.** Defender can fill this same slot natively (Defender → Settings → Security for AI → Real-time protection; audit and block events land in `BehaviorInfo`, [Learn](https://learn.microsoft.com/defender-cloud-apps/real-time-agent-protection-during-runtime)). An environment has **one** provider. If Defender holds the slot, the fleet still sees its outcomes through `FLEET_TENANT_DEFENDER`.

---

## Generic gate: `POST /evaluate`

```json
{
  "platform": "foundry",
  "agent_name": "agentmon-it-helpdesk",
  "agent_id": null,
  "session_id": "conv_123",
  "user_id": "alex@contoso.com",
  "tool_name": "it.run_command",
  "tool_type": "mcp",
  "tool_call_id": "mcpr_1",
  "arguments": {"command": "net user administrator ..."},
  "thought": null,
  "user_message": "Reset my VPN profile",
  "tool_outputs": [{"tool_name": "get_ticket", "output": "..."}]
}
```

Response:

```json
{"block": true, "score": 88.0, "reason": "...", "reason_code": 106, "mode": "enforce", "latency_ms": 37,
 "alerts": [{"type": "FORBIDDEN_CAPABILITY", "severity": "high", "summary": "..."}]}
```

`POST /events` accepts a JSON array of `CanonicalEvent` objects (see [models.py](../fleet/src/agentmon_fleet/models.py)). They are redacted and stored, and the next batch cycle analyses them. The response is `{"accepted": n, "duplicates": m}`.

---

## Foundry: MCP `require_approval` controller

Foundry MCP tools with `require_approval` (`always` by default, `never`, or `{"never": [...]}`) return an `mcp_approval_request` output item. The caller must answer it with an `mcp_approval_response` on `previous_response_id` ([Learn: MCP tool](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/model-context-protocol)). The SDK helper `mcp_approval_responses` puts the fleet in that approver seat. It approves unless the fleet blocks (enforce mode); observe mode approves and still raises alerts.

```python
from agent_governance.integrations.fleet import FleetClient, mcp_approval_responses

fleet = FleetClient("https://<hooks-host>", token_provider=get_hooks_token)   # sync or async callable returning a JWT

replies = await mcp_approval_responses(fleet, response, agent_name="agentmon-it-helpdesk",
                                       session_id=conversation_id, user_message=user_text)
if replies:  # [{"type": "mcp_approval_response", "approval_request_id": ..., "approve": bool, "reason"?: ...}]
    response = await openai_client.responses.create(
        input=replies, previous_response_id=response.id,
        extra_body={"agent_reference": {"type": "agent_reference", "name": "agentmon-it-helpdesk"}})
```

Denied approvals show up in the Responses items. The Foundry collector turns them into `blocked` tool calls (reason `approval denied`), which feed the EvasionMonitor. Toolboxes used by hosted agents don't enforce `require_approval` at the MCP endpoint, so the runtime has to enforce it.

## Agent Framework middleware

`create_fleet_middleware` ([packages/sdk-python/…/integrations/fleet.py](../packages/sdk-python/src/agent_governance/integrations/fleet.py)) returns `[agent_middleware, function_middleware]`:

- The **agent middleware** pushes each user turn and final reply to `/events`.
- The **function middleware** calls `/evaluate` before every function call, sending the latest user turn and up to 5 recent tool outputs. On `block`, it sets `context.result` to an error object and skips the call. After the call, it pushes the tool result to `/events`, so indirect injection taints the session.

Install:

```powershell
pip install -e "packages/sdk-python[agent-framework]"
```

```python
from agent_framework import Agent
from agent_governance.integrations.fleet import FleetClient, create_fleet_middleware

fleet = FleetClient("https://<hooks-host>", token_provider=get_hooks_token, timeout_s=1.5, fail_open=True)

agent = Agent(
    client=chat_client,
    name="agentmon-data-analyst",
    instructions="Analyse CSV data the user uploads.",
    tools=[run_python],
    middleware=create_fleet_middleware(fleet, agent_name="agentmon-data-analyst"),
)
```

Optional arguments:

- `session_id=lambda ctx: ...` overrides session detection (the default is `ctx.session.session_id`, then `"default"`).
- `blocked_result=lambda verdict: ...` customises what the model sees when a call is blocked.

For local tests, use `FleetClient(..., token="<FLEET_HOOKS_TOKEN>")`. `agent_name` must match the charter name, so it picks up the right `enforce` and `block_threshold`.

---

## Complementary controls

The fleet's gate focuses on intent, charter and evasion. Layer it with the platform controls:

| Control | What it does | Relation to the fleet |
|---|---|---|
| **Foundry guardrails** ([Learn](https://learn.microsoft.com/azure/foundry/guardrails/guardrails-overview)) | Content risks, Prompt Shields (user and indirect attacks), PII and protected material, at the user input, **tool call** (preview), **tool response** (preview) and output stages. An agent guardrail fully overrides the deployment guardrail. | Blocks appear as `content_filter` / `jailbreak` response errors and `AzureDiagnostics` 400s. The fleet records them as user or agent denials and watches for workarounds. |
| **Foundry Task Adherence** (preview, [Learn](https://learn.microsoft.com/azure/foundry/guardrails/task-adherence)) | `POST {content-safety-endpoint}/contentsafety/agent:analyzeTaskAdherence?api-version=2024-12-15-preview` with `tools[]` and `messages[]`. Returns `taskRiskDetected` and `details` for misaligned tool invocations. | A cheap second opinion next to the fleet's goal-drift check. Call it from the same middleware if you want both verdicts. The fleet doesn't call it today. |
| **Copilot Studio DLP** ([Learn](https://learn.microsoft.com/microsoft-copilot-studio/admin-data-loss-prevention)) | Connector and HTTP endpoint policies | DLP blocks appear in transcripts as blocked plan steps and become denials. |
| **Defender real-time protection** | Microsoft's own provider for the Copilot Studio webhook slot | See above; its outcomes land in `BehaviorInfo`. |
