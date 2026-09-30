# Governance security and authentication

## Entra app registrations

Create three Microsoft Entra registrations:

1. **Agent Governance API**
   - Expose an API with an application ID URI. Terraform defaults to `api://<prefix>-<env>-api` (`api_identifier_uri`); some tenants' app-management policies only allow `api://<api-client-id>` or verified domains.
   - Add app roles: `Viewer`, `Approver`, `PolicyAdmin`, `Agent`.
   - Optionally expose delegated scopes for dashboard reads/writes; the API authorizes by app roles.
   - Tokens are accepted for both `api://<api-client-id>` and the bare client id.
2. **Dashboard SPA**
   - Configure redirect URIs for the dashboard origin.
   - Request access tokens for the Governance API audience.
   - Assign users/groups to `Viewer`, `Approver`, or `PolicyAdmin`.
3. **Teams bot (optional)**
   - Register an Azure Bot / Teams app with `TEAMS_BOT_APP_ID`.
   - Configure the bot messaging endpoint to `POST /api/gov/teams/messages`.
   - Teams `Action.Execute` users must be allow-listed with `TEAMS_APPROVER_OBJECT_IDS` or replaced by a future Entra group check.

## Environment variables

| Variable | Purpose |
|---|---|
| `AGENT_MONITOR_MODE=local|cloud` | Local loopback enforcer or cloud control plane. |
| `ENTRA_TENANT_ID` / `AZURE_TENANT_ID` | Tenant used for token issuer and JWKS validation. |
| `ENTRA_API_AUDIENCE` | API app audience/client id. |
| `GOVERNANCE_TRUST_LOOPBACK` | Local-only loopback trust switch. Defaults to enabled. |
| `GOVERNANCE_LOCAL_ADMIN_TOKEN` | Optional local-mode automation bearer token that grants local admin roles. Leave unset for desktop-only one-time login links. |
| `GOVERNANCE_DEVICE_SIGNING_KEY` | HMAC key for local enforcer and hook device tokens. Store in Key Vault/secret manager. |
| `TEAMS_WEBHOOK_URL` | Teams Workflow incoming webhook for alert cards. |
| `ALERT_WEBHOOK_URLS` / `ALERT_WEBHOOK_SECRET` | Comma-separated HMAC-signed webhook targets and signing key. |
| `ACS_ENDPOINT`, `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | Azure Communication Services Email endpoint and sender/recipients. |
| `DASHBOARD_PUBLIC_URL` | Public base URL used in approval/session deep links. |
| `TEAMS_BOT_APP_ID`, `TEAMS_APPROVER_OBJECT_IDS` | Optional Teams bot approval endpoint settings. |

## Device enrollment flow

Local enforcers and repository hooks use compact HS256 JWT device tokens:

1. A `PolicyAdmin` calls `POST /api/gov/devices/enroll` with `{ "deviceId": "...", "roles": ["Agent","Viewer"], "ttlDays": 30 }`.
2. The response contains `{ token, deviceId, expiresAt }`.
3. The enforcer stores the token as `GOVERNANCE_DEVICE_TOKEN` and sends it as `Authorization: Bearer <token>`.

The route is implemented in `src/governance/routes/enroll.ts` but must be mounted at `/api/gov/devices`.

## Local mode trust model

Local mode assumes the monitor is a loopback service for one workstation, but it does **not** treat every loopback process as an administrator. Uncredentialed loopback callers are the `local-agent` principal with only `Agent` and `Viewer`. That is enough for hooks, `/v1` decisions, MCP/dashboard reads, and telemetry, but it cannot approve pending approvals, resume paused sessions, or activate lanes.

Administrative actions in local mode require a local admin session:

1. On startup the server creates in-memory random secrets and prints a parseable one-time URL:
   `AGENTGOV_ADMIN_LOGIN_URL=http://127.0.0.1:<port>/api/gov/local-login?token=...`.
2. The token expires after 5 minutes and is single use.
3. Successful login sets an HttpOnly, `SameSite=Strict`, `Path=/` cookie named `agentgov_admin` with a 12-hour in-memory session and redirects to `/governance`.
4. The Electron shell reads the printed URL from server stdout and opens it automatically so desktop users get the admin cookie without writing secrets to disk.
5. Automation can opt in by setting `GOVERNANCE_LOCAL_ADMIN_TOKEN`; local bearer requests matching that value are compared timing-safely and receive admin roles.

Residual risk: a malicious process running as the same OS user can often inspect process memory, environment, console output, browser state, or local traffic. For strong isolation, run the monitor under a separate OS account or service identity and restrict local port/process access.

## Browser request hardening

Local-mode governance endpoints under `/api`, `/api/gov`, `/v1`, `/hooks`, `/mcp`, and `/ingest` reject DNS-rebinding Host headers unless they are `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>`. State-changing requests reject non-loopback `Origin` headers; Vite development origins on port 5173 are allowed outside production. Mutating `/api/gov` routes require `Content-Type: application/json`. `/live` WebSocket connections reject non-loopback origins in local mode; remote/cloud clients still use bearer-token auth.

## System self-protection guard

`src/governance/system-guard.ts` provides a mode-independent deny guard for actions that target the governance plane itself. It detects loopback calls to the monitor port, edits to lane files, governance database sidecars, hook configuration and forwarder scripts, process-kill commands targeting the monitor runtime, and attempts to set or persist `GOVERNANCE_*`, `AGENT_GOVERNANCE_*`, or `AGENT_MONITOR_*` variables. It is designed to be wired ahead of lane evaluation as a pre-lane deny.

## Hook fail modes

Forwarder scripts support `AGENT_GOVERNANCE_FAIL_MODE=open|closed|auto`. `auto` is the installer default: read-like tools (`view`, `read`, `grep`, `glob`, `ls`, `search`) fail open when the monitor is unreachable; shell, write/edit/create, `web_fetch`, and MCP-like tools fail closed. Explicit `open` or `closed` always wins.

## Threat model notes

- Loopback trust is only for local mode and only for `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`. It grants only `Agent` + `Viewer` unless a valid local admin session or automation token is present. Disable it when local ports are exposed.
- Cloud mode mounts `/api/*` behind `Viewer` and `/ingest/*` behind `Agent`; missing/invalid tokens are rejected.
- Cloud mode rejects missing/invalid tokens with `WWW-Authenticate: Bearer` and OAuth protected-resource metadata.
- Entra validation pins issuer, tenant JWKS, and audience; v2 and v1 issuers are accepted for compatibility.
- `PolicyAdmin` implies `Approver` and `Viewer`; `Approver` implies `Viewer`.
- Webhooks include `X-AgentGov-Timestamp` and `X-AgentGov-Signature: sha256=<HMAC(body)>`; receivers should verify both and reject stale timestamps.
- Alert payloads/cards are redacted before delivery. Do not put raw tool payloads or secrets in alert templates.
- ACS Email uses `DefaultAzureCredential` and scope `https://communication.azure.com/.default`; grant the managed identity the minimum required data-plane role.

## Contract change requests

- Mount `src/governance/routes/enroll.ts` at `/api/gov/devices`.
- Mount `src/governance/alerts/teams-bot.ts` only when `TEAMS_BOT_APP_ID` is set.
