# Analytics

Every ingested event runs through `analyzeEvent()` (`src/analytics/analyze.ts`) before it is stored. The analysis adds columns to `events` (`category`, `mcp_server`, `risk_level`, `analysis_version`) and rows to the `findings` table. The dashboard's KPIs, Data and Enforcement columns, heatmap, and severity all come from these results.

All rules are heuristics. They are advisory, tunable through [`agent-monitor.rules.json`](#tuning--agent-monitorrulesjson), and on their own they block nothing. Inline enforcement is done by the governance plane ([governance.md](governance.md)). Its lanes reuse these risk rules, detectors and domains as rule conditions ([lanes.md](lanes.md)).

## Tool classification — `classify.ts`

| Category | Examples |
|---|---|
| `READ` | `view`/`Read`, `grep`/`Grep`, `glob`/`Glob`, `get_*`, `list_*` |
| `WRITE` | `edit`, `create`, `Write`, `Edit`, `apply_patch` |
| `EXEC` | `bash`/`powershell`/`Bash`, `read_powershell` |
| `NETWORK` | `web_fetch`/`WebFetch`, `web_search` |
| `AGENT` | `task`/`Agent`, `read_agent` |
| `MCP` | any MCP tool: `mcp__<server>__<tool>` (Claude Code) or `mcpServerName` (Copilot CLI) |

`canonicalToolName()` maps Copilot CLI runtime names and Claude Code names to one name. Hook↔log correlation uses it too.

## External domains — `domains.ts`

Hostnames are taken from URLs and `git@host:` remotes in a tool call's **input** (tool output is not scanned for domains). Localhost, private IP ranges, `.local`/`.internal` hosts, and hosts listed under `domains.ignore` in the rules file are ignored. Each domain becomes a `domain` finding, which feeds the "What agents connect to" heatmap.

## Sensitive-data detectors — `detectors.ts`

Detectors scan prompts, tool inputs and tool outputs, up to 256 KB per event. For trimmed sources they scan the full original text (`scanText`).

| Key | Label | Class |
|---|---|---|
| `private_key` | Private Key | secret |
| `github_token` | Secret Key (GitHub) | secret |
| `aws_key` | Secret Key (AWS) | secret |
| `ai_key` | Secret Key (AI provider) | secret |
| `slack_token` | Secret Key (Slack) | secret |
| `google_key` | Secret Key (Google) | secret |
| `azure_conn` | Azure Connection String | secret |
| `jwt` | JSON Web Token | secret |
| `env_secret` | Secret in env var (`*_TOKEN=`, `*_SECRET=`, `API_KEY=` …) | secret |
| `password_url` | Password in URL | secret |
| `email` | Email Address | pii |

Placeholders are ignored (for example `${VAR}`, `<token>`, `xxxx`, `$env:`, `process.env`), and so are well-known non-personal emails and values that are already masked.

**Privacy:** findings store only a **masked sample** (`ghp_****a1f3`, `j***@contoso.com`), never the raw secret. Stored payloads are redacted too (see [Payload redaction](#payload-redaction--redactts)).

## Payload redaction — `redact.ts`

Payloads are analyzed first and redacted afterwards, so detection always sees the full content. After that, every string in the payload, the tool error text, the conversation title, and Claude Code transcript text are masked before anything is written to disk.

| `REDACT_PAYLOADS` | Masks |
|---|---|
| `secrets` (default) | secret-class values (all detectors above except `email`). Private key blocks become `-----BEGIN … PRIVATE KEY----- [REDACTED] -----END … PRIVATE KEY-----` |
| `all` | secrets **and** email addresses (`j***@contoso.com`) |
| `off` | nothing; payloads are stored as received |

Key/value pairs such as `{ "API_KEY": "abc123…" }` are masked even when they don't appear as `API_KEY=…` text. Redaction masks values whether or not their detector is disabled in the rules file.

Each event records the level it was stored with (`events.redaction`). When the configured level is **higher** than a row's, the background pass redacts that row on the next start. Lowering the level cannot restore values that were already masked. Rows redacted before re-analysis keep the detections recorded at ingest, because the masked text can no longer be scanned.

## Risk rules — `risk.ts`

Rules are evaluated per tool call. The most severe hit becomes `events.risk_level`, and every medium-or-higher hit becomes a `risk` finding.

| Level | Rules |
|---|---|
| critical | recursive delete of root/home, remote script piped to a shell, disk format/wipe, disabling security tooling, secret sent over the network |
| high | force push, destructive git (`reset --hard`, `clean -f`, `branch -D`), reading credential material (`.env`, SSH keys, `.aws/credentials`, `.azure/`, `.npmrc`, `*.pem`), dumping secrets/env, `sudo`/`chmod 777`, dropping DB objects, publishing packages/images |
| medium | recursive force delete, `git push`, package installs, network requests from a shell, deleting cloud resources, dynamic code execution, writes outside the workspace, writing a secret to disk |
| low | fetching external content |

**Risky actions** (KPI, Top Agents) = tool calls with risk `high` or `critical`.

## Policy events

The Enforcements tab and the "Blocked / warned" KPI read `policy` findings:

| Outcome | Source |
|---|---|
| `blocked` | tool event with `status = blocked` |
| `denied` | Copilot CLI `permission.completed` denial, or a tool error such as "denied by the user" |
| `warned` | a tool call that matched a **critical** risk rule |
| `prompted` / `approved` | permission prompts (Copilot CLI permission events, Claude Code permission notifications) |

"Blocked / warned actions" counts `blocked + denied + warned`.

A denial is counted **once**. When the agent reports an explicit permission denial (Copilot CLI `permission.completed`, carrying the `toolCallId`), any denial inferred from the failed tool result for that same call is dropped. This works whichever of the two events arrives first. Agents without explicit permission events, such as Claude Code, still get the denial inferred from the tool error.

## Session severity — `severity.ts`

`scoreSession()` rates a conversation using the first tier that matches. It also returns every contributing signal as a reason, which the UI shows under "Why High?":

| Severity | When |
|---|---|
| Critical | any critical-risk action, or secrets detected together with ≥ 3 high-risk actions |
| High | any high-risk action, or ≥ 5 secret detections |
| Medium | any secret detection, any blocked/denied action, or ≥ 10 medium-risk actions |
| Low | medium-risk actions, personal data, or external domains |
| Info | none of the above |

The three numeric thresholds (3, 5, 10) can be changed in the rules file. Severity is computed when data is read, so threshold changes apply immediately. The UI labels severity as an advisory rating and links to the rules.

## Autonomy

| Level | Label | Claude Code `permission_mode` | Copilot CLI |
|---|---|---|---|
| 1 | Supervised | `default`, `plan` | interactive mode |
| 2 | Assisted | `acceptEdits` | — |
| 3 | Autonomous | `bypassPermissions` | allow-all permissions on, or `autopilot` mode |

A session keeps the highest level observed.

## Identity

For local collectors (Claude Code, Copilot CLI), **user** is `git config --global user.email`, falling back to the OS user name. **Endpoint** is the machine's hostname.

## Tuning — `agent-monitor.rules.json`

All heuristics can be tuned without code changes. The server reads `agent-monitor.rules.json` from the folder containing the database; set `AGENT_MONITOR_RULES` to use another path. Every key is optional:

```json
{
  "risk": {
    "overrides": { "git-push": "low", "pkg-install": "off", "recursive-delete": "high" },
    "custom": [
      { "rule": "prod-kube", "label": "Touches prod cluster", "level": "critical",
        "pattern": "kubectl .*--context\\s+prod", "flags": "i", "target": "command" }
    ]
  },
  "detectors": { "disabled": ["email"] },
  "domains":   { "ignore": ["*.corp.contoso.com", "example.org"] },
  "severity":  { "criticalHighActionsWithSecrets": 3, "highSecretDetections": 5, "mediumRiskActions": 10 }
}
```

| Key | Effect |
|---|---|
| `risk.overrides` | Map a rule id (see the **Detection rules** tab in Settings or `GET /api/settings`) to `critical`, `high`, `medium`, `low` or `off`. Built-in derived rules can be overridden too: `secret-egress`, `write-outside`, `secret-write` and `web-fetch`. |
| `risk.custom` | Extra regex rules. `target` is `command` (shell commands, the default), `path` (file paths in read/write tools) or `any` (the whole tool input as JSON). |
| `detectors.disabled` | Detector keys to skip. Existing findings from those detectors are removed on re-analysis. |
| `domains.ignore` | Exact hosts, or `*.suffix` wildcards, to exclude from domain findings and the heatmap. |
| `severity` | Numeric thresholds for the session severity tiers. |

The file is watched while the server runs. Changes to risk, detector or domain settings mark every stored event for re-analysis, which runs in the background; progress appears in the Detection rules tab. Severity thresholds apply immediately. Invalid entries are ignored and reported in the Detection rules tab; the rest of the file still applies.

## Re-analysis

On startup, and whenever the rules file changes, `startAnalysisBackfill()` compares the stored analysis fingerprint (`ANALYSIS_VERSION` plus a hash of the rules file) with the current one. If they differ, stored events are re-analyzed in batches of 500 on a background pass. The same pass also redacts rows stored with a weaker redaction level. Bump `ANALYSIS_VERSION` in `analyze.ts` when you change built-in rules.

Re-analysis only sees the stored payload. That payload may be trimmed (Copilot CLI) or redacted, so detections recorded at ingest are kept for redacted rows rather than recomputed.
