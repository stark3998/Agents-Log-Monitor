# Analytics

Every ingested event runs through `analyzeEvent()` (`src/analytics/analyze.ts`) before it is stored. The analysis adds columns to `events` (`category`, `mcp_server`, `risk_level`, `analysis_version`) and rows to the `findings` table. The dashboard's KPIs, Data and Enforcement columns, heatmap, and severity all come from these results.

All rules are heuristics. They are advisory and easy to tune, and on their own they block nothing. Inline enforcement is done by the governance plane ([governance.md](governance.md)). Its lanes reuse these risk rules, detectors and domains as rule conditions ([lanes.md](lanes.md)).

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

Hostnames are taken from URLs and `git@host:` remotes in a tool call's **input** (tool output is not scanned for domains). Localhost, private IP ranges, and `.local`/`.internal` hosts are ignored. Each domain becomes a `domain` finding, which feeds the "What agents connect to" heatmap.

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

Placeholders are ignored (for example `${VAR}`, `<token>`, `xxxx`, `$env:`, `process.env`), and so are well-known non-personal emails.

**Privacy:** findings store only a **masked sample** (`ghp_****a1f3`, `j***@contoso.com`), never the raw secret. Payloads from push hooks are still stored as received. Copilot CLI payloads are trimmed.

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

## Session severity — `severity.ts`

`scoreSession()` rates a conversation using the first tier that matches. It also returns every contributing signal as a reason, which the UI shows under "Why High?":

| Severity | When |
|---|---|
| Critical | any critical-risk action, or secrets detected together with ≥ 3 high-risk actions |
| High | any high-risk action, or ≥ 5 secret detections |
| Medium | any secret detection, any blocked/denied action, or ≥ 10 medium-risk actions |
| Low | medium-risk actions, personal data, or external domains |
| Info | none of the above |

## Autonomy

| Level | Label | Claude Code `permission_mode` | Copilot CLI |
|---|---|---|---|
| 1 | Supervised | `default`, `plan` | interactive mode |
| 2 | Assisted | `acceptEdits` | — |
| 3 | Autonomous | `bypassPermissions` | allow-all permissions on, or `autopilot` mode |

A session keeps the highest level observed.

## Identity

For local collectors (Claude Code, Copilot CLI), **user** is `git config --global user.email`, falling back to the OS user name. **Endpoint** is the machine's hostname.

## Re-analysis

Bump `ANALYSIS_VERSION` in `analyze.ts` after changing rules. On startup, `startAnalysisBackfill()` re-analyzes stored events in batches of 500. Re-analysis sees only the stored payload, so for trimmed sources it can miss detections that the full `scanText` would have caught at ingest.
