# Agent Monitor MCP server

The monitor exposes its governance plane as MCP over:

- Streamable HTTP: `POST/GET/DELETE http://127.0.0.1:4317/mcp`
- stdio: `npm run build:server && npm run mcp`

MCP clients can inspect what agents did, why actions were allowed/blocked/escalated, and perform governed admin actions. All write tools first call the PDP with `checkpoint:"admin"`.

## Connect

### VS Code `mcp.json`

```json
{
  "servers": {
    "agent-monitor": {
      "url": "http://127.0.0.1:4317/mcp"
    }
  }
}
```

### Claude Code

```powershell
claude mcp add agent-monitor http://127.0.0.1:4317/mcp
```

For stdio:

```powershell
claude mcp add agent-monitor -- npm run mcp
```

### Copilot CLI

Add an MCP server named `agent-monitor` pointing at `http://127.0.0.1:4317/mcp`, or use the command transport `npm run mcp` after building.

### Foundry / cloud clients

Configure an MCP tool endpoint at `https://<control-plane>/mcp`. In cloud mode send an Entra bearer token for the configured `ENTRA_API_AUDIENCE`. The protected resource metadata endpoint is:

```text
https://<control-plane>/.well-known/oauth-protected-resource
```

## Auth

Local mode trusts loopback clients when `GOVERNANCE_TRUST_LOOPBACK` is enabled and rejects non-local `Origin` headers to reduce DNS rebinding risk. Cloud mode requires:

```http
Authorization: Bearer <access token>
```

Roles:

- `Viewer`: read tools
- `Approver`: `approve_action`, `deny_action`
- `PolicyAdmin`: `resume_agent` and unrestricted admin/incident handling
- Guardian containment principal: role `Agent`, kind `agent`, and id listed in `GOVERNANCE_GUARDIAN_PRINCIPALS`; may pause agents, quarantine sessions, and create/update/acknowledge incidents, but may not resume agents or dismiss/resolve incidents
- `Viewer`: `propose_lane_change` (10 proposals/hour/principal, always saves `proposed`; monitor Guardian lanes require a user `PolicyAdmin`)

## Tool catalog

| Tool | Role | Purpose |
|---|---:|---|
| `list_agents` | Viewer | Page through registered agents with optional status/surface filters. |
| `get_agent` | Viewer | Fetch a single registered agent. |
| `list_sessions` | Viewer | List monitored sessions from SQLite telemetry. |
| `get_session_timeline` | Viewer | Return compact redacted action records for a session. |
| `search_actions` | Viewer | Search actions by session, agent, tool, category, risk, text and time. |
| `list_decisions` | Viewer | Query governance decisions with cursor pagination. |
| `get_decision` | Viewer | Fetch one decision and its audit metadata. |
| `list_blocked_actions` | Viewer | Show denied and observe-mode would-deny decisions. |
| `list_pending_approvals` | Viewer | Show pending approvals. |
| `list_incidents` | Viewer | List Guardian/manual incidents. |
| `get_incident` | Viewer | Fetch one incident. |
| `list_lanes` | Viewer | List latest lane records by status. |
| `get_lane` | Viewer | Fetch active or versioned lane record. |
| `simulate_lane` | Viewer | Validate a lane and sample matching actions for review. |
| `verify_audit_chain` | Viewer | Verify the hash-chained decision log. |
| `get_overview_stats` | Viewer | Summarize decisions, approvals, incidents and agent states. |
| `approve_action` | Approver | Governed approval resolution to `approved`. |
| `deny_action` | Approver | Governed approval resolution to `denied`. |
| `pause_agent` | PolicyAdmin/Guardian | Governed pause of a registered agent. |
| `resume_agent` | PolicyAdmin | Governed resume of a registered agent. |
| `quarantine_session` | PolicyAdmin/Guardian | Governed quarantine of a session intent. |
| `propose_lane_change` | Viewer | Validate YAML/JSON and save as `proposed` only. |
| `create_incident` | PolicyAdmin/Guardian | Create an incident. |
| `update_incident` | PolicyAdmin/Guardian | Patch an incident. |
| `acknowledge_incident` | PolicyAdmin/Guardian | Mark an open incident as investigating. |

Resources:

- `lane://{id}`
- `incident://{id}`

Prompt:

- `investigate_incident(incidentId)`

## Example questions

- “Which agents were paused or quarantined today?”
- “Show denied actions for session `s-123` and explain why.”
- “What pending approvals involve PowerShell or network access?”
- “Read `incident://<id>` and propose a lane change, but do not activate it.”
