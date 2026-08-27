# Agent Logs Monitor

A local real-time monitor for AI agent activity. Captures events from multiple agent platforms, stores them in an embedded SQLite database, and streams them to a browser UI over WebSocket.

## Supported sources

| Source | Mechanism | Status |
|---|---|---|
| Claude Code | Push — HTTP hooks | ✓ Active by default |
| Azure AI Foundry | Pull — Agent Service REST API | Enabled via `FOUNDRY_ENDPOINT` |
| Copilot Studio | Pull — Dataverse OData API | Enabled via `DATAVERSE_ORG_URL` |

## Quick start

```powershell
# 1. Install dependencies and compile
npm install
npm run build

# 2. Wire Claude Code hooks (run once)
.\install.ps1

# 3. Start the server
.\start.ps1
# → http://127.0.0.1:4317
```

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
src/
  server.ts               Express entry point; registers collectors; starts pollers
  config.ts               Env var config for each source
  pipeline.ts             Shared upsert + broadcast helper used by push and pull paths
  db.ts                   sql.js (SQLite WASM) wrapper + schema
  store.ts                DB write helpers (upsertSession, upsertAgent, insertEvent)
  broadcast.ts            WebSocket server (/live)
  transcript-watcher.ts   JSONL poller for Claude Code thinking/assistant_text
  collectors/
    types.ts              NormalizedEvent + Collector + PollableCollector interfaces
    registry.ts           Collector map + startPollers()
    claude-code.ts        Push collector (normalize only)
    foundry.ts            Pull collector — Foundry Agent Service REST API
    copilot-studio.ts     Pull collector — Dataverse OData API
  routes/
    ingest.ts             POST /ingest/:collectorId
    api.ts                GET /api/sessions, /api/sessions/:id/tree, /api/events
public/
  index.html              Single-file browser UI (vanilla JS, WebSocket client)
electron/
  main.js                 Electron tray shell (optional desktop app)
```

## Documentation

- [Log Ingestion](docs/log-ingestion.md) — how each source is polled or pushed, event mappings, NormalizedEvent schema, and how to add a new source

## Development

```powershell
npm run dev          # ts-node (no build step)
npm run build        # compile to dist/
npm run electron:dev # Electron + ts-node
```

## Requirements

- Node.js ≥ 18
- For Foundry / Copilot Studio: an Entra ID app registration with appropriate permissions (see [docs/log-ingestion.md](docs/log-ingestion.md))
