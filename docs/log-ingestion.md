# Log Ingestion

How Agent Monitor captures events from each agent platform, normalises them into a common schema, and delivers them to the UI in real time.

## Pipeline overview

```
Sources                            Shared pipeline
───────                            ───────────────
Claude Code        ──POST /ingest──►
Copilot CLI hooks  ──POST /ingest──►   Collector.normalize()
Copilot CLI log    ──poll()────────►       │
AI Foundry         ──poll()────────►   pipeline.ts
Copilot Studio     ──poll()────────►     upsertSession → upsertAgent → analyzeEvent (raw content)
                                         → redactDeep → insertEvent → reconcileDenials
                                         → insertFindings → correlateChannels
                                           │
                                       SQLite via node:sqlite (agent-monitor.db, WAL;
                                       checkpoints on a worker thread)
                                           │
                                       WebSocket broadcast (/live) → web UI (web/ → public/)
```

Push sources post directly to the HTTP ingest endpoint. Pull sources are called on a timer by the polling engine (`startPollers()` in `src/collectors/registry.ts`). Events are written in transactions of 400. Between slices the registry yields to the event loop and truncates the write-ahead log once it passes 64 MB. A collector that reports `hasBacklog()` is polled again right away, so large imports progress steadily without blocking the HTTP server. Both paths converge at `processNormalizedEvent()` in `src/pipeline.ts`. It analyzes the raw content, then redacts the payload according to `REDACT_PAYLOADS` before storing it (see [analytics.md](analytics.md)).

Every stored event records its **capture channel** (`events.capture_channel`):

| Channel | Meaning |
|---|---|
| `hook` | Pushed in real time by an agent hook (Claude Code, Copilot CLI hooks) |
| `log` | Read from an agent's local session log (Copilot CLI `events.jsonl`, Claude Code transcript) |
| `poll` | Pulled from a cloud API (Foundry, Copilot Studio) |

The UI shows the channel on every conversation and tool call.

---

## Sources

### Claude Code

**Mechanism:** Push — HTTP webhook  
**Collector:** `src/collectors/claude-code.ts`  
**Endpoint:** `POST http://127.0.0.1:4317/ingest/claude-code`  
**Auth:** None (server binds to localhost only)

`install.ps1` writes nine hook entries into `~/.claude/settings.json`. Claude Code fires each hook synchronously; the server responds `200 {ok:true}` immediately and processes the payload on the next tick so Claude Code never waits.

A secondary data source runs in parallel: when a session arrives with a `transcript_path`, `src/transcript-watcher.ts` polls the JSONL file every 800 ms and extracts `thinking` and `assistant_text` content blocks that are not visible in the hook events.

**Hook events → eventType mapping:**

| Hook event | eventType | Notes |
|---|---|---|
| `PreToolUse` | `tool_call` | status: `pending` |
| `PostToolUse` | `tool_result` | links back via `tool_use_id`; computes `durationMs` |
| `UserPromptSubmit` | `prompt` | carries `usage` tokens |
| `Notification` | `notification` | |
| `SubagentStart` | `lifecycle` | creates an agent row with `parent_agent_id` |
| `SubagentStop` | `lifecycle` | marks agent `completed` or `failed` |
| `Stop` / `SessionEnd` | `lifecycle` | sets `sessions.ended_at` |
| Transcript: thinking block | `thinking` | from JSONL watcher |
| Transcript: text block | `assistant_text` | from JSONL watcher |

**Configuration:** Run `install.ps1` once. No environment variables needed.

---

### GitHub Copilot CLI

Copilot CLI is captured through two channels. The log channel is primary and needs no setup; hooks are optional.

#### Log channel (primary)

**Mechanism:** Pull — tails the CLI's per-session event log  
**Collector:** `src/collectors/copilot-cli.ts`  
**Files:** `$COPILOT_HOME/session-state/<sessionId>/events.jsonl` (default `COPILOT_HOME` = `~/.copilot`)

Each line is `{ type, data, id, timestamp, agentId? }`. The collector keeps a byte offset per file in `poller_state`, reads at most ~2 MB per poll (so the first import is progressive), skips high-volume/no-value types before parsing (`hook.*`, `system.message`, `session.binary_asset`, …) and stores a **trimmed** payload (long strings clipped; tool output ≤ 3 KB). Sensitive-data detection runs on the full text before trimming. Event timestamps come from the log, and `externalId = copilot-cli:<session>:<event id>` makes re-reads idempotent.

| Log event | eventType / rawEventName | Notes |
|---|---|---|
| `session.start` / `session.resume` | `lifecycle` SessionStart / SessionResume | cwd, repository, branch, model |
| `session.shutdown` | `lifecycle` SessionEnd | token totals, lines changed |
| `session.model_change` | `lifecycle` ModelChange | |
| `session.mode_changed` | `lifecycle` ModeChange | `autopilot` → autonomy 3 |
| `session.permissions_changed` | `lifecycle` PermissionsChange | allow-all on → autonomy 3 |
| `user.message` | `prompt` | first prompt becomes the conversation title |
| `assistant.message` | `assistant_text` (+ `thinking` from `reasoningText`) | |
| `tool.execution_start` | `tool_call` | `toolUseId = toolCallId`; `mcpServerName` marks MCP tools; `agentId` set inside subagents |
| `tool.execution_complete` | `tool_result` | success / error, exit code, trimmed output |
| `subagent.started` / `completed` / `failed` | `lifecycle` SubagentStart / SubagentStop | display name, type, model |
| `permission.requested` / `completed` | `lifecycle` PermissionRequest / PermissionResult | recorded as policy findings (prompted / approved / denied) |
| `abort` | `lifecycle` Abort | |

**Configuration:**

| Variable | Default | Purpose |
|---|---|---|
| `COPILOT_CLI_ENABLED` | on (if the folder exists) | Set `false` to disable |
| `COPILOT_HOME` | `~/.copilot` | CLI home folder |
| `COPILOT_CLI_IMPORT_DAYS` | `7` | On first sight, only logs modified within this window are imported |
| `COPILOT_CLI_POLL_INTERVAL_MS` | `2000` | Tail interval |

#### Hook channel (optional)

**Mechanism:** Push — Copilot CLI command hooks → forwarder script  
**Collector:** `src/collectors/copilot-cli-hooks.ts`  
**Endpoint:** `POST http://127.0.0.1:4317/ingest/copilot-cli-hooks`  
**Setup:** `.\install.ps1 -CopilotHooks` writes `~/.copilot/hooks/agent-monitor.json`

The config registers PascalCase events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop`, `ErrorOccurred`), so payloads arrive in the VS Code–compatible snake_case format. Each hook runs `scripts/copilot-hook-forward.ps1` (or `.sh`), which POSTs stdin to the ingest endpoint with a 2 s timeout, **prints nothing and always exits 0**: command `preToolUse` hooks are fail-closed, so a failing forwarder would otherwise block tool calls. Each hook starts a short PowerShell process, so expect a small per-tool-call overhead.

**Correlation:** a hook event and its log twin (same session and event type, same canonical tool name such as `Bash` ↔ `powershell` or `Read` ↔ `view`, the same command/path when both carry one, within ±15 s) are linked by `events.correlated_event_id` on the hook row. Linked hook rows are excluded from all counts and hidden in the timeline; the log row shows a **log + hook** badge. Hook events with no log twin stay visible with a **hook** badge.

---

### Azure AI Foundry

**Mechanism:** Pull — Foundry Agent Service REST API  
**Collector:** `src/collectors/foundry.ts`  
**Default interval:** 60 seconds (`FOUNDRY_POLL_INTERVAL_MS`)  
**Auth:** `DefaultAzureCredential`, scope `https://ai.azure.com/.default` (Foundry project endpoints reject the older `cognitiveservices.azure.com` audience)

Foundry has no webhooks. Each poll fetches threads in descending order and stops when it reaches the last-seen thread cursor (persisted in the `poller_state` DB table across restarts). For each new thread it lists runs; for each terminal run (`completed` or `failed`) it fetches the ordered run steps. Steps of type `tool_calls` become tool-call events; `message_creation` steps become assistant-text events.

Every event carries an `externalId` (e.g. `foundry:step:{stepId}:{tcId}`). The pipeline checks for an existing row with that ID and skips duplicates — so a server restart is safe.

**API calls per poll cycle** (all with `api-version=v1`, relative to the project endpoint):
```
GET {endpoint}/threads?limit=100&order=desc
  └─ GET /threads/{id}/runs?limit=100&order=desc        (per new thread)
       └─ GET /threads/{id}/runs/{id}/steps?limit=100   (per terminal run)
```

**Event mapping:**

| Foundry concept | eventType | rawEventName | Notes |
|---|---|---|---|
| Thread | — | — | → session row (`source: foundry`) |
| Run completed | `lifecycle` | `RunCompleted` | carries `inputTokens`, `outputTokens`, `model` |
| Run failed | `lifecycle` | `RunFailed` | `errorText` from `last_error.message` |
| Run step — tool_calls | `tool_call` | `RunStepToolCall` | one event per tool call; `durationMs` from step timestamps |
| Run step — message_creation | `assistant_text` | `RunStepMessage` | |

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `FOUNDRY_ENDPOINT` | Yes | — | Full project endpoint, e.g. `https://xxx.services.ai.azure.com/api/projects/myproject` |
| `FOUNDRY_POLL_INTERVAL_MS` | No | `60000` | Poll interval in ms |
| `AZURE_CLIENT_ID` | SPN only | — | Service Principal client ID |
| `AZURE_CLIENT_SECRET` | SPN only | — | Service Principal secret |
| `AZURE_TENANT_ID` | SPN only | — | Entra ID tenant ID |

Setting `FOUNDRY_ENDPOINT` enables this collector. With no env vars set the server starts in Claude Code-only mode.

---

### Copilot Studio

**Mechanism:** Pull — Dataverse OData Web API  
**Collector:** `src/collectors/copilot-studio.ts`  
**Default interval:** 5 minutes (`COPILOT_POLL_INTERVAL_MS`)  
**Auth:** `DefaultAzureCredential`, scope `{DATAVERSE_ORG_URL}/.default`

Copilot Studio writes transcripts to the Dataverse `conversationtranscripts` table approximately **30 minutes** after a conversation goes inactive. Each poll filters on `createdon > lastPolledTime` and advances the cursor after a successful batch.

A single long conversation may be split across multiple Dataverse records sharing the same `name` and `conversationstarttime` but with different `BatchId` values in their `metadata` JSON. The collector merges these by sorting on `BatchId` and concatenating `content` arrays before normalising.

Every event gets an `externalId` (e.g. `cs:{transcriptId}:msg:{activityId}`) for cross-restart deduplication.

**OData query per poll:**
```
GET {orgUrl}/api/data/v9.2/conversationtranscripts
  ?$filter=createdon gt {lastPolledTime}
  &$orderby=createdon asc
  &$select=conversationtranscriptid,name,createdon,conversationstarttime,content,metadata
  &$top=100
```

**Event mapping:**

| Activity / valueType | eventType | rawEventName | Notes |
|---|---|---|---|
| Transcript record | — | — | → session row (`source: copilot-studio`) |
| Start (synthesised) | `lifecycle` | `SessionStart` | first event created per conversation |
| `valueType: SessionInfo` with EndTime | `lifecycle` | `SessionEnd` | `status: error` if outcome is `Escalated` |
| `valueType: IntentRecognition` | `lifecycle` | `TopicTriggered` | one per topic match |
| `type: message`, `from.role = 1` (user) | `prompt` | `UserMessage` | |
| `type: message`, `from.role = 0` (bot) | `assistant_text` | `BotMessage` | |

**Dataverse permissions required:** The Entra ID app registration must have an **Application User** in the Dataverse environment with the **Bot Transcript Viewer** security role.

**Environment variables:**

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATAVERSE_ORG_URL` | Yes | — | Dataverse org root URL, e.g. `https://myorg.crm.dynamics.com` |
| `COPILOT_BOT_ID` | No | — | Filter to a specific bot GUID. Empty = all bots in the environment |
| `COPILOT_POLL_INTERVAL_MS` | No | `300000` | Poll interval in ms. Lowering below 5 min wastes API quota — transcripts appear 30 min after conversation end |
| `AZURE_CLIENT_ID` | SPN only | — | Service Principal client ID |
| `AZURE_CLIENT_SECRET` | SPN only | — | Service Principal secret |
| `AZURE_TENANT_ID` | SPN only | — | Entra ID tenant ID |

Setting `DATAVERSE_ORG_URL` enables this collector.

---

## NormalizedEvent schema

All collectors produce this shape (`src/collectors/types.ts`). The pipeline analyzes it, redacts the payload, writes it to SQLite, and broadcasts a compact timeline update over WebSocket.

| Field | Optional | Description |
|---|---|---|
| `sessionId` | No | Maps to a sessions row. Claude Code: `session_id` from hook. Foundry: `thread.id`. Copilot: `conversationtranscriptid`. |
| `agentId` | No | Sub-agent identifier. `"main"` unless a Claude Code `SubagentStart` introduced a child agent. |
| `parentAgentId` | Yes | Parent agent's ID for nested agents. |
| `eventType` | No | `tool_call` · `tool_result` · `prompt` · `lifecycle` · `notification` · `thinking` · `assistant_text` · `terminal_chunk` |
| `rawEventName` | No | Source-native name: `PreToolUse`, `RunCompleted`, `TopicTriggered`, etc. Preserved for debugging. |
| `toolName` | Yes | Name of the tool called (Claude Code tool name or Foundry function name). |
| `toolUseId` | Yes | Correlation ID linking a `tool_call` to its `tool_result`. Used to compute `durationMs` and `parent_event_id`. |
| `externalId` | Yes | Platform-native stable ID. Prevents duplicate inserts when a poller replays a batch after restart. |
| `status` | Yes | `pending` · `success` · `error` · `blocked` |
| `durationMs` | Yes | Milliseconds between paired events (PreToolUse→PostToolUse, or step `created_at`→`completed_at`). |
| `inputTokens` / `outputTokens` | Yes | Token usage from the underlying model call, where available. |
| `cacheReadInputTokens` | Yes | Claude prompt cache read tokens. |
| `errorText` | Yes | Error message text (PostToolUse `error`, run `last_error.message`). |
| `model` | Yes | Model identifier (e.g. `claude-sonnet-4-6`). Used by the UI for cost estimation. |
| `payload` | No | Source object: trimmed for high-volume sources, and redacted per `REDACT_PAYLOADS` before storage. Shown in the tool detail view. |
| `occurredAt` | No | ISO 8601 timestamp. Claude Code: server receive time. Copilot CLI / Foundry / Copilot Studio: platform timestamp. |
| `captureChannel` | Yes | `hook` · `log` · `poll`; defaulted from the collector when omitted. |
| `scanText` | Yes | Full text used for sensitive-data detection when `payload` is trimmed. Never stored. |
| `autonomyLevel` | Yes | 1 supervised · 2 assisted · 3 autonomous, when the source reports a permission mode. |
| `policy` | Yes | Explicit policy outcome (`blocked` · `denied` · `warned` · `prompted` · `approved`) and label. |
| `cwd` | Yes | Working directory when not present as `payload.cwd`. |

---

## Adding a new source

1. **Create `src/collectors/my-source.ts`** implementing `PollableCollector` (pull) or `Collector` (push). Set `id`, `displayName`, `pollIntervalMs`. Implement `normalize()` (return `[]` for pull-only) and `poll(): Promise<NormalizedEvent[]>`.

2. **Assign `externalId`** to every event — the platform's native ID prefixed with your source name (e.g. `mysrc:event:123`). The pipeline skips duplicates on this key, making `poll()` safely idempotent across restarts.

3. **Persist cursors** using `getPollerState(this.id, 'key', default)` / `setPollerState(this.id, 'key', value)` from `src/store.ts`. These read/write the `poller_state` table in SQLite.

4. **Register in `src/server.ts`** — guard the import with a config flag and call `register(myCollector)` before `startPollers()`. Add the corresponding entry in `src/config.ts`.

5. **Give the agent an identity** — add the collector id to the `AGENTS` map in `src/analytics/identity.ts` (display name and kind), add it to `LOCAL_COLLECTORS` if it runs on this machine, and add an icon/colour in `web/src/components/AgentAvatar.tsx`. Add a row to the Sources list in `src/routes/api.ts` (`GET /api/sources`).

6. **Large backfills** — implement `hasBacklog()` and cap the work per `poll()` so the registry drains the backlog in slices.
