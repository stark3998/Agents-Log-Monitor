# Governance API contract

The wire contract between enforcement points, SDKs, the dashboard, the MCP server and the Python intelligence service. The types are defined in [`src/governance/types.ts`](../src/governance/types.ts) and all payloads are JSON. The field names in this doc are the source of truth for the SDK mirrors in `packages/sdk-ts`, `packages/sdk-python` and `intelligence/`.

## Authentication

| Mode | Callers | Credential |
|---|---|---|
| local | loopback agent clients (hooks, `/v1`, read-only dashboard/MCP) | none; becomes `local-agent` with `Agent` + `Viewer` only |
| local | dashboard administrator | one-time `/api/gov/local-login?token=...` URL printed on startup; sets HttpOnly `agentgov_admin` cookie (12h) |
| local | automation administrator | optional `Authorization: Bearer <GOVERNANCE_LOCAL_ADMIN_TOKEN>` |
| cloud | dashboard, MCP clients, SDKs, gateway | `Authorization: Bearer <Entra access token>` (aud = `ENTRA_API_AUDIENCE`) |
| cloud | local enforcers (sync) | `Authorization: Bearer <device token>` |
| cloud | Copilot cloud agent hooks | `Authorization: Bearer <hook token>` (Agent role) |

Roles: `Viewer` (read), `Approver` (approve/deny), `PolicyAdmin` (lanes, pause, registry), `Agent` (call `/v1/*`).

Local browser hardening: `/api`, `/api/gov`, `/v1`, `/hooks`, `/mcp`, and `/ingest` require loopback Host headers; state-changing requests require a loopback Origin (Vite dev origin allowed outside production), and mutating `/api/gov` requests must be JSON.

## PDP API — `/v1` (role: Agent)

### `POST /v1/decide`
Request: `ActionRequest` plus optional options:
```json
{
  "requestId": "toolu_123", "sessionId": "s-1", "checkpoint": "pre_tool",
  "agent": { "surface": "sdk", "externalId": "support-bot", "name": "Support bot", "user": "a@contoso.com" },
  "toolName": "issue_refund", "args": { "orderId": "42", "destination": "IBAN…" },
  "options": { "blocking": true, "supportsAsk": false, "deadlineMs": 30000 }
}
```
Response: `Decision`. The fields enforcement points use are `verdict` (`allow|deny|ask|escalate`), `reason`, `id`, `approvalId`, `wouldDeny` and `mode`.

When `blocking=false`, `verdict:"escalate"` can come back with an `approvalId`. The caller then polls `GET /v1/approvals/:id` until `state` is no longer `pending`.

### `POST /v1/goal`
Body: `{ sessionId, agent, text, source? }`. Records the user goal for the session. Response: `{ ok: true, goal? }`.

### `POST /v1/result`
Body: `{ requestId, sessionId, agent, toolName, result }`. Runs Prompt Shields and taints the session when needed. Response: `{ tainted: boolean, reason? }`.

### `GET /v1/approvals/:id`
Response: `Approval`.

### `GET /v1/lanes/effective?surface=&externalId=`
Response: the `Lane` that would apply. Local enforcers and SDKs use it for client-side caching and fail-mode decisions.

## Hooks — `/hooks/:surface`
Each supported surface gets a native-format endpoint that adapts to the PDP.
- `/hooks/claude-code`: the Claude Code HTTP hook body in, a Claude Code hook JSON response out.
- `/hooks/copilot-cli`: forwarder body in, `{permissionDecision, permissionDecisionReason}` out.
- `/hooks/vscode`: VS Code agent hook format.
- `/hooks/copilot-cloud-agent`: the same as copilot-cli (reached over https via the cloud control plane).

These endpoints also forward telemetry into the existing ingest pipeline, so `/ingest` hooks are no longer needed for these surfaces.

## Dashboard / admin API — `/api/gov`
| Method & path | Role | Description |
|---|---|---|
| `GET /api/gov/overview?from&to` | Viewer | `{ decisions: {allow,deny,ask,escalate,wouldDeny}, pendingApprovals, openIncidents, agents: {active,paused,quarantined}, judge: {calls, p95Ms}, trend: [{t, allow, deny, wouldDeny}] }` |
| `GET /api/gov/decisions?sessionId&agentId&laneId&verdict&wouldDeny&text&since&until&limit&cursor` | Viewer | `{ items: Decision[], cursor? }` |
| `GET /api/gov/decisions/:id` | Viewer | `Decision` |
| `GET /api/gov/approvals?state=pending` | Viewer | `Approval[]` |
| `POST /api/gov/approvals/:id/approve` / `deny` body `{ note? }` | Approver | `Approval` |
| `GET /api/gov/agents` | Viewer | `(RegisteredAgent & { laneId: string, stats: { decisions, denies, lastSeenAt } })[]` |
| `PATCH /api/gov/agents/:id` body `Partial<RegisteredAgent>` (owner, purpose, laneId, name) | PolicyAdmin | `RegisteredAgent` |
| `POST /api/gov/agents/:id/pause` / `resume` / `quarantine` body `{ reason }` | PolicyAdmin | `RegisteredAgent` |
| `POST /api/gov/sessions/:id/pause` / `resume` / `quarantine` | PolicyAdmin | `SessionIntent` |
| `GET /api/gov/sessions/:id/intent` | Viewer | `SessionIntent \| null` (`null` when the session has no governance state yet) |
| `GET /api/gov/lanes?status=` | Viewer | `LaneRecord[]` |
| `GET /api/gov/lanes/:id` / `GET /api/gov/lanes/:id/versions` | Viewer | `LaneRecord` / `LaneRecord[]` |
| `POST /api/gov/lanes` body `{ yaml }` or `{ lane }`, `status` (`draft`, `proposed` or `active`) | PolicyAdmin (`proposed`: any authenticated) | `LaneRecord` (new version) |
| `POST /api/gov/lanes/:id/versions/:v/activate` / `archive` | PolicyAdmin | `LaneRecord` |
| `POST /api/gov/lanes/validate` body `{ yaml }` | Viewer | `{ ok, errors: string[], lane? }` |
| `POST /api/gov/lanes/simulate` body `{ yaml or lane, from?, to?, agentId?, limit? }` | Viewer | `{ evaluated, wouldAllow, wouldDeny, wouldJudge, wouldApprove, wouldAlert, ruleHits, samples: [{eventId, sessionId, tool, summary, verdict, ruleIds}] }`. Active policies that apply to the lane are merged in. |
| `GET /api/gov/presets` | Viewer | Policy preset catalog `{ filesystem, network, credential, capability, mcpCategory }` ([policies.md](policies.md)) |
| `GET /api/gov/policies?status=` / `GET /api/gov/policies/:id?version=` / `GET /api/gov/policies/:id/versions` | Viewer | `PolicyRecord[]` / `PolicyRecord` / `PolicyRecord[]` |
| `POST /api/gov/policies` body `{ yaml }` or `{ policy }`, `status` | PolicyAdmin (`proposed`: any authenticated) | `PolicyRecord` (new version). Activating a policy that applies to monitor agents needs a human PolicyAdmin. |
| `POST /api/gov/policies/:id/versions/:v/activate` / `archive` | PolicyAdmin | `PolicyRecord` |
| `POST /api/gov/policies/validate` / `simulate` body `{ yaml or policy, from?, to?, limit? }` | Viewer | `{ ok, errors, policy? }` / simulation result |
| `GET /api/gov/policies/effective?laneId=` | Viewer | `{ lane (merged rules), policies, missing }` |
| `GET /api/gov/classifiers` | Viewer | `{ items: Classifier[], config }` ([classifiers.md](classifiers.md)) |
| `PATCH /api/gov/classifiers/:code` body `{ isActive?, enforceable? }` / `PUT /api/gov/classifiers/config` | PolicyAdmin | `Classifier` / `{ items, config }` |
| `POST /api/gov/classifiers/test` body `{ text, codes?, custom? }` | Viewer | `{ detections (masked), errors }` |
| `GET /api/gov/posture/checks` / `PUT /api/gov/posture/config` | Viewer / PolicyAdmin | Check catalog + config ([posture.md](posture.md)) |
| `GET /api/gov/posture/summary` / `findings?state&severity&endpointId&checkId&level` / `findings/:id` | Viewer | Posture summary / `PostureFindingRecord[]` / finding + check |
| `POST /api/gov/posture/findings/:id/suppress` body `{ reason, until? }` / `unsuppress` | PolicyAdmin | `PostureFindingRecord` |
| `POST /api/gov/posture/findings/:id/fix` | human PolicyAdmin | One-click fix on the local endpoint (`409` for other endpoints) |
| `GET /api/gov/posture/endpoints` / `endpoints/:id` | Viewer | Endpoint summaries / full inventory |
| `POST /api/gov/posture/scan` | PolicyAdmin | Scan this device now |
| `POST /api/gov/posture/reports` body `PostureReport` | device, Agent or PolicyAdmin | Ingest a CLI / device report |
| `GET /api/gov/incidents?state=` / `GET /api/gov/incidents/:id` | Viewer | `Incident[]` / `Incident` |
| `POST /api/gov/incidents` (Guardian / manual) | PolicyAdmin or Agent (monitor) | `Incident` |
| `PATCH /api/gov/incidents/:id` | PolicyAdmin or Agent (monitor) | `Incident` |
| `GET /api/gov/audit/verify?from&limit` | Viewer | `AuditVerifyResult` |
| `GET /api/gov/audit/export?from&to` | Viewer | JSON Lines of `Decision` |
| `GET /api/gov/me` | any | `Principal` |
| `GET /api/gov/auth-config` | **public** | `{ mode: 'entra' \| 'local', clientId?, tenantId?, audience? }`: dashboard sign-in bootstrap, no secrets |
| `GET /api/gov/config` | Viewer | `{ mode, judge: {enabled, fast, escalation}, shields: {enabled}, intelligence: {enabled}, auth: <same as auth-config> }` |
| `POST /api/gov/devices/enroll` body `{ deviceId?, ttlDays? }` | PolicyAdmin | `{ token, deviceId, expiresAt }`: device token with roles Agent + Viewer |

### Monitoring fleet — `/api/gov/fleet` ([fleet.md](fleet.md))
| Path | Role | Response |
|---|---|---|
| `POST /api/gov/fleet/alerts` body `{ alerts: FleetAlert[] }` (≤ 500 per call; idempotent on `alert_id`) | Agent or PolicyAdmin (the fleet's identity) | `202 { accepted }`; `400` on malformed alerts |
| `GET /api/gov/fleet/alerts?severity&type&platform&agent&session&incident&since&limit` | Viewer | `FleetAlert[]`, newest first (comma-separated lists for `severity`, `type`, `platform`) |
| `GET /api/gov/fleet/alerts/:id` | Viewer | `FleetAlert` |
| `GET /api/gov/fleet/summary?since` (default: last 7 days) | Viewer | `{ since, total, bySeverity, byType, byPlatform, byAgent, byOwaspAgentic }` |

The fleet writes incidents through `POST` / `PATCH /api/gov/incidents` with trigger `fleet:<alert_type>` and a `fleet` block (alert ids, OWASP/ATLAS mapping, fused score). Its `PATCH` never changes `state`, so analyst triage is preserved.

### TypeSafe Jev shadow — `/api/gov/jev` ([jev.md](jev.md), [scan-methodology.md](scan-methodology.md))
| Path | Role | Response |
|---|---|---|
| `GET /api/gov/jev/summary?since&until&kind` | Viewer | Agreement, latency and cost summary per shadow kind |
| `GET /api/gov/jev/shadow?since&until&kind&sessionId&laneId&agree&limit&cursor` | Viewer | `{ items: JevShadowRecord[], cursor? }` |
| `POST /api/gov/jev/shadow` body `JevShadowInput` | PolicyAdmin or Agent | `201 JevShadowRecord`. Append-only; the server assigns `id` and `createdAt`. Agent-role callers may write only `guardian_triage` and `fleet_*` kinds. |

### Intelligence proxy — `/api/gov/intelligence` (forwards to `INTELLIGENCE_URL`)
| Path | Description |
|---|---|
| `POST /api/gov/intelligence/chat` body `{ messages: [{role, content}], conversationId? }` | Server-Sent Events. Events: `data: {"type":"delta","text":…}`, `{"type":"tool","name":…,"args":…}`, `{"type":"citation","kind":"session"\|"decision"\|"incident","id":…}`, `{"type":"done"}` |
| `POST /api/gov/intelligence/lanes/draft` body `{ agentId, description?, systemPrompt? }` | `{ lane: LaneRecord (status proposed), rationale, simulation }` |
| `POST /api/gov/intelligence/investigate` body `{ incidentId }` or `{ trigger, agentIds, sessionIds, decisionIds }` | `Incident` |

## WebSocket `/live`
Local mode accepts loopback clients and rejects non-loopback browser origins. Remote clients, and all clients in cloud mode, must pass a bearer token with the Viewer role as `?token=<jwt>`, because browsers can't set headers on a WebSocket.

Governance messages are added next to the existing `timeline` and `sessions.updated`:
`{type:"gov.decision", decision}`, `{type:"gov.approval", approval}`, `{type:"gov.agent", agent}`, `{type:"gov.lane", lane:{id,version,status}}`, `{type:"gov.policy", policy:{id,version,status}}`, `{type:"gov.posture", endpointId}`, `{type:"gov.incident", incident}`, `{type:"gov.fleet.alerts", alerts}`.

## MCP server — `/mcp` (Streamable HTTP) and `npm run mcp` (stdio)
Read tools (Viewer): `list_agents`, `get_agent`, `list_sessions`, `get_session_timeline`, `search_actions`, `list_decisions`, `get_decision`, `list_blocked_actions`, `list_pending_approvals`, `list_incidents`, `get_incident`, `list_lanes`, `get_lane`, `simulate_lane`, `list_policies`, `get_policy`, `simulate_policy`, `list_classifiers`, `list_policy_presets`, `list_posture_findings`, `get_endpoint_inventory`, `verify_audit_chain`, `get_overview_stats`.

Governed write tools: `approve_action` / `deny_action` (Approver), and `pause_agent`, `resume_agent`, `quarantine_session`, `propose_lane_change`, `propose_policy`, `create_incident`, `update_incident`, `acknowledge_incident` (PolicyAdmin, or Agent for the monitor's own Guardian). Every write tool call first goes to `decide()` with `checkpoint:"admin"`, `agent.surface:"monitor"`. `propose_lane_change` and `propose_policy` always create a `proposed` version and never activate it.
