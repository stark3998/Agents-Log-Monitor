# Endpoint posture

Runtime governance decides on each action. **Posture** looks at how AI agents are *configured* on each developer machine: auto-approve settings, bypass flags, third-party extensions, exposed tokens, unattended schedules and so on. It reports findings with a severity, raises alerts, and gives a fix for each one.

## How it runs

| Runner | How |
|---|---|
| Local server | Scans its own machine 30 s after start, then every `POSTURE_SCAN_INTERVAL_MIN` minutes (default 360; `0` turns it off; off by default in cloud mode). Also **Scan this device** on the Posture page or `POST /api/gov/posture/scan` (PolicyAdmin). |
| CLI | `npm run build` then `npm run posture` (`node dist/posture/cli.js`). Flags: `--json` prints the report, `--post <url> --token <device-token>` sends it to `/api/gov/posture/reports`, `--org-domains a.com,b.com`, `--disable id1,id2`. Exit code `2` when a critical finding is present, so it can gate CI or MDM scripts. |
| Hybrid | Local enforcers with `GOVERNANCE_CONTROL_PLANE_URL` forward each report to the cloud through the sync outbox. |

A scan builds an **inventory**, then runs the checks against it:

- installed agents and versions
- MCP servers from every client config, with package / host identities and [MCP categories](policies.md#rule-conditions)
- IDE and browser AI extensions with their permissions
- scheduled agent tasks
- signed-in accounts

A real scan takes about 10 s. Each collector is isolated: a failure becomes an entry in `inventory.errors` and never aborts the scan.

**Privacy.** Evidence holds key names, file paths, permission bits, versions and **masked** samples only. Secret values are never stored or returned. The Antigravity cookie check reads only the `host_key` column from a temporary copy of the cookie database, never cookie values.

## Findings lifecycle

- Finding id = `sha1(endpointId | checkId | subject)`, so a finding keeps its identity across scans.
- **new → open**. When it stops being reported, it becomes **resolved**. If it comes back, it is **reopened**.
- **Suppressed** findings (reason, optional expiry) stay suppressed on later scans until the expiry passes.
- New and reopened findings at or above `alertMinSeverity` (default `high`) raise a `posture` alert. New **critical** findings open an incident (`incidentOnCritical`, default on).
- **Fleet checks** are recomputed on the server after every report, across all endpoints.

## Configuration

Use **Posture → Checks**, or `PUT /api/gov/posture/config` (PolicyAdmin):

```json
{
  "checks": { "multiple-coding-agents": { "enabled": false },
              "ai-agent-sprawl": { "severity": "high", "scope": { "endpoints": ["build-*"] } } },
  "orgDomains": ["contoso.com"],
  "corporateSaasDomains": ["contoso.atlassian.net"],
  "alertMinSeverity": "high",
  "incidentOnCritical": true
}
```

`orgDomains` can also be seeded with `POSTURE_ORG_DOMAINS=contoso.com,fabrikam.com`. Without org domains, *AI Agent with Non-Corporate User* reports nothing.

## Remediation and one-click fixes

Every check has a remediation summary and a copy-ready snippet (settings JSON, YAML, TOML, shell or PowerShell). Checks marked *auto-fix* can be fixed from the finding drawer, with these restrictions:

- Requires a **human** PolicyAdmin (an Entra user or the local console admin). The fix is recorded as an `admin` decision in the audit log.
- Runs only for **the endpoint hosting this monitor** in local mode. Findings from other devices return `409`. There is no remote execution; apply the snippet on the device, or re-run the CLI there.
- The file is backed up first (`<file>.agent-monitor.bak`, then `.bak.N`) and written atomically. Only existing keys are edited, so JSONC comments and layout are preserved. The only key ever added is Aider `auto-commits: false`, because that setting is on when absent.
- The finding is re-verified afterwards. The fix is idempotent: running it again returns `already compliant`.

## Checks

| Id | Title | Severity | Category | Level | Auto-fix | Detection |
|---|---|---|---|---|---|---|
| `ai-agent-non-corporate-user` | AI Agent with Non-Corporate User | Medium | Policy Violations | fleet | | Signed-in account domain not in `orgDomains` and not a well-known personal-mail domain |
| `file-upload-capability` | File Upload Capability | Medium | Configuration | endpoint | | *Heuristic*: MCP servers in file-sharing / company-data categories or with upload-like names; browser AI extensions with broad host access |
| `ai-screen-capture-capability` | AI Screen Capture Capability | Medium | Permissions | endpoint | | *Heuristic*: extension `desktopCapture` / `tabCapture`, browser / screenshot MCP servers |
| `ai-telemetry-may-leak-data` | AI Telemetry May Leak Data | Medium | Configuration | endpoint | | Prompt logging / telemetry settings in Gemini CLI, Claude Code (`OTEL_LOG_USER_PROMPTS`) and IDEs |
| `ide-agent-terminal-unrestricted` | IDE Agent Terminal Unrestricted | High | Configuration | endpoint | | Broad terminal auto-approve rules (VS Code `chat.tools.terminal.autoApprove`, Cursor / Windsurf auto-run, Claude Code `Bash(*)`) |
| `antigravity-autonomous-mode-enabled` | Antigravity Autonomous Mode Enabled | Critical | Configuration | endpoint | | Antigravity agent-driven / Turbo terminal execution policy |
| `openhands-confirmation-disabled` | OpenHands Confirmation Disabled | Critical | Configuration | endpoint | ✓ | `confirmation_mode = false` in OpenHands settings / `config.toml` |
| `mentat-pr-bot-mode-active` | Mentat PR Bot Mode Active | High | Configuration | endpoint | | *Heuristic*: local `.mentat` automation as a proxy (bot mode is configured server-side) |
| `vscode-global-auto-approve-enabled` | VS Code Global Auto-Approve Enabled | Critical | Configuration | endpoint | ✓ | `chat.tools.global.autoApprove: true`, legacy `chat.tools.autoApprove`, or `chat.permissions.default: autoApprove / autopilot` |
| `claude-code-extension-bypass-permission-prompts` | VS Code / Cursor Claude Code Extension Can Bypass Permission Prompts | High | Configuration | endpoint | ✓ | `claudeCode.allowDangerouslySkipPermissions` or `claudeCode.initialPermissionMode: bypassPermissions` |
| `claude-desktop-third-party-dxt-installed` | Claude Desktop Third-Party DXT Installed | High | Configuration | endpoint | | *Heuristic*: installed Desktop Extensions whose manifest author / source / signature is not Anthropic's |
| `aider-yes-mode-enabled` | Aider Yes Mode Enabled | High | Configuration | endpoint | ✓ | `yes-always` (or legacy `yes`) in `.aider.conf.yml`, `AIDER_YES_ALWAYS`, or a running `aider --yes-always` |
| `auto-commits-enabled` | Auto-Commits Enabled | Medium | Configuration | endpoint | ✓ | Aider `auto-commits` (on by default) |
| `known-vulnerable-software` | Known Vulnerable Software | Critical | Vulnerabilities | endpoint | | Browser / IDE extension version in [`vulnerable-extensions.json`](../src/posture/data/vulnerable-extensions.json) |
| `gemini-oauth-tokens-exposed` | Gemini OAuth Tokens Exposed | High | Credential Exposure | endpoint | ✓ | `~/.gemini/oauth_creds.json` readable by others (POSIX mode bits / Windows ACL via `icacls`) |
| `claude-history-contains-secrets` | Claude History Contains Secrets | High | Data Storage | endpoint | | Secret classifiers over Claude Code history (newest first, size-capped); masked samples only |
| `gemini-cli-google-account-linked` | Gemini CLI Google Account Linked | Medium | Configuration | endpoint | | Personal OAuth sign-in (`oauth-personal`) with cached credentials |
| `plandex-auto-execute-enabled` | Plandex Auto-Execute Enabled | Critical | Configuration | endpoint | | *Heuristic*: auto-exec / full-auto flags in shell history and processes (plan config is server-side) |
| `ide-workspace-trust-disabled` | IDE Workspace Trust Disabled | Medium | Configuration | endpoint | ✓ | `security.workspace.trust.enabled: false` in VS Code-family IDEs |
| `cli-agent-running-as-root` | CLI Agent Running as Root | Critical | Policy Violations | endpoint | | Agent CLI processes owned by root / running elevated on Windows |
| `multiple-coding-agents` | Multiple Coding Agents | Low | Policy Violations | endpoint | | More than one coding agent installed |
| `antigravity-browser-has-corporate-sessions` | Antigravity Browser Has Corporate Sessions | High | Configuration | endpoint | | *Heuristic*: cookie host keys in the Antigravity browser profile that match org / corporate SaaS domains |
| `antigravity-parallel-agents` | Antigravity Parallel Agents | Medium | Configuration | endpoint | | *Heuristic*: multiple Antigravity agent workspaces |
| `antigravity-multiple-google-accounts` | Antigravity Multiple Google Accounts | Medium | Configuration | endpoint | | *Heuristic*: more than one Google account in Antigravity state |
| `aider-api-key-in-config` | Aider API Key in Config | High | Credential Exposure | endpoint | | API key fields in `.aider.conf.yml` (masked) |
| `ai-clipboard-access` | AI Clipboard Access | Low | Permissions | endpoint | | *Heuristic*: AI browser extensions with `clipboardRead` |
| `ai-agent-version-mismatch` | AI Agent Version Mismatch | Medium | Policy Violations | fleet | | Endpoints not on the fleet's most common version of an agent |
| `ai-agent-sprawl` | AI Agent Sprawl | Medium | Policy Violations | endpoint | | More than 3 AI agents installed |
| `cli-agent-scheduled-execution` | CLI Agent Scheduled Execution | High | Policy Violations | endpoint | | cron, launchd, systemd timers or Windows scheduled tasks that invoke agent CLIs |
| `kiro-third-party-power-installed` | Kiro Third-Party Power Installed | High | Configuration | endpoint | | *Heuristic*: Kiro powers installed from a non-official source |

*Heuristic* checks rely on signals that products don't document as a stable setting. The finding drawer shows the check's confidence and a note explaining the heuristic. Adjust their severity or turn them off if they are noisy in your fleet.

## API and MCP

| Call | Purpose |
|---|---|
| `GET /api/gov/posture/checks` | Check catalog + effective config |
| `PUT /api/gov/posture/config` | Save config (PolicyAdmin) |
| `GET /api/gov/posture/summary` | Open findings by severity / category / check |
| `GET /api/gov/posture/findings` | Filter by `state`, `severity`, `endpointId`, `checkId`, `level` |
| `GET /api/gov/posture/findings/:id` | Finding + check (remediation) |
| `POST /api/gov/posture/findings/:id/suppress` / `unsuppress` | `{reason, until?}` (PolicyAdmin) |
| `POST /api/gov/posture/findings/:id/fix` | One-click fix (local endpoint, human PolicyAdmin) |
| `GET /api/gov/posture/endpoints[/:id]` | Endpoints and full inventory |
| `POST /api/gov/posture/scan` | Scan this device now (PolicyAdmin) |
| `POST /api/gov/posture/reports` | Ingest a CLI / device report (device token, Agent or PolicyAdmin) |

MCP tools: `list_posture_findings`, `get_endpoint_inventory`.
