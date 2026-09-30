# AgentMon Fleet

AgentMon Fleet (`fleet/`, package `agentmon-fleet`) is a Python monitoring service for AI agents that run in **Microsoft Foundry** and **Copilot Studio**, and for apps that call models directly. It reads the logs and APIs those platforms already produce and turns them into one event model. Detectors then compare what each agent actually did with its **charter** (purpose, use cases, allowed and forbidden capabilities). The results are alerts and incidents, mapped to OWASP LLM Top 10, OWASP Agentic Top 10 (ASI) and MITRE ATLAS.

> **Response policy.** The fleet only raises alerts and proposes recommendations. It never contains anything itself. The Incident Commander and the Fleet Commander can only *propose* containment (the `propose_containment` tool, or incident `recommendations` with `status: "proposed"`). A person reviews and actions them in the governance dashboard (incidents and approvals; approving needs the `Approver` role). The only inline control is the optional real-time gate: in `enforce` mode it can block a *pending* tool call, and only for agents whose charter opts in ([fleet-realtime-hooks.md](fleet-realtime-hooks.md)).

Related docs:

| Doc | What it covers |
|---|---|
| [fleet-sources.md](fleet-sources.md) | Each telemetry source: what it provides, latency, the KQL or API used, required roles, and known gaps |
| [fleet-realtime-hooks.md](fleet-realtime-hooks.md) | Copilot Studio threat-detection webhook, `/evaluate`, the Foundry MCP approval controller, Agent Framework middleware |
| [apim-ai-gateway.md](apim-ai-gateway.md) | Future phase: APIM AI gateway in front of Foundry and Azure OpenAI, plus a collector for it |
| [jev.md](jev.md) | TypeSafe Jev in shadow mode (benchmarking only) |
| [infra/README.md](../infra/README.md#monitoring-fleet-optional) | Deploying to Azure Container Apps (Terraform `enable_fleet`) |
| [infra/sentinel/README.md](../infra/sentinel/README.md) | Analytics rules and a workbook over `AgentMonAlerts_CL` |

---

## Architecture

```text
 SOURCES                              COLLECTORS (collectors/)             ONE CYCLE (pipeline.py, every FLEET_POLL_INTERVAL_S)
 ───────                              ────────────────────────
 Log Analytics workspace ───────────► law        (6 KQL queries)  ─┐
   AzureDiagnostics, AppDependencies                                │
   + AppGenAIContent, AppEvents,                                    │
   AzureActivity, NTANetAnalytics,                                  │     ┌────────────────┐
   SecurityAlert                                                    ├───► │ CanonicalEvent │ (models.py, OTel gen_ai.*-like)
 Foundry data plane (per project) ──► foundry    (agents, responses,│     └───────┬────────┘
   discovered via ARM                             classic threads) ─┤             ▼
 Dataverse (Copilot Studio) ────────► dataverse  (bots, transcripts)┤     redact (redact.py: secrets + PII)
 Diagnostics storage archive ───────► storage    (fallback)        ─┤             ▼
 Tenant (opt-in flags) ─────────────► purview / entra / defender   ─┘     state (state.py, SQLite: dedup, cursors,
                                                                          profiles, sessions, denials, baselines)
                                                                                  ▼
 Agent definitions ─────────────────► Profiler ──► charters (+ fleet/charters/*.yaml overrides)
                                                                                  ▼
                                      DETECTORS (per event): IntentAnalyst · ActionAnalyst · EvasionMonitor ·
                                      InferenceNetworkSentinel · ControlPlaneAuditor · RunawayLoopDetector
                                                                                  ▼
                                      Correlator / Incident Commander (per session: fuse, escalate, narrate)
                                                                                  ▼
 SINKS (sinks/base.py) ◄──────────────────────────────────────────────────── deliver
   fleet-alerts.jsonl · Log Analytics AgentMonAlerts_CL (DCE/DCR) · dashboard /api/gov/fleet/alerts +
   /api/gov/incidents (→ Teams/email/webhook via the TS alert module) · console

 REAL-TIME PATH (hooks/, `agentmon-fleet hooks`, port 8787)
   Copilot Studio ─► POST /copilot-studio/analyze-tool-execution ─┐
   Agent Framework middleware / MCP approval ─► POST /evaluate ───┼─► RealtimeEvaluator: redact → same state DB →
   Custom agents ─► POST /events (post-tool telemetry) ───────────┘   Intent + Action + Evasion (deterministic)
                                                                      → fast-model triage if time remains
                                                                      → allow / block (observe | enforce per charter)
                                                                      → alerts delivered to the same sinks
```

The worker (`agentmon-fleet run`) and the hooks server (`agentmon-fleet hooks`) share the SQLite state file. Denials, session ledgers and profiles recorded by one are visible to the other. That is how a real-time block and a later transcript-based retry end up in the same evasion check.

### The cycle

`Fleet.run_cycle()` in [pipeline.py](../fleet/src/agentmon_fleet/pipeline.py):

| Stage | What happens |
|---|---|
| collect | All enabled collectors run in parallel threads. Each keeps a per-source cursor and re-reads an overlap window (`FLEET_OVERLAP_MINUTES`, default 45) because many sources land late. On first run a collector reads back `FLEET_LOOKBACK_MINUTES` (default 24 h). |
| redact | `redact_event()` masks secrets and PII in every content field before anything is stored or sent to a model. |
| store | `State.add_events()` inserts events by id. Duplicates from the overlap window are dropped, and only new events continue. Set `FLEET_EVENTS_JSONL` to mirror them to a file. |
| profile | The Profiler refreshes charters for the agent definitions collected this cycle. A changed definition hash raises `AGENT_CONFIG_CHANGE`. |
| detect | Every unprocessed event goes through each detector. Alerts below `FLEET_MIN_ALERT_SEVERITY` are dropped. Alerts are deduplicated by fingerprint within 30 minutes. |
| correlate | Fresh alerts are grouped per session (or per agent per day), fused, escalated and turned into incidents. |
| deliver | Undelivered alerts and unsynced incidents go to every sink. A failed LAW or JSONL write is retried next cycle; dashboard failures are best-effort. |
| prune | Events older than 14 days are removed from state. |

### Data model

`CanonicalEvent` (in [models.py](../fleet/src/agentmon_fleet/models.py)) loosely follows the OpenTelemetry GenAI conventions:

| Field group | Fields |
|---|---|
| Identity | `platform` (`foundry`, `copilot_studio`, `azure_openai`, `network`, `azure_control_plane`, `custom`), `source` (for example `law.genai`, `dataverse.transcripts`, `hook.copilot_studio`), `agent_id`, `agent_name`, `session_id`, `user_id`, `caller_object_id`, `caller_ip` |
| What happened | `kind`: `user_message`, `assistant_message`, `plan`, `tool_call`, `tool_result`, `inference`, `network_flow`, `control_plane`, `policy_decision`, `error`, `session_start`, `session_end` |
| Content | `text`, `thought`, `tool_name`, `tool_type`, `tool_call_id`, `arguments`, `result`, `model`, `tokens_in`, `tokens_out` |
| Outcome | `decision` (`allowed`, `blocked`, `failed`, `pending`), `decision_reason`, `status`, `error` |
| Network | `src_ip`, `dest_ip`, `dest_port`, `dest_host`, `bytes_out` |
| Effects | `effects[]`: `{capability, resource, destination, data_class, executor, evidence}`. These are derived by `normalize/effects.py` from tool semantics, argument inspection and code analysis (`codeanalysis/`: extraction, recursive deobfuscation, Python AST and multi-language rules). |

`blocked` means a control denied the action: a policy, guardrail, content filter, DLP, approver or the fleet's own gate. `failed` means the tool errored for some other reason.

### State

SQLite (WAL) at `FLEET_STATE_DB` holds these tables: `cursors`, `events`, `profiles`, `sessions` (intent ledgers), `denials` (the denial ledger used by the EvasionMonitor), `alerts` (fingerprint dedup and delivery flag), `incidents`, `identities` (known agent, project and fleet principals) and `baselines` (token baselines, burst windows, loop counters, the inference inventory).

---

## Detectors and the alerts they raise

Each detector gets one event plus a `Context` (settings, state, charters, and the LLM with the per-cycle budget). `make_alert()` sets severity from the score: ≥85 critical, ≥65 high, ≥40 medium, ≥15 low, otherwise informational. If the alert type's default severity is higher and the score is ≥50, the default is used instead.

| Detector (`name`) | Input | Alerts |
|---|---|---|
| IntentAnalyst (`intent_analyst`) | User turns, tool outputs, risky tool calls and assistant messages | `JAILBREAK_ATTEMPT`, `INTENT_OUT_OF_SCOPE`, `PROMPT_INJECTION_SUSPECTED`, `GOAL_DRIFT` |
| Action & Script Analyst (`action_analyst`) | Tool calls and assistant messages, turned into effects and code analysis | `FORBIDDEN_CAPABILITY`, `CREDENTIAL_ACCESS`, `DATA_EXFILTRATION`, `DESTRUCTIVE_ACTION`, `OUT_OF_CHARTER_ACTION`, `UNAPPROVED_DESTINATION`, `OBFUSCATED_CODE`, `OUT_OF_BOUNDS_SCRIPT` |
| EvasionMonitor (`evasion_monitor`) | Blocked or refused events, and later actions and user turns | `BLOCKED_ACTION_WORKAROUND`, `SOCIAL_ENGINEERING_USER`, `REPEATED_BLOCKED_ATTEMPTS`, `USER_PERSISTENCE_AFTER_BLOCK` |
| Inference & Network Sentinel (`inference_network_sentinel`) | `law.inference` and `storage` inference rows, network flows, Defender alerts | `INFERENCE_ANOMALY`, `UNREGISTERED_INFERENCE_CALLER`, `ACCESS_DENIED_BURST`, `CONTENT_FILTER_TRIGGERED`, `SUSPICIOUS_NETWORK_FLOW`, `DATA_EXFILTRATION`, plus Defender passthrough (detector `defender_for_ai`) |
| Control-plane Auditor (`control_plane_auditor`) | `control_plane` events and charter definition changes | `TELEMETRY_TAMPERING`, `SENSITIVE_CONTROL_PLANE_OP`, `AGENT_CONFIG_CHANGE`, `CREDENTIAL_ACCESS` (key enumeration) |
| RunawayLoopDetector (`runaway_loop`) | Tool calls per session | `RUNAWAY_LOOP` |
| UserPayloadDetector (`user_payload`) | User turns carrying encoded/obfuscated code, then the agent's tool calls | `OBFUSCATED_CODE` (user-supplied, and again when the agent executes the decoded payload) |
| Correlator / Incident Commander (`incident_commander`) | New alerts, grouped by session | `SESSION_RISK_ESCALATION`, plus incidents |

### IntentAnalyst — `detectors/intent.py`

It keeps a per-session **intent ledger** with these fields: goal, matched use case, scope, confidence, expected capabilities, the last 5 user turns, the last 12 trajectory steps, and taint.

- **Only user turns define intent.** On a substantive user turn, gpt-5.5 classifies the goal against the charter's use cases. It raises `INTENT_OUT_OF_SCOPE` when the scope is `out_of_scope` with confidence ≥ 0.6.
- `JAILBREAK_ATTEMPT` comes from regexes for direct jailbreaks and instruction overrides in user text (DAN, "without restrictions", role-play framings and similar).
- **Indirect prompt injection:** if tool output matches the injection patterns, it raises `PROMPT_INJECTION_SUSPECTED` (score 70) and **taints** the session for the next 8 tool calls. Tool output is also checked against indirect-only tells that would be normal in a user's own prompt: "note to AI assistants", "new task:", "do not mention this to the user", "without telling the user". Tool outputs are emitted as their own `tool_result` events. The Foundry Responses API returns a call and its output in different responses, so an output that arrives in a later cycle is still analysed.
- **Goal drift:** a risky action (egress, send, exfil, write/delete, exec, credentials, admin and similar) produces signals: `action_after_injection` (tainted session) and `capability_not_expected_for_goal`. An LLM alignment check then weighs them. The detector raises `GOAL_DRIFT` when the resulting score is ≥ 40.

### Action & Script Analyst — `detectors/action.py`

- Each effect is checked against the charter:
  - A forbidden capability raises `FORBIDDEN_CAPABILITY` (70, or 80 if the call was executed). It also raises `CREDENTIAL_ACCESS`, `DATA_EXFILTRATION` or `DESTRUCTIVE_ACTION` for `cred_access`, `exfil` or `destructive`.
  - A capability outside the allowed set raises `OUT_OF_CHARTER_ACTION`.
  - Egress, send or exfil to a host that isn't on `allowed_destinations` raises `UNAPPROVED_DESTINATION`.
- Without a charter, the high-risk set is forbidden: `cred_access`, `persistence`, `priv_esc`, `defense_evasion`, `destructive`, `exfil`, `download_exec`, `identity_admin`.
- Agent-generated code is extracted from arguments and messages, deobfuscated recursively (base64, PowerShell `-EncodedCommand`, gzip, hex, char codes, rot13 and others), then scored.
  - `OBFUSCATED_CODE` fires on any obfuscation.
  - `OUT_OF_BOUNDS_SCRIPT` fires when the risk is ≥ 40. For risks from 40 to 85, a gpt-5.5 code judge first checks whether the script was necessary for the task.

### EvasionMonitor — `detectors/evasion.py`

It keeps a **denial ledger** (`state.denials`) with two actors:

| Actor | Recorded when | Sources |
|---|---|---|
| `agent` | A tool call, tool result, policy decision or error has `decision = blocked` | Foundry Responses tool output that matches block patterns, **MCP approval denied** (`mcp_approval_response.approve = false`), Foundry classic run steps, Copilot Studio transcript plan steps (`DynamicPlanStepFinished`), GenAI `execute_tool` spans, **fleet real-time gate blocks** (enforce mode), Entra agent sign-in failures, Defender for AI `*BlockedAttempt` alerts (`law.defender`) |
| `user` | The user's request was refused or filtered | Content filter or jailbreak blocks on a Foundry response (`content_filter`, `jailbreak`, `responsible_ai`), Purview `CopilotInteraction` messages with `JailbreakDetected`, guardrail-blocked assistant messages, and **model refusals** ("I can't help with…", detected at the start of the reply) |

A `policy_decision` whose reason matches content filter, jailbreak, Prompt Shield, Responsible AI, harmful or refusal, and that has no tool name, counts against the user rather than the agent.

**Agent-side workaround** (a later tool call or assistant message in the same session, or by the same agent for the same user within 24 h): signals are combined with a noisy-OR.

| Signal | Weight |
|---|---|
| `exact_retry` | 0.60 |
| `alternate_route` (same effect key, different executor) | 0.85 |
| `same_target_new_route` | 0.75 |
| `same_capability_new_route` | 0.50 |
| `same_outcome_family` (for example a blocked e-mail re-sent with `smtplib`) | 0.40 |
| `obfuscation_after_denial` | 0.80 |
| `asks_user_to_act` ("run this yourself") | 0.55 |
| `reasoning_mentions_evasion` | 0.70 |
| `semantic_similarity` (embeddings ≥ 0.83) | 0.4 and up |

Probabilities from 0.35 to 0.9 go to a gpt-5.5 same-effect adjudicator. The monitor alerts at ≥ 0.35: `SOCIAL_ENGINEERING_USER` if the only signal is `asks_user_to_act`, otherwise `BLOCKED_ACTION_WORKAROUND`. It adds `REPEATED_BLOCKED_ATTEMPTS` once there are ≥ 3 denials. The same tool call seen from two sources (for example the hook and the transcript, matched by `tool_call_id`) doesn't count as a retry, and a call plus its blocked result count as one denial. A refusal that hands the blocked action to the user ("I can't run that, but you can do it yourself in the admin center") is recorded as a refusal and still evaluated as `asks_user_to_act`.

**User-side persistence** (a later user turn after a refusal or block) uses these signals: `repeated_request` (word Jaccard ≥ 0.45), `rephrased_request` (embeddings ≥ 0.82), `jailbreak_framing` and `encoded_request`. Probabilities from 0.35 to 0.85 go to a user adjudicator. The monitor raises `USER_PERSISTENCE_AFTER_BLOCK` at ≥ 0.4.

### Inference & Network Sentinel — `detectors/inference.py`

- **Hourly token baseline** per caller and resource (EWMA). It raises `INFERENCE_ANOMALY` when an hour exceeds `max(FLEET_INFERENCE_HOURLY_TOKEN_ALERT, mean + 4σ)`; the σ term applies after 6 hours of history.
- `UNREGISTERED_INFERENCE_CALLER` fires once per caller and resource when an Entra object id calls a model and is none of these: a Foundry account or project identity, an agent identity (Entra Agent ID or Defender `AgentsInfo`), the fleet itself, or on `FLEET_KNOWN_CALLERS`. Key-based calls carry no identity, so they are covered by the ListKeys audit instead.
- `ACCESS_DENIED_BURST` fires on ≥ `FLEET_DENIED_BURST_THRESHOLD` 401/403 responses in 10 minutes.
- `CONTENT_FILTER_TRIGGERED` fires on content-filter 400s. The score rises after 3 in one hour.
- Network flows (anything on `FLEET_NETWORK_ALLOWED_DESTINATIONS` is skipped). Direction matters: the risk for agent infrastructure is **egress**.
  - Outbound, allowed: a `MaliciousFlow` raises `SUSPICIOUS_NETWORK_FLOW` (78). More than 50 MB to an external public destination raises `DATA_EXFILTRATION` (60). An external public flow on an uncommon port raises `SUSPICIOUS_NETWORK_FLOW` (42).
  - Inbound: denied probes are ignored (the NSG is working). Allowed traffic from a known-malicious source raises one low-severity exposure alert per host per day; further sources that day are aggregated. In the lab this cut 431 scanner-driven alerts to 1.
- **Defender passthrough:** `SecurityAlert` rows with `AI.*` alert types and Defender XDR alerts and behaviors are mapped onto the taxonomy as follows. Any other alert type maps to `SESSION_RISK_ESCALATION`.

  | Defender alert type contains | Fleet alert |
  |---|---|
  | `Jailbreak` | `JAILBREAK_ATTEMPT` |
  | `CredentialTheft` | `CREDENTIAL_ACCESS` |
  | `MaliciousUrl` | `UNAPPROVED_DESTINATION` |
  | `ASCIISmuggling` | `PROMPT_INJECTION_SUSPECTED` |
  | `AnomalousToolInvocation` | `OUT_OF_CHARTER_ACTION` |
  | `LLMReconnaissance` | `INTENT_OUT_OF_SCOPE` |
  | `DOWVolumeAnomaly` | `INFERENCE_ANOMALY` |
  | `AccessFromAnonymizedIP`, `AccessFromSuspiciousIP`, `AccessAnomaly` | `UNREGISTERED_INFERENCE_CALLER` |
  | `DataExfiltration`, `SensitiveData` | `DATA_EXFILTRATION` |

  Scores follow Defender severity: high 80, medium 60, low 40, informational 20.
- The sentinel also maintains the **inference inventory** (`agentmon-fleet stats`): who calls which deployment, token counts, and whether the caller is registered.

### Control-plane Auditor — `detectors/controlplane.py`

These rules apply to `AzureActivity`, the `Audit` category of `AzureDiagnostics`, Purview and Defender Copilot Studio changes. Authorization, Key Vault and diagnostic-setting operations only count when they target an AI-scoped resource (Cognitive Services, ML, Bot Service, Log Analytics, App Insights or APIM). A failed operation adds 10 to the score.

| Operation (regex) | Alert | Base score |
|---|---|---|
| `DIAGNOSTICSETTINGS/DELETE` | `TELEMETRY_TAMPERING` | 75 |
| `OPERATIONALINSIGHTS/WORKSPACES/(DELETE\|TABLES/DELETE\|DATAEXPORTS/DELETE)` | `TELEMETRY_TAMPERING` | 70 |
| `INSIGHTS/COMPONENTS/DELETE` | `TELEMETRY_TAMPERING` | 65 |
| `RAIPOLICIES/…`, `RAIBLOCKLISTS/…` write or delete | `SENSITIVE_CONTROL_PLANE_OP` | 60 |
| `LISTKEYS` / `REGENERATEKEY` (ARM or the data-plane `ListKey` audit) | `SENSITIVE_CONTROL_PLANE_OP` | 45 |
| `AUTHORIZATION/ROLEASSIGNMENTS/(WRITE\|DELETE)` | `SENSITIVE_CONTROL_PLANE_OP` | 50 |
| `KEYVAULT/VAULTS/(WRITE\|DELETE\|ACCESSPOLICIES/WRITE)` | `SENSITIVE_CONTROL_PLANE_OP` | 45 |
| Foundry connections write or delete | `AGENT_CONFIG_CHANGE` | 40 |
| Deployments, projects, account write or delete | `AGENT_CONFIG_CHANGE` | 25–30 |
| `BOTSERVICE/…` or `POWERPLATFORM/…` write or delete | `AGENT_CONFIG_CHANGE` | 30 |

Key enumeration raises `CREDENTIAL_ACCESS` (60 + 2 per account): one identity listing keys on ≥ 4 AI accounts within 1 hour. A changed charter definition hash raises `AGENT_CONFIG_CHANGE` with the tools added or removed, new capabilities, and whether the instructions changed.

### RunawayLoopDetector — `detectors/loop.py`

- `RUNAWAY_LOOP` fires when one session makes the same tool call with identical arguments 5, 10 or 20 times.
- It also fires when a session reaches 40 and 80 tool calls in total.

### Correlator / Incident Commander — `detectors/correlator.py`

- Alerts are grouped by `session_id` (or by platform, agent and day when there is no session). The group is fused with a **noisy-OR over the strongest alert of each type**, so many copies of one weak signal can't add up to critical.
- `SESSION_RISK_ESCALATION` fires when there are ≥ 2 distinct alert types and a fused score ≥ 70.
- An incident is created or updated when the fused score is ≥ 65 or the top alert is high or critical. Its id is `fleet-<hash>`, and it carries the combined OWASP and ATLAS tags.
- New incidents, and incidents whose severity rose, get a gpt-5.5 narrative (reasoning effort `medium`). The narrative includes a title, summary, markdown report and recommendations. Recommendation actions are `disable_agent_version`, `revoke_connection`, `enforce_session`, `block_user`, `tighten_charter`, `rotate_credentials` and `review_transcript`. Each recommendation is stored with `status: "proposed"`.

### Jev shadow mode

`jev.py`, `jev_questions.py` and `jev_shadow.py` ask TypeSafe Jev the same questions as the intent, alignment, evasion, injection and code checks, plus the real-time gate. They run off-thread, with their own budget (`FLEET_JEV_BUDGET_PER_CYCLE`) and hard deadlines. The comparison records go to `{FLEET_MONITOR_URL}/api/gov/jev/shadow` and `FLEET_JEV_SHADOW_JSONL`. **Jev never changes an alert, score, ledger or verdict.** Jev is enabled when `FLEET_TYPESAFE_API_KEY` (or `TYPESAFE_API_KEY`) is set and `FLEET_JEV_MODE` isn't `off`. See [jev.md](jev.md).

---

## Alert taxonomy

From [taxonomy.py](../fleet/src/agentmon_fleet/taxonomy.py). OWASP LLM refers to the OWASP Top 10 for LLM Applications (2025). ASI refers to the OWASP Top 10 for Agentic Applications (2026).

| Alert type | Title | Default severity | OWASP LLM | OWASP Agentic | MITRE ATLAS |
|---|---|---|---|---|---|
| `INTENT_OUT_OF_SCOPE` | Session intent is outside the agent's use cases | medium | LLM06 | ASI01 | AML.T0051 |
| `GOAL_DRIFT` | Agent behaviour drifted away from the session goal | high | LLM01 | ASI01 | AML.T0051.001, AML.T0080.001 |
| `OUT_OF_CHARTER_ACTION` | Tool use outside the agent's allowed capabilities | medium | LLM06 | ASI02 | AML.T0053 |
| `FORBIDDEN_CAPABILITY` | Agent attempted a forbidden capability | high | LLM06 | ASI02, ASI03 | AML.T0053 |
| `OUT_OF_BOUNDS_SCRIPT` | Agent-generated script exceeds the agent's scope | high | LLM05 | ASI05 | AML.T0050, AML.T0102 |
| `OBFUSCATED_CODE` | Agent produced obfuscated code or commands | high | LLM05 | ASI05, ASI10 | AML.T0068, AML.T0050 |
| `CREDENTIAL_ACCESS` | Agent accessed credentials or tokens | high | LLM02 | ASI03 | AML.T0055, AML.T0083, AML.T0090 |
| `DATA_EXFILTRATION` | Possible data exfiltration via agent tool | critical | LLM02 | ASI02 | AML.T0086, AML.T0025 |
| `DESTRUCTIVE_ACTION` | Destructive operation by agent | high | LLM06 | ASI02, ASI05 | AML.T0101 |
| `BLOCKED_ACTION_WORKAROUND` | Agent attempted to work around a blocked action | high | LLM06 | ASI10, ASI01 | AML.T0107, AML.T0068 |
| `REPEATED_BLOCKED_ATTEMPTS` | Agent repeatedly retried blocked actions | medium | LLM06 | ASI10 | AML.T0107 |
| `USER_PERSISTENCE_AFTER_BLOCK` | User kept pushing for a refused or blocked request | medium | LLM01 | ASI01, ASI09 | AML.T0054, AML.T0051.000 |
| `JAILBREAK_ATTEMPT` | User prompt contains jailbreak or instruction-override patterns | medium | LLM01 | ASI01 | AML.T0054, AML.T0051.000 |
| `SOCIAL_ENGINEERING_USER` | Agent asked the user to perform a blocked action | high | LLM06 | ASI09, ASI10 | — |
| `PROMPT_INJECTION_SUSPECTED` | Tool output or input contains injection indicators | high | LLM01 | ASI01, ASI06 | AML.T0051.001 |
| `UNAPPROVED_DESTINATION` | Agent reached a destination outside its allowlist | medium | LLM06 | ASI02 | AML.T0086 |
| `SUSPICIOUS_NETWORK_FLOW` | Suspicious network flow from agent infrastructure | medium | — | ASI02 | AML.T0025 |
| `UNREGISTERED_INFERENCE_CALLER` | Model inference from an identity that is not a registered agent | medium | LLM10 | ASI03 | AML.T0040 |
| `INFERENCE_ANOMALY` | Anomalous inference volume or token usage | medium | LLM10 | ASI08 | AML.T0034.002 |
| `CONTENT_FILTER_TRIGGERED` | Content safety filter blocked model traffic | medium | LLM01 | ASI01 | AML.T0054 |
| `AGENT_CONFIG_CHANGE` | Agent definition or security configuration changed | low | LLM03 | ASI04 | AML.T0081 |
| `SENSITIVE_CONTROL_PLANE_OP` | Sensitive control-plane operation on AI resources | medium | — | ASI03 | AML.T0055 |
| `TELEMETRY_TAMPERING` | Monitoring or diagnostic settings on AI resources were disabled or deleted | high | — | ASI10 | AML.T0107 |
| `ACCESS_DENIED_BURST` | Burst of denied data-plane requests against AI resources | medium | — | ASI03 | AML.T0040 |
| `RUNAWAY_LOOP` | Agent is looping or consuming excessive resources | medium | LLM10 | ASI08 | AML.T0034.002 |
| `SESSION_RISK_ESCALATION` | Multiple risk signals in one session | high | — | ASI10 | — |

---

## Charters

A charter (`AgentProfile`) records what an agent is for. It holds `purpose`, `use_cases[{id, description, expected_capabilities}]`, `allowed_capabilities`, `forbidden_capabilities`, `allowed_destinations`, `out_of_scope`, `enforce` and `block_threshold`. `enforce` is tri-state and only a YAML charter can set it: `true` blocks in real time, `false` observes, and unset (`null`) inherits `FLEET_HOOKS_MODE`. The profiler clears it every cycle before re-applying the YAML overrides, so removing the key from YAML takes effect. The Profiler (`detectors/profiler.py`) builds and refreshes charters:

1. **Heuristic.** Tool types and names map to capabilities (`normalize/capabilities.py`). Everything in the high-risk set that no tool needs is forbidden.
2. **LLM.** gpt-5.5 (reasoning effort `low`) drafts the purpose, 3–8 use cases, allowed and forbidden capabilities, destinations and out-of-scope items from the agent's name, description, instructions, tools and knowledge. The draft is conservative: code execution doesn't imply credential access, exfiltration and similar. This only runs when the agent's **definition hash** changes (instructions, tools or model), so unchanged agents cost no LLM calls.
3. **YAML overrides.** `*.yaml` / `*.yml` in `FLEET_CHARTER_DIR` (default `fleet/charters/` in a source checkout; `/app/charters` in the container image) take precedence field by field. They are reloaded every cycle. A match is either a case-insensitive **name glob** or an exact **agent id**, optionally restricted by `platform` (`foundry` | `copilot_studio` | `azure_openai`). `derived_by` becomes `manual` or `llm+manual`.

Capabilities: `read_data write_data delete_data exec_code exec_shell net_egress download_exec exfil cred_access persistence priv_esc defense_evasion destructive recon send_message identity_admin cloud_admin search knowledge agent_delegation model_inference unknown`.

Example from [fleet/charters/lab-agents.yaml](../fleet/charters/lab-agents.yaml):

```yaml
- match: "agentmon-vendor-research*"
  platform: foundry
  purpose: Research enterprise software vendors from public web sources and the internal vendor directory.
  use_cases:
    - id: vendor_profile
      description: Summarize a named vendor's products, pricing and compliance posture from public sources.
      expected_capabilities: [search, net_egress, read_data]
    - id: vendor_lookup
      description: Look up a vendor's record (owner, contract tier, risk rating) in the internal vendor directory API.
      expected_capabilities: [net_egress, read_data]
  allowed_capabilities: [search, net_egress, read_data, knowledge, model_inference]
  forbidden_capabilities: [exec_code, exec_shell, send_message, write_data, delete_data, cred_access, exfil]
  allowed_destinations: [bing.com, api.bing.microsoft.com, vendors.agentmon.lab]
  out_of_scope: [HR or payroll questions, writing code, sending e-mail, changing vendor records]
  enforce: false          # true = real-time hooks block when score >= block_threshold
  # block_threshold: 70   # optional; default FLEET_HOOKS_BLOCK_THRESHOLD
```

```powershell
agentmon-fleet profiles    # show every charter: purpose, use cases, allowed/forbidden, destinations, derived_by
```

---

## Fleet Commander (agentic mode)

[agents/orchestrator.py](../fleet/src/agentmon_fleet/agents/orchestrator.py) builds a **Microsoft Agent Framework** orchestrator on the Foundry project (`FoundryChatClient`, model `FLEET_MODEL_DEPLOYMENT`). Each specialist is exposed to the commander as a tool (agent-as-tool). The deterministic pipeline handles the per-event work; these agents handle work that needs judgement.

| Specialist | Tools ([agents/tools.py](../fleet/src/agentmon_fleet/agents/tools.py)) | Role |
|---|---|---|
| `charter_agent` | `list_agents`, `get_charter`, `list_alerts` | Reviews charters and suggests YAML overrides |
| `intent_analyst` | `get_session`, `get_charter`, `list_alerts` | Rebuilds the goal from user turns and explains drift |
| `action_analyst` | `get_session`, `get_charter`, `list_alerts` | Explains what suspicious tool calls and scripts do |
| `evasion_monitor` | `get_denials`, `get_session`, `list_alerts` | Finds workaround attempts and says who drove them (agent or user) |
| `inference_network_sentinel` | `inference_inventory`, `run_kql`, `list_alerts` | Covers model usage, network flows and Defender for AI |
| `control_plane_auditor` | `run_kql`, `list_alerts` | Explains who changed what on AI resources |
| `incident_commander` | `list_incidents`, `get_incident`, `get_session`, `get_denials`, `list_alerts`, `propose_containment` | Runs end-to-end investigations and proposes containment |

The commander can also call `list_incidents`, `list_alerts` and `list_agents` directly.

- `run_kql` is read-only: management commands and `externaldata` are rejected, and it returns at most 50 rows.
- `propose_containment` only appends a recommendation with `status: "proposed"`. It returns `"proposed (awaiting human approval)"`.
- All tool output is treated as untrusted data.

```powershell
agentmon-fleet run --agentic --once              # deterministic cycle, then deep-dive up to 3 new high/critical session incidents
agentmon-fleet ask "Which agents tried to work around a block today?"
agentmon-fleet investigate <session_id>          # markdown report saved on the incident (report, investigated=true)
```

---

## LLM usage

All model calls go through `llm.py` to the Foundry project's OpenAI v1 endpoint (`<account>/openai/v1/`). They use Entra ID, or `FLEET_FOUNDRY_API_KEY` if set. Every detector prompt wraps captured content in `<untrusted>…</untrusted>` with an injection guard, and Fleet Commander tool results are redacted and returned inside the same `<untrusted>` wrapper. `FLEET_LLM_BUDGET_PER_CYCLE` bounds detector calls (charters, intent, alignment, adjudicators, code judge, incident narratives). Embedding lookups for similarity and Fleet Commander runs (`ask`, `investigate`, `run --agentic`) are not counted against it, and `--no-llm` does not disable the Fleet Commander.

| Use | Model | Setting | Reasoning effort |
|---|---|---|---|
| Charters, intent classification, alignment, evasion adjudication, code judge | gpt-5.5 | `FLEET_MODEL_DEPLOYMENT` | `low` |
| Incident narratives, Fleet Commander | gpt-5.5 | `FLEET_MODEL_DEPLOYMENT` | `medium` for narratives |
| Real-time triage (hooks) | gpt-4.1-mini | `FLEET_FAST_MODEL_DEPLOYMENT` | — |
| Semantic similarity (evasion) | text-embedding-3-large | `FLEET_EMBEDDING_DEPLOYMENT` | — |

- **Budget:** `FLEET_LLM_BUDGET_PER_CYCLE` (default 60) caps gpt-5.5 structured calls per cycle. When it is spent, detectors fall back to their deterministic scores. Embedding calls don't count against it. `CycleReport.llm_calls` shows how many were used.
- **Real time:** the hooks path never calls gpt-5.5. It calls the fast model only when the deterministic score is between 35 and 90 and at least 350 ms of the `FLEET_HOOKS_DEADLINE_MS` budget remain, with a timeout of `min(time left − 100 ms, FLEET_FAST_LLM_TIMEOUT_S)`.
- `--no-llm` (or `FLEET_LLM_ENABLED=false`) runs deterministic detectors only.

## Redaction

[redact.py](../fleet/src/agentmon_fleet/redact.py) runs on every event, whether collected or pushed to hooks, **before** storage, LLM analysis or export. Placeholders are typed so detectors still know what was there.

| Always masked | With `FLEET_REDACT_PII=true` (default) |
|---|---|
| Private keys, JWTs, AWS / GitHub / Slack / OpenAI / Google keys, Azure storage keys and SAS `sig=`, connection-string passwords, bearer tokens, Azure client secrets, generic `api_key=`/`secret=`/`password=` assignments, and any dict value whose key looks sensitive (`*_secret`, `token`, `password`, `conn_string`, `sas`…) | US SSNs, phone numbers, Luhn-valid card numbers, and e-mail local parts (`a***@contoso.com`; the domain is kept for destination analysis) |

It redacts `text`, `thought`, `arguments`, `result`, `error`, `decision_reason`, effect evidence and the attributes `system_instructions`, `inline_definition`, `tool_description`, `refusal_or_block` and `plan`.

## Sinks

| Sink | Enabled when | Destination |
|---|---|---|
| JSONL | `FLEET_ALERTS_JSONL` is non-empty (default `fleet-alerts.jsonl`) | `{"type":"alert", …}` and `{"type":"incident", …}` lines |
| Log Analytics | `FLEET_ALERTS_DCE` and `FLEET_ALERTS_DCR_ID` | Logs Ingestion API, stream `FLEET_ALERTS_STREAM` (`Custom-AgentMonAlerts`), into table **`AgentMonAlerts_CL`**. Columns: `TimeGenerated, AlertId, IncidentId, Fingerprint, AlertType, Severity, Score, Title, Summary, Platform, AgentId, AgentName, SessionId, UserId, LaneId, Detector, Action, OwaspLlm, OwaspAgentic, MitreAtlas, Evidence, SourceEventIds`. The identity needs **Monitoring Metrics Publisher** on the DCR. |
| Dashboard | `FLEET_MONITOR_URL` (default `http://127.0.0.1:4317`) | `POST /api/gov/fleet/alerts` (`{alerts:[…]}`, role `Agent` or `PolicyAdmin`, bearer `FLEET_MONITOR_TOKEN`). For incidents it sends `PATCH /api/gov/incidents/{id}`, then `POST /api/gov/incidents` on 404. The patch never overrides the analyst's `state`. A created incident emits `incident.created`, and the TS alert module ([src/governance/alerts](../src/governance/alerts/index.ts)) routes it by severity: **critical** to Teams, email and webhook; **high** to Teams and webhook; lower severities to webhook. |
| Console | `run --console` | Colour-coded lines |

The dashboard shows fleet alerts on the **Fleet** page (`/fleet`, [web/src/pages/fleet](../web/src/pages/fleet/FleetPage.tsx)), which has Alerts, Agents and Session timeline tabs and live updates over WebSocket. The API is in [src/governance/routes/fleet.ts](../src/governance/routes/fleet.ts):

| Endpoint | Purpose |
|---|---|
| `POST /api/gov/fleet/alerts` | Ingest alerts (at most 500 per batch) |
| `GET /api/gov/fleet/alerts?severity=&type=&platform=&agent=&session=&incident=&since=&limit=` | Query alerts |
| `GET /api/gov/fleet/alerts/:id` | Get one alert |
| `GET /api/gov/fleet/summary?since=` | Counts by type, severity, platform and agent |

Analytics rules and a workbook over `AgentMonAlerts_CL` are in [infra/sentinel](../infra/sentinel/README.md). `deploy-sentinel.ps1 -Target sentinel|monitor`. In the lab, Sentinel isn't enabled, and the `monitor`-target rules (Azure Monitor log search alerts) and the workbook are deployed.

---

## Running locally

Prerequisites: Python ≥ 3.12, an Azure login or service principal with the read roles in [fleet-sources.md](fleet-sources.md#permissions), and a Foundry project with `gpt-5.5`, `gpt-4.1-mini` and `text-embedding-3-large` deployments (or use `--no-llm`).

```powershell
cd fleet
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
# Settings come from FLEET_* variables in the repo-root .env (see .env.example) or the environment.
agentmon-fleet discover                    # Foundry accounts/projects in scope
agentmon-fleet run --once --console        # one full cycle, alerts printed
agentmon-fleet --no-llm run --once         # deterministic detectors only (global flags go before the command)
agentmon-fleet run                         # loop every FLEET_POLL_INTERVAL_S
pytest                                     # unit tests (fleet/tests)
```

Credentials, in `auth.py`: in Azure (`IDENTITY_ENDPOINT` / `MSI_ENDPOINT` set) the fleet uses the managed identity `FLEET_MANAGED_IDENTITY_CLIENT_ID`. Otherwise it uses `FLEET_AZURE_CLIENT_ID` + `FLEET_AZURE_CLIENT_SECRET` + `FLEET_AZURE_TENANT_ID`. If those aren't set, it falls back to your developer login (`az login`).

| Command | Purpose |
|---|---|
| `discover` | List Foundry accounts and projects found through ARM in `FLEET_SCOPE_SUBSCRIPTIONS` / `FLEET_SUBSCRIPTION_ID` |
| `collect [--source law\|foundry\|dataverse\|storage\|purview\|entra\|defender]` | Run collectors once and store events, with no detection |
| `run [--once] [--interval N] [--console] [--agentic] [--source …]` | Monitoring cycles |
| `profiles` · `alerts [--limit N] [--json]` · `incidents` · `sessions [--limit N]` · `stats` | Inspect state |
| `hooks [--host 127.0.0.1] [--port 8787]` | Serve the real-time endpoints ([fleet-realtime-hooks.md](fleet-realtime-hooks.md)) |
| `ask "<question>"` · `investigate <session_id>` | Fleet Commander |
| `scenarios list\|setup\|run\|verify` | Adversarial lab scenarios (see below) |
| Global flags (before the command) | `-v`, `--state <path>` (overrides `FLEET_STATE_DB`), `--no-llm` — for example `agentmon-fleet -v --no-llm run --once` |

### Real-time hooks locally

```powershell
$env:FLEET_HOOKS_TOKEN = "<local-shared-secret>"   # shared bearer for /evaluate and /events (dev only)
agentmon-fleet hooks --port 8787
curl.exe -s http://127.0.0.1:8787/health          # {"ok":true,"mode":"observe","llm":true}
```

### Adversarial scenarios

[scenarios/runner.py](../fleet/src/agentmon_fleet/scenarios/runner.py) drives purpose-built lab agents ([scenarios/lab_agents.py](../fleet/src/agentmon_fleet/scenarios/lab_agents.py): `agentmon-vendor-research`, `agentmon-data-analyst`, `agentmon-it-helpdesk`, plus the Copilot Studio agents `AgentMon HR Policy` and `AgentMon IT Ops`) through the scenarios in [scenarios/catalog.yaml](../fleet/src/agentmon_fleet/scenarios/catalog.yaml). Scenario categories are benign, out_of_scope, injection, out_of_bounds_script, obfuscation, evasion, exfiltration, runaway and inference.

The runner executes function tools client-side and simulates the enterprise controls: DLP blocks on external recipients and hosts, identity-admin denials and MCP approval decisions. That lets blocked-then-workaround behaviour happen for real.

```powershell
agentmon-fleet scenarios list
agentmon-fleet scenarios setup                                   # create/update the lab Foundry agents
agentmon-fleet scenarios run --only evasion                       # id, glob or category; repeatable
agentmon-fleet scenarios run --hooks-url http://127.0.0.1:8787    # gate every function call through /evaluate
agentmon-fleet scenarios verify --cycle                           # one fleet cycle first, then score
agentmon-fleet scenarios verify --since 2026-09-30T00:00:00Z --json
```

- `--identity cli|fleet` chooses whether setup and run call Azure as your CLI login (the default) or as the fleet identity.
- `verify` compares the alert types raised for each scenario's conversation (or run window) with its `expect` groups and `optional` types. It reports **recall** (expected groups detected) and **precision** (detected types that were expected). `AGENT_CONFIG_CHANGE` is tolerated.
- Runs are recorded under `scenario-runs/` (`FLEET_SCENARIO_RUNS_DIR`).
- Copilot Studio scenarios use Direct Line and need `FLEET_SCENARIO_CS_HR_TOKEN_URL` / `FLEET_SCENARIO_CS_ITOPS_TOKEN_URL` (and optionally `FLEET_SCENARIO_DIRECTLINE_URL`) set as **process environment variables**; they aren't read from `.env`. Without them, those scenarios are skipped.

The lab network target is the vendor directory API ([infra/lab/vendor-api](../infra/lab/vendor-api/app.py)) behind Caddy on a B1s VM, so that VNet flow logs contain agent-driven traffic. `infra/lab/provision-lab.ps1` provisions it idempotently (`-Steps network,foundry,dataverse,diagnostics`, `-WhatIf`, `-ApplyDiagnostics`). The same script creates the Dataverse read-only role and application user, and reports AI resources that aren't sending diagnostics. Dataverse auditing can't be enabled on `bot`/`botcomponent` (platform-managed tables), so Copilot Studio authoring changes come from Purview audit plus the fleet's own definition-drift detection. The Copilot Studio half of the lab, including the threat-detection webhook app (`infra/lab/create-webhook-app.ps1`), is in [infra/lab/COPILOT-STUDIO-SETUP.md](../infra/lab/COPILOT-STUDIO-SETUP.md).

### Lab validation results (Foundry, 2026-09-30)

13 Foundry and inference scenarios were run against the lab agents (gpt-4.1-mini), with every tool call gated through the real-time hooks:

| Stage | Recall | Precision | Fixed after this stage |
|---|---|---|---|
| First run | 0.455 | 1.0 | Injection phrasing ("ignore **your** previous instructions", "note to AI assistants"); tool outputs lost when the call and output arrive in different responses; a refusal that hands the blocked action to the user; user-supplied obfuscated payloads that the agent decodes before running; missing `RUNAWAY_LOOP` detector; Foundry API and GenAI span duplicates |
| After fixes | **0.727** | **1.0** | — |

All benign controls stayed silent. The three remaining misses (`blocked-then-workaround`, `exfil-unapproved-host`, `runaway-loop`) are sessions where the model **behaved correctly**: it refused, didn't upload and didn't loop. So they're scenario-strength limits, not detector gaps. With LLM detectors, a fresh-state backfill of about 190 events takes about 4 minutes, bounded by `FLEET_LLM_BUDGET_PER_CYCLE`. Charter drafts and incident narratives run concurrently, and steady-state cycles only process new events.

---

## Configuration reference

Settings come from `FLEET_*` variables, read from the process environment or the nearest `.env` (the current directory, then the repo root). Lists are JSON arrays, for example `FLEET_KNOWN_CALLERS=["<object-id>"]`. For a template, see the `FLEET_*` block in [.env.example](../.env.example).

| Variable | Default | Purpose |
|---|---|---|
| **Identity** | | |
| `FLEET_AZURE_TENANT_ID` | — | Tenant. Required for hook JWT validation and the Purview collector. |
| `FLEET_AZURE_CLIENT_ID` / `FLEET_AZURE_CLIENT_SECRET` | — | Service principal for local runs. Never set the secret in Azure. |
| `FLEET_MANAGED_IDENTITY_CLIENT_ID` | — | User-assigned managed identity used in Container Apps |
| `FLEET_SUBSCRIPTION_ID` | — | Discovery subscription when `FLEET_SCOPE_SUBSCRIPTIONS` is empty |
| **Models** | | |
| `FLEET_FOUNDRY_PROJECT_ENDPOINT` | — | `https://<account>.services.ai.azure.com/api/projects/<project>`. Used for LLM access, and the project is also polled. |
| `FLEET_FOUNDRY_API_KEY` | — | Optional key fallback for LLM calls (a secret) |
| `FLEET_FOUNDRY_RESOURCE_ID` | — | Declared but not read by current code |
| `FLEET_MODEL_DEPLOYMENT` | `gpt-5.5` | Deep analysis and Fleet Commander |
| `FLEET_FAST_MODEL_DEPLOYMENT` | `gpt-4.1-mini` | Real-time triage |
| `FLEET_EMBEDDING_DEPLOYMENT` | `text-embedding-3-large` | Evasion similarity |
| `FLEET_LLM_ENABLED` | `true` | `false` is equivalent to `--no-llm` |
| `FLEET_LLM_TIMEOUT_S` | `60` | Per-call timeout for the deep model |
| `FLEET_FAST_LLM_TIMEOUT_S` | `0.6` | Upper bound for the real-time triage call; the effective timeout is `min(time left before FLEET_HOOKS_DEADLINE_MS − 100 ms, this)` |
| `FLEET_REASONING_EFFORT` | `low` | Default effort (`minimal`, `low`, `medium`, `high`) for gpt-5 / o-series models |
| **Log sources** | | |
| `FLEET_LAW_WORKSPACE_ID` | — | Workspace **GUID** (customer id). Enables the `law` collector and `run_kql`. |
| `FLEET_LAW_RESOURCE_ID` / `FLEET_APPINSIGHTS_RESOURCE_ID` | — | Declared but not read by current code (used by Terraform for RBAC) |
| `FLEET_STORAGE_ACCOUNT` | — | Storage account **name** holding the `insights-logs-*` archives. Used only when LAW isn't configured, or when you pass `--source storage`. |
| `FLEET_DATAVERSE_ORG_URL` | — | `https://<org>.crm.dynamics.com`; enables the `dataverse` collector |
| `FLEET_PP_ENVIRONMENT_ID` | — | Power Platform environment id, stamped on Copilot Studio events |
| **Scope** | | |
| `FLEET_SCOPE_SUBSCRIPTIONS` | `[]` | Subscriptions to scan for Foundry and Azure OpenAI accounts |
| `FLEET_FOUNDRY_PROJECTS` | `[]` | Extra project endpoints to poll |
| `FLEET_CONTENT_PROJECTS` | `[]` | Limits deep content collection to projects whose endpoint contains one of these substrings. Empty means every accessible project. |
| `FLEET_CHARTER_DIR` | `fleet/charters` | Directory of YAML charter overrides |
| **Sinks** | | |
| `FLEET_ALERTS_DCE` | — | Data collection endpoint URL (logs ingestion) |
| `FLEET_ALERTS_DCR_ID` | — | DCR **immutable id** (`dcr-…`) |
| `FLEET_ALERTS_STREAM` | `Custom-AgentMonAlerts` | DCR stream name |
| `FLEET_MONITOR_URL` | `http://127.0.0.1:4317` | Governance server for dashboard alerts and incidents. Empty disables it. |
| `FLEET_MONITOR_TOKEN` | — | Bearer for the dashboard API. The principal needs the `Agent` role (a secret). |
| `FLEET_APPINSIGHTS_CONNECTION_STRING` | — | Declared but not read by current code |
| **Runtime** | | |
| `FLEET_STATE_DB` | `fleet-state.db` | SQLite state path |
| `FLEET_POLL_INTERVAL_S` | `120` | Seconds between cycles |
| `FLEET_LOOKBACK_MINUTES` | `1440` | First-run lookback for each cursor |
| `FLEET_OVERLAP_MINUTES` | `45` | Re-read overlap for late-arriving logs. Dataverse uses at least 90 and Purview at least 60. |
| `FLEET_MIN_ALERT_SEVERITY` | `low` | Drop alerts below this severity |
| `FLEET_LLM_BUDGET_PER_CYCLE` | `60` | Maximum gpt-5.5 calls per cycle |
| `FLEET_REDACT_PII` | `true` | PII masking; secrets are always masked |
| `FLEET_EVENTS_JSONL` | — | Mirror new normalized events to this file (for debugging) |
| `FLEET_ALERTS_JSONL` | `fleet-alerts.jsonl` | Local alert log. Empty disables it. |
| **Inference and network** | | |
| `FLEET_KNOWN_CALLERS` | `[]` | Entra object ids allowed to call models directly |
| `FLEET_INFERENCE_HOURLY_TOKEN_ALERT` | `250000` | Hourly token floor for `INFERENCE_ANOMALY` |
| `FLEET_DENIED_BURST_THRESHOLD` | `20` | 401/403 responses within 10 minutes before `ACCESS_DENIED_BURST` |
| `FLEET_NETWORK_ALLOWED_DESTINATIONS` | `[]` | Flow destinations (IP or host) the network checks ignore |
| **Tenant collectors** (need admin consent, see [fleet-sources.md](fleet-sources.md#tenant-collectors-opt-in)) | | |
| `FLEET_TENANT_PURVIEW` | `false` | O365 Management Activity API (`Audit.General`) |
| `FLEET_PURVIEW_START_SUBSCRIPTION` | `false` | Lets the fleet start the `Audit.General` subscription |
| `FLEET_TENANT_ENTRA` | `false` | Entra Agent ID inventory and agent sign-ins (Graph) |
| `FLEET_TENANT_DEFENDER` | `false` | Defender XDR advanced hunting (Graph `runHuntingQuery`) |
| **Real-time hooks** | | |
| `FLEET_HOOKS_AUDIENCE` | `[]` | Accepted JWT `aud` values |
| `FLEET_HOOKS_ALLOWED_APP_IDS` | `[]` | Allowed caller app ids (`azp` / `appid`). Empty means any app in the tenant. |
| `FLEET_HOOKS_ALLOW_ANONYMOUS` | `false` | Accept requests with no bearer token. Never use outside isolated dev. |
| `FLEET_HOOKS_TOKEN` | — | Shared bearer accepted on all hook endpoints (local and dev) |
| `FLEET_HOOKS_BLOCK_THRESHOLD` | `70` | Score at or above which enforce mode blocks. A charter's `block_threshold` overrides it. |
| `FLEET_HOOKS_MODE` | `observe` | `observe` or `enforce`. The default for every agent whose YAML charter doesn't set `enforce` (no charter, or an LLM-derived charter only). A YAML `enforce: true/false` always wins. |
| `FLEET_HOOKS_DEADLINE_MS` | `850` | Internal budget within Copilot Studio's 1,000 ms |
| **Jev (shadow only)** | | See [jev.md](jev.md) |
| `FLEET_JEV_MODE` | `shadow` | `off` or `shadow` |
| `FLEET_TYPESAFE_API_KEY` (or `TYPESAFE_API_KEY`) | — | Enables Jev when set (a secret) |
| `FLEET_TYPESAFE_BASE_URL` (or `TYPESAFE_BASE_URL`) | — | API base URL override |
| `FLEET_JEV_MODEL` | `jev-1.13.0` | Pinned model version |
| `FLEET_JEV_TIMEOUT_S` / `FLEET_JEV_REALTIME_TIMEOUT_S` | `2.0` / `0.3` | Hard deadlines |
| `FLEET_JEV_BUDGET_PER_CYCLE` | `2000` | Jev call budget |
| `FLEET_JEV_SHADOW_POST` | `true` | POST records to `{FLEET_MONITOR_URL}/api/gov/jev/shadow` |
| `FLEET_JEV_SHADOW_JSONL` | `fleet-jev-shadow.jsonl` | Local shadow log. Empty disables it. |

---

## Deployment

The full procedure is in [infra/README.md → Monitoring fleet](../infra/README.md#monitoring-fleet-optional). In summary:

- **Off by default.** Set the repository variable `ENABLE_FLEET=true`. *Deploy* then builds, scans and pushes `agentgov/fleet:<git-sha>` from [fleet/Dockerfile](../fleet/Dockerfile) and plans with `-var enable_fleet=true -var fleet_image_tag=<sha>`.
- **`modules/fleet`** creates:
  - A user-assigned identity `id-<prefix>-<env>-fleet`
  - The worker Container App `<prefix>-<env>-fleet` (`agentmon-fleet run`, no ingress, 1 replica)
  - The hooks Container App `<prefix>-<env>-fleet-hooks` (`agentmon-fleet hooks`, port 8787, external ingress, `GET /health`)
- **RBAC (read-only, plus one publisher):**
  - Log Analytics Reader
  - Monitoring Reader + Security Reader on each scope subscription
  - Azure AI User on the Foundry accounts (the role is now named **Foundry User**)
  - Storage Blob Data Reader on the diagnostics archive
  - Monitoring Metrics Publisher on the alerts DCR
  - Monitoring Reader on the monitored resources

  Owner, Contributor and User Access Administrator are rejected. Dataverse needs a separate application user (not managed by Terraform).
- **Config:** each `FLEET_*` setting comes from a `fleet_*` Terraform variable. Secrets (`FLEET_MONITOR_TOKEN`, `FLEET_FOUNDRY_API_KEY`, `FLEET_TYPESAFE_API_KEY`) flow from GitHub environment secrets into Key Vault and are mounted as `secretRef`.
- **State** is on an EmptyDir volume (`/data`). A new revision re-reads `FLEET_LOOKBACK_MINUTES`, so expect a few duplicate alerts after a rollout. Keep hooks at 1 replica.

```powershell
terraform -chdir=infra/terraform output fleet_app_names
curl.exe -fsS "$(terraform -chdir=infra/terraform output -raw fleet_hooks_url)/health"
```

---

## Roadmap

### Next phase: Copilot Studio validation

The Copilot Studio code path is built and unit-tested:
- Dataverse bots, components and transcripts, with generative-plan steps.
- Agent-level `AppEvents` and environment-level OTel spans.
- The external threat-detection webhook (`/copilot-studio/validate` and `/analyze-tool-execution`, using the documented `ToolExecutionOutput` schema).
- Direct Line scenarios `cs-*`.

The lab plumbing is also in place:
- The fleet has an application user with the **AgentMon Fleet Reader** role in AgentMon-Lab.
- The webhook Entra app and FIC exist (`infra/lab/create-webhook-app.ps1`).
- A dev tunnel points at the hooks server.

What remains for the next phase is lab validation. It needs manual Copilot Studio and Power Platform admin center steps, which have no supported API. The steps are in [infra/lab/COPILOT-STUDIO-SETUP.md](../infra/lab/COPILOT-STUDIO-SETUP.md):
1. Create and publish the **AgentMon HR Policy** and **AgentMon IT Ops** agents in AgentMon-Lab.
2. Turn on agent-level Application Insights, and optionally the environment-level OTel export (AgentMon-Lab is a managed environment).
3. Register the fleet webhook in Power Platform admin center ? Security ? Threat detection. Confirm the `/validate` handshake and the token audience in `fleet/hooks.log`.
4. Run `agentmon-fleet scenarios run --only "cs-*"` (Direct Line token endpoints in `FLEET_SCENARIO_CS_*_TOKEN_URL`) and `scenarios verify --cycle`. Record recall and precision next to the Foundry results.

### Later
- Per-session parallel detection for faster first-run backfills (sessions are independent; events within a session stay ordered).
- APIM AI Gateway for content capture on direct model inference ([apim-ai-gateway.md](apim-ai-gateway.md)).
- Stronger adversarial prompts for scenarios where the lab model refuses before misbehaving (`blocked-then-workaround`, `exfil-unapproved-host`, `runaway-loop`).
