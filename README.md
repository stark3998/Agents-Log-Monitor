# Agent Logs Monitor

A real-time **monitoring and governance plane for AI agents**. It captures events from multiple agent platforms, analyzes them for risky actions, sensitive data, MCP servers and external domains, and streams the results to a Material UI dashboard.

It also **governs** agents inline. Each agent works in a *lane* (its purpose, what it may do, and what it must never do). Every tool call is approved, denied, sent to the agent's own permission prompt, or escalated to a human **before it executes**. Decisions combine:

- deterministic lane rules
- a Microsoft Foundry LLM judge that checks the action against the lane, the session goal and the recent trajectory
- prompt-injection taint from Azure AI Content Safety Prompt Shields
- runaway/swarm limits
- human approval (dashboard, Teams, or the agent's native prompt)

Every decision goes into a hash-chained audit log. You can query all of it from any MCP client through the built-in MCP server. See **[docs/governance.md](docs/governance.md)**.

## Governance at a glance

| Capability | Where |
|---|---|
| Inline enforcement for Claude Code, Copilot CLI, Copilot cloud agent, VS Code agent mode | `install.ps1`, [docs/governance-surfaces.md](docs/governance-surfaces.md) |
| MCP gateway that governs any MCP client (Foundry agents, Copilot Studio, IDEs) | `npm run gateway`, [docs/mcp-gateway.md](docs/mcp-gateway.md) |
| SDKs for custom agents: Agent Framework, Semantic Kernel, LangChain, OpenAI Agents | [packages/sdk-ts](packages/sdk-ts/README.md), [packages/sdk-python](packages/sdk-python/README.md) |
| Lanes-as-code, UI editor, AI-drafted lanes, replay against history | [docs/lanes.md](docs/lanes.md) |
| MCP server to ask "what did my agents do, what was blocked and why?" | `/mcp`, `npm run mcp`, [docs/mcp.md](docs/mcp.md) |
| Guardian investigator agent, lane drafter and "Ask the monitor" chat (Python, Agent Framework on Foundry) | [docs/intelligence.md](docs/intelligence.md) |
| Hybrid deployment: local enforcers plus an Azure control plane (Container Apps, Cosmos DB, Redis, Entra ID) | [docs/cloud-mode.md](docs/cloud-mode.md), [infra/README.md](infra/README.md) |
| Entra ID roles, device enrollment, Teams/webhook/email alerts | [docs/security-auth.md](docs/security-auth.md) |

```powershell
npm run eval:redteam   # replays credential-drift, metadata-endpoint, injection, runaway and approval scenarios
```

The built-in lanes start in `observe` mode, which logs would-deny decisions without blocking. Set `mode: enforce` in [lanes/coding-agent.yaml](lanes/coding-agent.yaml) (or in the Lanes page) once the would-deny rate looks right.

## Supported sources

| Source | Mechanism | Channel | Status |
| --- | --- | --- | --- |
| Claude Code | Push — enforcing HTTP hooks | `hook` | ✓ Active after `install.ps1` |
| GitHub Copilot CLI | Pull — tails `~/.copilot/session-state/*/events.jsonl` | `log` | ✓ Active by default when the folder exists |
| GitHub Copilot CLI (hooks) | Push — enforcing command hooks + forwarder | `hook` | Optional: `install.ps1 -CopilotHooks` |
| Azure AI Foundry | Pull — Agent Service REST API | `poll` | Enabled via `FOUNDRY_ENDPOINT` |
| Copilot Studio | Pull — Dataverse OData API | `poll` | Enabled via `DATAVERSE_ORG_URL` |

Every event is labelled with the channel it arrived through. When Copilot CLI hooks and the Copilot CLI log report the same action, the two are merged into one entry marked **log + hook**. Governance hooks now call the Policy Decision Point before returning native allow/deny/ask decisions; the legacy `/ingest` endpoints remain available for backward compatibility.

## The dashboard

- **Overview:** KPI cards (active agents, sessions, sessions with sensitive data, risky actions, blocked/warned actions), each with the change since the previous period and a sparkline. Also shows an activity trend chart, a Top Agents table, and a heatmap of the MCP servers and external domains each agent reached. Every card, row and heatmap cell opens a filtered conversation list.
- **Conversations:** a filterable, sortable table with agent, endpoint, user, severity, autonomy, detected data, enforcement and channel. Clicking a row opens a resizable, deep-linkable drawer (`?c=<id>`) with the full chat timeline:
  - prompts and markdown replies, with reasoning collapsed
  - consecutive tool calls grouped, each expandable to its request and response
  - subagent threads
  - search within the conversation (Ctrl+F, Enter / Shift+Enter)
  - All / Messages / Tools / Findings filters
  - live follow with a jump-to-latest button
  - Markdown or JSON export
- **Enforcements:** a read-only list of policy events: blocked tool calls, permission denials, permission prompts, and warnings for critical-risk actions.
- **Other features:**
  - dark theme by default, plus a light theme
  - live status indicator
  - Sources dialog showing collector health and setup steps
  - alerts for high-severity conversations
  - export of activity logs as CSV or JSON Lines
  - animations are reduced when the OS asks for reduced motion

How findings, risk and severity are computed: [docs/analytics.md](docs/analytics.md).

## Quick start

```powershell
# 1. Install dependencies (also installs web/ deps) and build server + UI
npm install
npm run build

# 2. Wire Claude Code governance hooks (and optionally Copilot CLI hooks)
.\install.ps1                 # or: .\install.ps1 -CopilotHooks

# 3. Start the server
.\start.ps1
# → http://127.0.0.1:4317
```

On first start, Copilot CLI sessions from the last 7 days (`COPILOT_CLI_IMPORT_DAYS`) are imported in the background. The dashboard fills in as the import runs.

### Enable Azure AI Foundry

```powershell
$env:FOUNDRY_ENDPOINT   = "https://xxx.services.ai.azure.com/api/projects/myproject"
$env:AZURE_CLIENT_ID     = "<client-id>"
$env:AZURE_CLIENT_SECRET = "<secret>"
$env:AZURE_TENANT_ID     = "<tenant-id>"
.\start.ps1
```

### Enable Copilot Studio

```powershell
$env:DATAVERSE_ORG_URL   = "https://myorg.crm.dynamics.com"
$env:AZURE_CLIENT_ID     = "<client-id>"
$env:AZURE_CLIENT_SECRET = "<secret>"
$env:AZURE_TENANT_ID     = "<tenant-id>"
# Optional: filter to a single bot
$env:COPILOT_BOT_ID      = "<bot-guid>"
.\start.ps1
```

The Entra ID app registration used for Copilot Studio must have an **Application User** in the Dataverse environment with the **Bot Transcript Viewer** security role.

## Architecture

```
src/                        Node/Express server (TypeScript, node:sqlite)
  server.ts                 Entry point; registers collectors; starts pollers; mounts governance; serves the SPA
  config.ts                 Env var config for each source
  pipeline.ts               Shared ingest path: session/agent upsert → analysis → insert → live broadcast
  db.ts                     node:sqlite wrapper (WAL), schema/migrations, statement cache
  store.ts                  DB write helpers + hook↔log channel correlation
  queries.ts                Read models: overview KPIs, agents, connections, conversations, enforcements
  timeline.ts               Events → compact conversation timeline items (+ live updates)
  broadcast.ts              WebSocket server (/live)
  transcript-watcher.ts     JSONL poller for Claude Code thinking/assistant_text
  analytics/                classify, domains, detectors, risk, severity, identity, analyze
  collectors/               claude-code, copilot-cli (+hooks), foundry, copilot-studio
  routes/                   /ingest/:collectorId, /api/* read models
  governance/               Governance plane
    types.ts, contracts.ts  Shared domain model and module contracts
    pdp.ts                  Policy Decision Point (tiered pipeline)
    lanes/                  Lane loader (YAML/zod), rule engine, simulation
    judge/, shields/        Foundry LLM judge, Prompt Shields
    intent/, limits/        Session goal/trajectory/taint, runaway limits
    registry/, approvals/   Agent registry & kill switch, human approvals
    hooks/                  /hooks/:surface native adapters (Claude Code, Copilot, VS Code)
    routes/                 /v1 PDP API, /api/gov admin API, intelligence proxy, device enrollment
    mcp/                    Monitor MCP server (/mcp, stdio)
    store/                  GovernanceStore: SQLite (local) / Cosmos (cloud), hash-chained audit
    sync/, runtime/         Local↔cloud sync, Redis backends
    alerts/, auth.ts        Teams/webhook/email alerts, Entra ID auth
  gateway/                  Governance MCP gateway (proxy)
lanes/                      Lanes-as-code (default, coding-agent, monitor-guardian)
packages/                   sdk-ts, sdk-python
intelligence/               Python service: Guardian, lane drafter, chat (Microsoft Agent Framework)
infra/terraform/            Azure control plane IaC
web/                        React + Vite + MUI dashboard (builds into public/)
scripts/                    Copilot CLI hook forwarders, judge eval
templates/                  Copilot cloud agent / VS Code hook templates, Teams app manifest
test/                       Backend, governance and red-team scenario tests
electron/                   Electron tray shell (optional desktop app)
```

## Development

```powershell
npm run dev          # API server with ts-node on :4317
npm run dev:web      # Vite dev server on :5173 (proxies /api and /live to :4317)
npm run build        # compile server to dist/ and the UI to public/
npm test             # backend unit tests (vitest)
npm run test:web     # UI unit tests (vitest + Testing Library)
npm run electron:dev # Electron + ts-node
```

Set `AGENT_MONITOR_DB` to use a different database file, and `PORT` to change the port.

### Hook enforcement surfaces

`install.ps1` rewires Claude Code to `/hooks/claude-code` with blocking timeouts and can also install Copilot CLI, machine-wide Copilot policy, or VS Code Local hooks:

```powershell
.\install.ps1 -CopilotHooks -VSCodeHooks -FailMode open
# Elevated PowerShell only:
.\install.ps1 -CopilotPolicyHooks -FailMode closed
```

For macOS/Linux Claude Code and Copilot CLI setup, use `./install.sh --copilot-hooks`. For Copilot cloud agent and VS Code repository templates, see [Governance hook surfaces](docs/governance-surfaces.md).

## Documentation

- [Governance](docs/governance.md): lanes, checkpoints, the decision pipeline, modes, fail modes, configuration
- [Lanes reference](docs/lanes.md): schema, rule conditions, defaults, rollout workflow
- [Governance API](docs/governance-api.md): `/v1` PDP API, `/api/gov` admin API, WebSocket and MCP contracts
- [Hook surfaces](docs/governance-surfaces.md), [MCP server](docs/mcp.md), [MCP gateway](docs/mcp-gateway.md), [Intelligence service](docs/intelligence.md)
- [Cloud mode](docs/cloud-mode.md), [Security & auth](docs/security-auth.md), [Infrastructure](infra/README.md)
- [Log Ingestion](docs/log-ingestion.md): how each source is polled or pushed, event mappings, capture channels, the `NormalizedEvent` schema, and how to add a new source
- [Analytics](docs/analytics.md): detectors, risk rules, policy events, severity and autonomy

## Requirements

- Node.js ≥ 22.5 (built-in `node:sqlite`)
- Python ≥ 3.10 for the optional intelligence service and Python SDK
- For Foundry / Copilot Studio: an Entra ID app registration with appropriate permissions (see [docs/log-ingestion.md](docs/log-ingestion.md))
- For the LLM judge / Guardian: a Microsoft Foundry project with model deployments, plus the *Cognitive Services OpenAI User* role for the identity running the monitor
