# Installation and local setup

This guide installs and runs every component of Agent Monitor on one workstation. It covers the monitor and governance server, the web dashboard, endpoint agent hooks, the MCP server and gateway, the Python intelligence service, the AgentMon monitoring fleet, the SDKs, the desktop app and the Docker images. Commands are given for Windows PowerShell first, then macOS/Linux (bash). Every command, script name and flag comes from files in this repo.

For how the pieces fit together, see [Application architecture](architecture/application.md). For Azure-side setup (resources, roles, Entra apps), see [Cloud configuration](cloud-configuration.md).

## Contents

1. [What you'll have running](#1-what-youll-have-running)
2. [Prerequisites](#2-prerequisites)
3. [Quick install](#3-quick-install)
4. [Configuration (.env)](#4-configuration-env)
5. [Run the monitor and governance server](#5-run-the-monitor-and-governance-server)
6. [Enable endpoint agent hooks](#6-enable-endpoint-agent-hooks)
7. [MCP server and MCP gateway](#7-mcp-server-and-mcp-gateway)
8. [Intelligence service (Python)](#8-intelligence-service-python)
9. [Monitoring fleet (Python)](#9-monitoring-fleet-python)
10. [SDKs](#10-sdks)
11. [Desktop app (Electron)](#11-desktop-app-electron)
12. [Docker images](#12-docker-images)
13. [Verification checklist](#13-verification-checklist)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. What you'll have running

| Component | Port | Start command | Required? |
|---|---|---|---|
| Monitor + governance server (REST API, dashboard, `/hooks/*`, `/v1`, `/mcp`, `/live` WebSocket) | 4317 (`PORT`) | `.\start.ps1` or `npm start` | Yes |
| Vite dev server for the dashboard (hot reload) | 5173 | `npm run dev:web` | Dev only |
| MCP server, stdio transport | stdio | `npm run mcp` | Optional |
| Governance MCP gateway | 4127 (`AGENT_GATEWAY_PORT`) | `npm run gateway` | Optional |
| Intelligence service (Guardian, lane drafter, chat) | 8000 | `python -m uvicorn agentgov_intel.app:app` | Optional |
| Fleet worker (collectors + detectors loop) | none | `agentmon-fleet run` | Optional |
| Fleet real-time hooks API | 8787 | `agentmon-fleet hooks --port 8787` | Optional |
| Desktop tray app (wraps the server) | 4317 (`PORT`) | `npm run electron:dev` | Optional, Windows |

With no configuration, only the server is needed. It runs as a local enforcer on `127.0.0.1` with deterministic lanes, the Copilot CLI log collector and SQLite storage.

---

## 2. Prerequisites

| Tool | Version | Source of truth | Needed for |
|---|---|---|---|
| Node.js + npm | **≥ 22.5.0** (CI and Docker use **24**) | `package.json` `engines.node`, `NODE_VERSION: "24"` in `.github/workflows/ci.yml`, `node:24-alpine` in `Dockerfile` | Server, dashboard, MCP, gateway, hooks installer. 22.5 is the first release with the built-in `node:sqlite` engine the server uses (`src/db.ts`). |
| Git | any | — | Cloning the repo |
| Python | **≥ 3.12** (CI uses **3.12**) | `requires-python` in `fleet/`, `intelligence/`, `packages/sdk-python/` `pyproject.toml`; `PYTHON_VERSION: "3.12"` in CI | Fleet, intelligence service, Python SDK |
| Azure CLI | any current | — | `az login` for `DefaultAzureCredential` (collectors, judge, fleet fallback, `scenarios --identity cli`) |
| Terraform | **1.16.2** | `TERRAFORM_VERSION` in CI | Optional: `infra/terraform` |
| Docker (BuildKit) | any with BuildKit | `# syntax=docker/dockerfile:1.7` and `RUN --mount=type=cache` in the Dockerfiles | Optional: building images |
| Dev Tunnels CLI (`devtunnel`) | any | [fleet-realtime-hooks.md](fleet-realtime-hooks.md) | Optional: exposing local fleet hooks to Copilot Studio |
| Power Platform CLI (`pac`) | — | Not called by any script in this repo | Not required. Dataverse setup uses `infra/lab/provision-lab.ps1`. |

Check versions:

```powershell
node --version; npm --version; git --version; python --version; az version
```

```bash
node --version && npm --version && git --version && python3 --version && az version
```

Clone the repo:

```powershell
git clone https://github.com/stark3998/Agents-Log-Monitor.git
Set-Location Agents-Log-Monitor
```

---

## 3. Quick install

The installers build the server and UI and wire agent hooks. Re-running them is safe: they remove only Agent Monitor hook entries, then add the requested ones.

```powershell
# Windows (PowerShell 5.1+)
.\install.ps1                     # Claude Code hooks only
.\install.ps1 -CopilotHooks       # + Copilot CLI hooks
```

```bash
# macOS / Linux
./install.sh                      # Claude Code hooks only
./install.sh --copilot-hooks      # + Copilot CLI hooks
```

What `install.ps1` does, in order:

1. **Checks prerequisites.** Fails unless `node --version` is 22.5 or later. Finds `npm`, falling back to `npm.cmd` next to `node.exe`.
2. **Installs dependencies.** Runs `npm install --prefer-offline` in the repo root. The root `postinstall` script runs `npm --prefix web install`, so the dashboard dependencies are installed too.
3. **Builds.** Runs `npm run build` (`tsc` → `dist/`, then the Vite build of `web/` → `public/`).
4. **Wires Claude Code.** Edits `%USERPROFILE%\.claude\settings.json`. It removes existing hook entries whose URL ends in `/hooks/claude-code` or `/ingest/claude-code`, then adds an `http` hook to `http://127.0.0.1:<Port>/hooks/claude-code` for 11 events. `PreToolUse`, `UserPromptSubmit` and `PermissionRequest` get the `-HookTimeoutSec` timeout; the rest get 5 s. An unparseable settings file is copied to `settings.json.bak` first.
5. **Wires optional surfaces** requested with `-CopilotHooks`, `-CopilotPolicyHooks` or `-VSCodeHooks` (see [section 6](#6-enable-endpoint-agent-hooks)).
6. **Writes `start.ps1`**, which runs `node dist/server.js` from the repo root.

`install.sh` does the same for Claude Code (`~/.claude/settings.json`) and Copilot CLI, and writes `start.sh` instead of `start.ps1`.

| `install.ps1` | `install.sh` | Default | Effect |
|---|---|---|---|
| `-Port <n>` | `--port <n>` | `4317` | Port used in the hook URLs. It does **not** change the server port; set `PORT` in `.env` to match. |
| `-HookTimeoutSec <n>` | `--hook-timeout-sec <n>` | `120` | Timeout for blocking hooks (approval budget) |
| `-CopilotHooks` | `--copilot-hooks` | off | Copilot CLI user hooks |
| `-CopilotPolicyHooks` | — | off | Machine-wide Copilot CLI policy hooks (elevated PowerShell) |
| `-VSCodeHooks` | — | off | VS Code Local harness hooks |
| `-FailMode auto\|open\|closed` | `--fail-mode auto\|open\|closed` | `auto` | Forwarder behavior when the server is unreachable |
| `-ControlPlaneUrl <url>` | `--control-plane-url <url>` | empty | Point hooks at a cloud control plane instead of `127.0.0.1` |
| `-Uninstall` | `--uninstall` | — | Remove all Agent Monitor hook entries and exit |

Manual install (equivalent to steps 2–3, as in the [README](../README.md) quick start):

```powershell
npm install
npm run build
```

---

## 4. Configuration (.env)

All components share **one `.env` file in the repo root**. Start from the annotated template, which lists every supported variable:

```powershell
Copy-Item .env.example .env
```

```bash
cp .env.example .env
```

### How `.env` is found

| Consumer | File read |
|---|---|
| Server, MCP stdio server, MCP gateway (`src/env.ts`, `src/env-path.ts`) | `AGENT_MONITOR_ENV_FILE` if set in the shell (`none`/`off`/`false`/`0` disables), else `<repo root>/.env` (resolved from `src/` or `dist/`, so the working directory doesn't matter) |
| Intelligence service (`intelligence/src/agentgov_intel/config.py`) | Same rule as the server |
| Electron, development (`npm run electron:dev`) | `<repo root>/.env` |
| Electron, installed app | `%APPDATA%\Agent Monitor\.env` |
| Vite dev server and build (`web/vite.config.ts`) | Repo root (`AGENT_MONITOR_URL`, `VITE_*`) |
| Fleet (`fleet/src/agentmon_fleet/config.py`) | Nearest `.env` walking up from the current directory, so running from `fleet/` finds the repo-root file. Only `FLEET_*` variables are read. |
| Docker / Azure Container Apps | Not read. Set real environment variables. |

Rules (from `src/env.ts` and `.env.example`):

- Variables already set in the shell win over `.env`.
- Empty values (`KEY=`) are ignored, so the built-in default applies.
- `AGENT_MONITOR_ENV_FILE` inside `.env` is ignored; set it in the shell.
- Quote values that contain `#` or spaces.
- Restart the process after editing. `.env` is git-ignored; never commit it.
- `VITE_*` values are embedded in the built UI. Never put secrets in them.

### Sections at a glance

| `.env.example` section | Enabled by | Detail |
|---|---|---|
| Server & storage | Defaults: `PORT=4317`, `HOST=127.0.0.1`, `AGENT_MONITOR_DB=./agent-monitor.db`, `REDACT_PAYLOADS=secrets` | [README](../README.md), [.env.example](../.env.example) |
| Copilot CLI log collector | On by default (`COPILOT_CLI_ENABLED`), imports `COPILOT_CLI_IMPORT_DAYS=7` days | [log-ingestion.md](log-ingestion.md) |
| Azure credentials | `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`; prefer `az login` or managed identity | [security-auth.md](security-auth.md) |
| Foundry agent collector | `FOUNDRY_ENDPOINT` | [data-sources.md](data-sources.md) |
| Copilot Studio collector | `DATAVERSE_ORG_URL` | [data-sources.md](data-sources.md) |
| Governance core | `AGENT_MONITOR_MODE=local` (default), `GOVERNANCE_ENFORCE`, `GOVERNANCE_LANES_DIR`, `GOVERNANCE_LOCAL_ADMIN_TOKEN` | [governance.md](governance.md) |
| LLM judge | `FOUNDRY_OPENAI_ENDPOINT` (or `AZURE_OPENAI_ENDPOINT`) | [governance.md](governance.md) |
| Prompt Shields | `CONTENT_SAFETY_ENDPOINT` | [governance.md](governance.md) |
| TypeSafe Jev (shadow) | `TYPESAFE_API_KEY` | [jev.md](jev.md) |
| AgentMon Fleet | `FLEET_*` | [fleet.md#configuration-reference](fleet.md#configuration-reference) |
| Cloud control plane & sync | `GOVERNANCE_CONTROL_PLANE_URL`, `COSMOS_ENDPOINT`, `REDIS_URL` | [cloud-configuration.md](cloud-configuration.md), [cloud-mode.md](cloud-mode.md) |
| Entra ID authentication | `ENTRA_API_AUDIENCE`, `ENTRA_SPA_CLIENT_ID`, `GOVERNANCE_TRUST_LOOPBACK` | [security-auth.md](security-auth.md) |
| Alerts | `TEAMS_WEBHOOK_URL`, `ALERT_WEBHOOK_URLS` + `ALERT_WEBHOOK_SECRET`, `ACS_ENDPOINT` | [cloud-configuration.md](cloud-configuration.md) |
| Intelligence link | `INTELLIGENCE_URL` (e.g. `http://127.0.0.1:8000`) | [intelligence.md](intelligence.md) |
| MCP gateway | `AGENT_GATEWAY_*`, `GATEWAY_HOST` | [mcp-gateway.md](mcp-gateway.md) |
| Web UI (Vite) | `AGENT_MONITOR_URL`, `VITE_ENTRA_*` | [dashboard.md](dashboard.md) |
| Intelligence service | `FOUNDRY_PROJECT_ENDPOINT`, `GUARDIAN_*`, `MONITOR_*` | [intelligence/README.md](../intelligence/README.md) |

### Minimum configuration by scenario

**Local endpoint monitoring (Claude Code, Copilot CLI, VS Code).** No variables needed.

**Monitor Foundry agents from the server.** Sign in with `az login`, then:

```dotenv
FOUNDRY_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
```

**Monitor Copilot Studio agents from the server.** The app registration needs an **Application User** with the **Bot Transcript Viewer** role in the Dataverse environment:

```dotenv
DATAVERSE_ORG_URL=https://<org>.crm.dynamics.com
AZURE_TENANT_ID=<tenant-id>
AZURE_CLIENT_ID=<app-id>
AZURE_CLIENT_SECRET=<client-secret>
```

**Run the monitoring fleet against Foundry and Copilot Studio.** Identity falls back to `az login` when no client secret is set (see [section 9](#9-monitoring-fleet-python)):

```dotenv
FLEET_SUBSCRIPTION_ID=<subscription-id>
FLEET_FOUNDRY_PROJECT_ENDPOINT=https://<account>.services.ai.azure.com/api/projects/<project>
FLEET_LAW_WORKSPACE_ID=<workspace-guid>
FLEET_DATAVERSE_ORG_URL=https://<org>.crm.dynamics.com
```

**Add the LLM judge and Prompt Shields** (optional, keyless with `DefaultAzureCredential`):

```dotenv
FOUNDRY_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
CONTENT_SAFETY_ENDPOINT=https://<resource>.cognitiveservices.azure.com
```

---

## 5. Run the monitor and governance server

Build once (skip if you ran the installer), then start:

```powershell
npm run build          # tsc -> dist/, vite -> public/
.\start.ps1            # or: npm start  (node dist/server.js)
```

```bash
npm run build
./start.sh             # written by install.sh; or: npm start
```

Run `npm start` from the repo root: lane and policy folders default to `<cwd>/lanes` and `<cwd>/policies` (`GOVERNANCE_LANES_DIR`, `GOVERNANCE_POLICIES_DIR`). `start.ps1` and `start.sh` change to the repo root first.

Expected output (from `src/server.ts`):

```text
[env] loaded N variable(s) from <repo>\.env
Agent Monitor listening on http://127.0.0.1:4317
  Health:   http://127.0.0.1:4317/health
  Sessions: http://127.0.0.1:4317/api/sessions
  UI:       http://127.0.0.1:4317/
  Local admin: http://127.0.0.1:4317/api/gov/local-login?token=...
AGENTGOV_ADMIN_LOGIN_URL=http://127.0.0.1:4317/api/gov/local-login?token=...
[collector] GitHub Copilot CLI enabled
```

The `[collector]` lines appear only for collectors that are enabled.

### Open the dashboard and sign in as local admin

1. Open `http://127.0.0.1:4317/`. Loopback callers are trusted as the `local-agent` principal with `Agent` + `Viewer` roles: you can read everything but can't approve, resume or activate lanes.
2. For admin actions, open the **Local admin** URL printed at startup. It is single-use and expires after 5 minutes. It sets an `agentgov_admin` cookie (12-hour in-memory session) and redirects to `/governance`.
3. To get a new link, restart the server. Sessions don't survive a restart.
4. For scripts, set `GOVERNANCE_LOCAL_ADMIN_TOKEN` in `.env` and send it as a bearer token.

See [security-auth.md](security-auth.md) for the loopback trust model.

### Development mode

```powershell
npm run dev            # API server with ts-node on :4317
npm run dev:web        # Vite on http://127.0.0.1:5173, proxies /api, /ingest, /health, /live to AGENT_MONITOR_URL
```

Run each in its own terminal. The Vite origin (`:5173`) is accepted on loopback unless `NODE_ENV=production`.

---

## 6. Enable endpoint agent hooks

Hook contracts, event mappings and fail-mode semantics are in [governance-surfaces.md](governance-surfaces.md). Start the server before starting agent sessions, and restart active sessions after changing hooks.

### Claude Code

Installed by default by both installers:

```powershell
.\install.ps1 -HookTimeoutSec 120
```

```bash
./install.sh --hook-timeout-sec 120
```

Verify: type `/hooks` in a new Claude Code session.

### GitHub Copilot CLI

User-level command hooks, written to `%USERPROFILE%\.copilot\hooks\agent-governance.json` (or `$COPILOT_HOME/hooks`):

```powershell
.\install.ps1 -CopilotHooks -FailMode open
```

```bash
./install.sh --copilot-hooks --fail-mode open
```

Machine-wide policy hooks (Windows, elevated PowerShell), written to `C:\ProgramData\GitHub\Copilot\policy.d\agent-governance.json`:

```powershell
.\install.ps1 -CopilotPolicyHooks -FailMode closed
```

The hooks call `scripts/copilot-hook-forward.ps1` (Windows) or `scripts/copilot-hook-forward.sh`, which post to `/hooks/copilot-cli`. The Copilot CLI log collector also imports sessions without hooks.

### VS Code (Local harness)

Option A, user-level, written to `%USERPROFILE%\.copilot\hooks\agent-governance-vscode.json` with absolute paths to the forwarders:

```powershell
.\install.ps1 -VSCodeHooks
```

Option B, per repository: copy [`templates/vscode/agent-governance-hooks.json`](../templates/vscode/agent-governance-hooks.json) into the workspace's `.github/hooks/`. The template calls `./scripts/copilot-hook-forward.sh` and `.\scripts\copilot-hook-forward.ps1` by relative path, so copy both forwarder scripts into the workspace's `scripts/` folder too.

Both options need `chat.useHooks` enabled and a trusted workspace.

### GitHub Copilot cloud agent

Copy the template into the target repository:

```powershell
$target = "<path-to-target-repo>"
New-Item -ItemType Directory -Force "$target\.github\hooks" | Out-Null
Copy-Item templates\copilot-cloud-agent\.github\hooks\* "$target\.github\hooks\"
```

```bash
target="<path-to-target-repo>"
mkdir -p "$target/.github/hooks"
cp templates/copilot-cloud-agent/.github/hooks/* "$target/.github/hooks/"
```

Then set these in the repository's Copilot environment:

| Variable | Required | Value |
|---|---|---|
| `AGENT_GOVERNANCE_URL` | Yes | `https://<control-plane-host>` (must be allow-listed in the cloud agent firewall) |
| `AGENT_GOVERNANCE_TOKEN` | When the control plane requires bearer auth | Device or Entra token |
| `AGENT_GOVERNANCE_FAIL_MODE` | No | `open` (default) or `closed` |
| `AGENT_GOVERNANCE_TIMEOUT_SEC` | No | `110` (default) |

The cloud agent can't reach `127.0.0.1`, so it needs a cloud control plane. See [cloud-configuration.md](cloud-configuration.md).

### Remove all hooks

```powershell
.\install.ps1 -Uninstall      # policy hook removal needs an elevated session
```

```bash
./install.sh --uninstall
```

---

## 7. MCP server and MCP gateway

### MCP server ("what did my agents do?")

The running server exposes Streamable HTTP at `http://127.0.0.1:4317/mcp`. A stdio transport is also available after a build:

```powershell
npm run build:server
npm run mcp                   # node dist/governance/mcp/stdio.js
```

Register it with Claude Code:

```powershell
claude mcp add agent-monitor http://127.0.0.1:4317/mcp
```

VS Code `mcp.json` and cloud-mode (Entra bearer) setup are in [mcp.md](mcp.md).

### Governance MCP gateway

The gateway proxies MCP `tools/list` and `tools/call` through the governance PDP. Create a config from the example, then run it:

```powershell
Copy-Item agent-gateway.example.json agent-gateway.json   # edit upstreams
npm run build:server
$env:AGENT_GATEWAY_ALLOW_ANONYMOUS = "true"               # loopback development only
npm run gateway                                            # http://127.0.0.1:4127/mcp
```

```bash
cp agent-gateway.example.json agent-gateway.json
npm run build:server
AGENT_GATEWAY_ALLOW_ANONYMOUS=true npm run gateway
```

- HTTP callers need an Entra token for `AGENT_GATEWAY_AUDIENCE` with the `Agent` role; requests without a bearer get `401` unless `AGENT_GATEWAY_ALLOW_ANONYMOUS=true`. The gateway refuses to start with anonymous mode on a non-loopback host.
- `AGENT_GATEWAY_CONFIG` defaults to `./agent-gateway.json`. A missing file means no upstreams.
- For stdio wrapping, run `node dist/gateway/main.js --stdio`. See [mcp-gateway.md](mcp-gateway.md) for the client config.

---

## 8. Intelligence service (Python)

The FastAPI service adds Guardian (incident triage), the AI lane drafter and "Ask the monitor" chat. It reads the repo-root `.env`.

```powershell
cd intelligence
python -m venv .venv
.\.venv\Scripts\python -m pip install -e ".[dev]"
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python -m uvicorn agentgov_intel.app:app --reload     # http://127.0.0.1:8000
```

```bash
cd intelligence
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"
.venv/bin/python -m pytest -q
.venv/bin/python -m uvicorn agentgov_intel.app:app --reload
```

Add `.[dev,observability]` to install Azure Monitor OpenTelemetry. Minimum `.env` settings:

```dotenv
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
INTELLIGENCE_URL=http://127.0.0.1:8000
```

`INTELLIGENCE_URL` tells the server where the service is. Models default to `GUARDIAN_DEPLOYMENT=gpt-5` and `CHAT_DEPLOYMENT=gpt-4.1`. Authentication is `DefaultAzureCredential` (run `az login`). See [intelligence.md](intelligence.md).

---

## 9. Monitoring fleet (Python)

AgentMon Fleet (`fleet/`, CLI `agentmon-fleet`) monitors Foundry and Copilot Studio agents from their logs and APIs. Full reference: [fleet.md](fleet.md).

### Install

```powershell
cd fleet
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e ".[dev]"
agentmon-fleet --help
```

```bash
cd fleet
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
agentmon-fleet --help
```

### Authenticate

Credential selection in `fleet/src/agentmon_fleet/auth.py`:

| Order | When | Credential |
|---|---|---|
| 1 | `IDENTITY_ENDPOINT` or `MSI_ENDPOINT` is set (Azure) | Managed identity, `FLEET_MANAGED_IDENTITY_CLIENT_ID` |
| 2 | `FLEET_AZURE_TENANT_ID` + `FLEET_AZURE_CLIENT_ID` + `FLEET_AZURE_CLIENT_SECRET` are all set | Service principal (local runs only) |
| 3 | Otherwise | `DefaultAzureCredential` without the interactive browser, e.g. your `az login` |

For a developer machine, option 3 is simplest:

```powershell
az login --tenant <tenant-id>
az account set --subscription <subscription-id>
```

The identity needs the read roles in [fleet-sources.md → Permissions](fleet-sources.md#permissions): **Log Analytics Reader**, **Monitoring Reader**, **Foundry User** (formerly Azure AI User) on the Foundry accounts, and a Dataverse application user for Copilot Studio.

### First commands

Global flags (`-v`, `--state <path>`, `--no-llm`) go **before** the subcommand.

```powershell
agentmon-fleet discover                          # Foundry accounts/projects in scope
agentmon-fleet collect --source law              # collectors only, no detection
agentmon-fleet run --once --console              # one full cycle, alerts printed
agentmon-fleet --no-llm run --once --console     # deterministic detectors only
agentmon-fleet profiles                          # agent charters
agentmon-fleet alerts --limit 20                 # add --json for machine output
agentmon-fleet incidents
agentmon-fleet sessions --limit 10               # session intent ledgers
agentmon-fleet stats                             # state counters, inference inventory
agentmon-fleet run                               # loop every FLEET_POLL_INTERVAL_S (120 s)
agentmon-fleet run --agentic                     # Fleet Commander deep-dives new high/critical incidents
```

`--source` accepts `law`, `foundry`, `dataverse`, `storage`, `purview`, `entra` or `defender` and is repeatable.

Fleet Commander:

```powershell
agentmon-fleet ask "Which agents were blocked most in the last day?"
agentmon-fleet investigate <session-id>
```

### Real-time hooks server

```powershell
$env:FLEET_HOOKS_TOKEN = "<local-shared-secret>"   # dev-only shared bearer for /evaluate and /events
agentmon-fleet hooks --port 8787
curl.exe -s http://127.0.0.1:8787/health
```

```bash
export FLEET_HOOKS_TOKEN="<local-shared-secret>"
agentmon-fleet hooks --port 8787
curl -s http://127.0.0.1:8787/health
```

To expose it to Copilot Studio through a dev tunnel, and for Entra JWT auth, see [fleet-realtime-hooks.md](fleet-realtime-hooks.md).

### Adversarial scenarios

```powershell
agentmon-fleet scenarios list
agentmon-fleet scenarios setup                                  # create/update lab Foundry agents
agentmon-fleet scenarios run --only evasion                     # id, glob or category; repeatable
agentmon-fleet scenarios run --hooks-url http://127.0.0.1:8787  # gate calls through /evaluate
agentmon-fleet scenarios verify --cycle                         # run one cycle first, then score
```

`--identity cli|fleet` picks your CLI login (default) or the fleet identity. Copilot Studio scenarios need `FLEET_SCENARIO_CS_HR_TOKEN_URL` / `FLEET_SCENARIO_CS_ITOPS_TOKEN_URL` as **process environment variables**; they aren't read from `.env`.

### Where state and logs go

Paths are relative to the directory you run `agentmon-fleet` from.

| File | Default | Setting |
|---|---|---|
| SQLite state (cursors, events, alerts, incidents, baselines) | `fleet-state.db` | `FLEET_STATE_DB` or `--state` |
| Alert/incident log (JSONL) | `fleet-alerts.jsonl` | `FLEET_ALERTS_JSONL` (empty disables) |
| Jev shadow log | `fleet-jev-shadow.jsonl` | `FLEET_JEV_SHADOW_JSONL` |
| Normalized event mirror (debug) | off | `FLEET_EVENTS_JSONL` |
| Scenario runs | `scenario-runs/` | `FLEET_SCENARIO_RUNS_DIR` |
| Dashboard alerts | `http://127.0.0.1:4317` → **Fleet** page (`/fleet`) | `FLEET_MONITOR_URL` (empty disables) |

---

## 10. SDKs

The SDKs call the governance PDP (`POST /v1/decide`) from custom agents. Install from the repo checkout.

### Python (`packages/sdk-python`, package `agent-governance`)

```powershell
pip install -e "packages/sdk-python"                   # core (httpx only)
pip install -e "packages/sdk-python[azure]"            # + azure-identity for Entra tokens
pip install -e "packages/sdk-python[agent-framework]"  # + Agent Framework middleware, incl. the fleet middleware
```

Other extras: `semantic-kernel`, `langchain`, `openai-agents`, `dev`. The fleet middleware (`agent_governance.integrations.fleet.create_fleet_middleware`, `FleetClient`, `mcp_approval_responses`) talks to the fleet hooks server on port 8787; see [fleet-realtime-hooks.md](fleet-realtime-hooks.md#agent-framework-middleware).

Run the SDK tests:

```powershell
cd packages\sdk-python
pip install -e ".[dev]"
pytest -q
```

### TypeScript (`packages/sdk-ts`, package `@agent-governance/sdk`)

```powershell
cd packages\sdk-ts
npm install
npm run build          # ESM + CJS in dist/
npm test
```

Consume it from another project by path, for example `npm install <path-to-repo>/packages/sdk-ts`. Subpath adapters: `@agent-governance/sdk/openai-agents` and `@agent-governance/sdk/langchain`. See [packages/sdk-ts/README.md](../packages/sdk-ts/README.md) and [packages/sdk-python/README.md](../packages/sdk-python/README.md).

---

## 11. Desktop app (Electron)

The tray app starts the server, opens the dashboard and opens the local-admin link automatically. Packaging targets Windows only (`electron-builder --win`, NSIS x64).

```powershell
npm run electron:dev     # dev: runs src/server.ts via ts-node, reads the repo-root .env
npm run electron:pack    # build + unpacked app in release\win-unpacked (smoke test)
npm run electron:build   # build + NSIS installer in release\
```

The installed app runs the server on Electron's embedded Node, so users don't need Node.js. It stores the database, rules file and `server.log` in `%APPDATA%\Agent Monitor`, and reads its `.env` from there (tray menu → **Open Data Folder**). `PORT` in that file sets the port the tray opens.

---

## 12. Docker images

All Dockerfiles use BuildKit features. Tag with a Git SHA as the file headers suggest.

```powershell
$sha = git rev-parse --short HEAD
docker build -t "agentgov/control-plane:$sha" .
docker build -f Dockerfile.gateway -t "agentgov/mcp-gateway:$sha" .
docker build -t "agentgov/fleet:$sha" fleet
docker build -t "agentgov/intelligence:$sha" intelligence
```

```bash
sha=$(git rev-parse --short HEAD)
docker build -t "agentgov/control-plane:$sha" .
docker build -f Dockerfile.gateway -t "agentgov/mcp-gateway:$sha" .
docker build -t "agentgov/fleet:$sha" fleet
docker build -t "agentgov/intelligence:$sha" intelligence
```

| Image | Dockerfile / context | Port | Default command | Baked-in defaults |
|---|---|---|---|---|
| Control plane | `Dockerfile` / `.` | 4317 | `node dist/server.js` | `AGENT_MONITOR_MODE=cloud`, `HOST=0.0.0.0`, `GOVERNANCE_TRUST_LOOPBACK=false`, DB in `/app/data` |
| MCP gateway | `Dockerfile.gateway` / `.` | 8080 | `node dist/gateway/main.js` | `AGENT_GATEWAY_CONFIG=/app/config/agent-gateway.json` (not baked in) |
| Fleet | `fleet/Dockerfile` / `fleet` | 8787 | `agentmon-fleet run` (override with `hooks --host 0.0.0.0 --port 8787`) | State and JSONL in `/data`, charters in `/app/charters` |
| Intelligence | `intelligence/Dockerfile` / `intelligence` | 8000 | `uvicorn agentgov_intel.app:app --host 0.0.0.0 --port 8000` | — |

Containers don't read `.env`. Pass settings with `-e` or `--env-file`. The control-plane image runs in **cloud mode**, which requires Entra configuration; see [cloud-configuration.md](cloud-configuration.md). Deployment to Azure Container Apps is covered in [infra/README.md](../infra/README.md).

---

## 13. Verification checklist

Health endpoints:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/health        # {ok: true, ts: ...}
Invoke-RestMethod http://127.0.0.1:4317/api/sessions  # array of sessions
Invoke-RestMethod http://127.0.0.1:8787/health        # fleet hooks: {ok, mode, llm}
Invoke-RestMethod http://127.0.0.1:8000/health        # intelligence service
Invoke-RestMethod http://127.0.0.1:4127/health        # MCP gateway
```

```bash
curl -s http://127.0.0.1:4317/health
curl -s http://127.0.0.1:8787/health
```

Tests (the same suites CI runs):

```powershell
npm test                                   # server unit tests (vitest)
npm run test:web                           # dashboard tests; same as: cd web; npx vitest run
npm run test:gov                           # governance tests only
npm run eval:redteam                       # red-team scenario replays
cd fleet; .\.venv\Scripts\python -m pytest -q; cd ..
cd intelligence; .\.venv\Scripts\python -m pytest -q; cd ..
```

- [ ] `GET /health` on 4317 returns `ok: true`.
- [ ] The dashboard loads at `http://127.0.0.1:4317/`.
- [ ] The local admin link opens `/governance`.
- [ ] `/hooks` in a new Claude Code session lists the Agent Monitor hook, and a session appears in the dashboard.
- [ ] `agentmon-fleet run --once --console` completes a cycle (if you use the fleet).
- [ ] All test suites pass.

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `.\install.ps1 cannot be loaded because running scripts is disabled` (also `Activate.ps1`) | PowerShell execution policy | `Set-ExecutionPolicy -Scope Process Bypass`, then re-run. Or run `powershell -ExecutionPolicy Bypass -File .\install.ps1`. |
| `Node.js 22.5 or later required` (installer) or `Agent Monitor needs Node.js 22.5 or later for its built-in SQLite engine` (server) | Node older than 22.5; `node:sqlite` is missing | Install Node 24 (the CI version) and re-run. |
| `EADDRINUSE` on start | Another process owns port 4317 | `Get-NetTCPConnection -LocalPort 4317 \| Select-Object OwningProcess`, then stop that PID, or set `PORT` in `.env`. If you change `PORT`, re-run `.\install.ps1 -Port <n>` so hook URLs match. |
| Hooks don't reach the server after changing the port | `-Port` only changes hook URLs; the server port comes from `PORT` | Keep `PORT` in `.env` and the installer `-Port` value the same. |
| `Cannot find module ... dist/...` from `npm start`, `npm run mcp` or `npm run gateway` | Not built | `npm run build` (or `npm run build:server` for MCP/gateway only). |
| Dashboard shows a blank page | `public/` not built | `npm run build:web`. |
| Approve/resume/activate buttons return 403 | Loopback callers get only `Agent` + `Viewer` | Open the printed Local admin link, or restart the server for a new one. |
| Request rejected with a Host/Origin error | DNS-rebinding guard accepts only `127.0.0.1`, `localhost`, `[::1]` on the server port | Browse to `http://127.0.0.1:<port>/`. |
| Copilot CLI hooks ignored | Hook file not in `%USERPROFILE%\.copilot\hooks` (or `$COPILOT_HOME/hooks`), or session started before install | Re-run `.\install.ps1 -CopilotHooks` and start a new session. |
| Policy hooks not written | Not elevated | Run `.\install.ps1 -CopilotPolicyHooks` from an elevated PowerShell. |
| VS Code hooks don't fire | `chat.useHooks` off or workspace untrusted; template can't find `scripts/copilot-hook-forward.*` | Enable the setting, trust the workspace, copy the forwarders or use `-VSCodeHooks`. |
| Fleet logs `no data-plane access to <endpoint> (grant Foundry User to the fleet identity)` | 401/403 on the Foundry project data plane | Assign **Foundry User** (Azure AI User) on the Foundry account to the fleet identity. The project is skipped until restart. |
| Server Foundry or Copilot Studio collector returns 401/403 | Identity lacks access | Foundry: grant **Foundry User** to the `DefaultAzureCredential` identity. Dataverse: add the app as an **Application User** with **Bot Transcript Viewer**. |
| Fleet Dataverse collector returns nothing | No Dataverse application user for the fleet identity | Create it with a read-only role; `infra/lab/provision-lab.ps1 -Steps dataverse` creates "AgentMon Fleet Reader". |
| Fleet LAW collector silently skips a query | Table doesn't exist yet (`Failed to resolve table`) | Enable diagnostic settings that populate the table and wait for ingestion. Check `FLEET_LAW_WORKSPACE_ID` is the workspace **GUID**, not the resource id. |
| Fleet `DefaultAzureCredential failed to retrieve a token` | No service principal and no `az login` | `az login --tenant <tenant-id>`, or set all three `FLEET_AZURE_*` identity variables. |
| Fleet hooks return 401 | No bearer token, or JWT validation not configured | Set `FLEET_HOOKS_TOKEN` for local dev, or `FLEET_AZURE_TENANT_ID` + `FLEET_HOOKS_AUDIENCE` for Entra. |
| `.env` values ignored | Same variable set in the shell, empty value, or process not restarted | Clear the shell variable, restart the process, check the `[env] loaded N variable(s) from <path>` line. |
| Gateway returns 401 to MCP clients | No bearer token and anonymous mode off | Send an Entra token for `AGENT_GATEWAY_AUDIENCE`, or set `AGENT_GATEWAY_ALLOW_ANONYMOUS=true` (loopback only). |
| Gateway exits with `AGENT_GATEWAY_ALLOW_ANONYMOUS is only allowed when the gateway binds to loopback` | Anonymous mode with a non-loopback `GATEWAY_HOST` | Set `GATEWAY_HOST=127.0.0.1` or turn off anonymous mode. |
| `npm run electron:dev` fails on macOS/Linux with `SET: command not found` | The script uses `cmd.exe` syntax | Run it on Windows. Desktop packaging targets Windows only. |
| `pip install -e .[dev]` fails in zsh with `no matches found` | Brackets are glob characters | Quote them: `pip install -e ".[dev]"`. |
| Windows paths in hook JSON break | Hand-edited paths with unescaped backslashes | Let `install.ps1` write the files; it JSON-escapes paths and uses forward slashes for `sh` commands. |
