# Dashboard

The web UI (React, Vite, Material UI) is served by the monitor server at `http://127.0.0.1:4317`. It builds from
[`web/`](../web/) into `public/`. Pages marked **governance** appear when the governance plane is enabled. In cloud mode,
users sign in with Microsoft Entra ID (MSAL), and each page's actions require the matching role (Viewer, Approver,
PolicyAdmin). See [security-auth.md](security-auth.md).

Live updates arrive over the `/live` WebSocket. When it's unavailable, pages fall back to polling.

## Contents

- [Monitoring pages](#monitoring-pages)
- [Governance pages](#governance-pages)
- [Monitoring fleet and evaluation pages](#monitoring-fleet-and-evaluation-pages)
- [Settings, privacy and tuning](#settings-privacy-and-tuning)

## Monitoring pages

| Page | Route | What it shows |
|---|---|---|
| **Overview** | `/overview` | KPI cards (active agents, sessions, sessions with sensitive data, risky actions, blocked or warned actions), each with the change against the previous period and a sparkline. It also has an activity trend chart, a Top Agents table, and a heatmap of the MCP servers and external domains each agent reached. Every card, row and heatmap cell opens a filtered conversation list. |
| **Conversations** | `/conversations`, `/conversations/:id` | Filterable, sortable table: agent, endpoint, user, severity, autonomy, detected data, enforcement, channel. A row opens a resizable, deep-linkable drawer (`?c=<id>`) with the full timeline. |
| **Enforcements** | `/enforcements` | Governance decisions and policy events: blocked tool calls, permission denials and prompts, warnings, tainted sessions. |

The conversation timeline includes:
- prompts and Markdown replies, with reasoning collapsed
- consecutive tool calls grouped, each expandable to its request and response
- subagent threads and findings
- search within the conversation (Ctrl+F, then Enter / Shift+Enter)
- All / Messages / Tools / Findings filters
- live follow with a jump-to-latest button
- Markdown or JSON export

How findings, risk and severity are computed: [analytics.md](analytics.md).

## Governance pages

| Page | Route | What it shows |
|---|---|---|
| **Governance** | `/governance` | Governance overview: decisions over time (allowed, denied, and would-deny in observe mode), recent denies, requests waiting for approval. |
| **Approvals** | `/approvals` | Pending human approvals, soonest to expire first, plus the last 50 resolved. Teams approval cards link straight to their request. |
| **Agents** | `/agents` | Agent registry, discovered automatically the first time an enforcement point sees an agent. PolicyAdmins can pause (kill switch), resume or quarantine an agent. |
| **Lanes** | `/lanes`, `/lanes/:id` | Lanes as code. The lane editor has a YAML/form view, a diff against the active version, simulation against history, AI-drafted proposals, and activation. See [lanes.md](lanes.md). |
| **Policies** | `/policies`, `/policies/:id` | Tabs for Policies, Classifiers and Presets: reusable policies, 96 data classifiers with toggles and custom regex, and preset catalogs (filesystem, network, credential, capability, MCP category). See [policies.md](policies.md) and [classifiers.md](classifiers.md). |
| **Posture** | `/posture` | Endpoint posture: findings, checks configuration, endpoints, one-click fixes. See [posture.md](posture.md). |
| **Incidents** | `/incidents`, `/incidents/:id` | Incidents raised by the governance plane, the Guardian investigator, or the monitoring fleet (trigger `fleet:*`). The detail view shows the report, alert ids and recommendations. Containment recommendations are proposals that a human applies. |
| **Ask** | `/ask` | "Ask the monitor": chat that answers from the project documentation and cites the pages it used (links open in the Docs tab). With `INTELLIGENCE_URL` set it's served by the [intelligence service](intelligence.md), which can also read live monitor data. Without it, the monitor answers from the docs itself using a Microsoft Foundry deployment (`FOUNDRY_OPENAI_ENDPOINT`). `/ask?q=…` sends that question straight away. |

## Documentation

| Page | Route | What it shows |
|---|---|---|
| **Docs** | `/docs`, `/docs/<id>` | Every Markdown document in the repository (this folder, the READMEs, infrastructure and SDK docs). They're grouped into the sections of the [docs index](README.md), and anything not listed there goes under "More in the repository". The landing page lists every document with a short description. A doc page shows the rendered document, an "On this page" contents list, the pages it links to and the pages that reference it, and previous/next links. Relative links between docs open inside the tab. Links to other repository files are shown as plain text. |

Docs search (`/` or Ctrl+K to focus, Enter to open the top hit, Esc to clear) ranks heading-level sections with BM25 and matches the word you're still typing as a prefix. Results jump straight to the matching heading. **Ask the assistant** hands the query over to Ask. Doc ids are the path under `docs/` without `.md` (`fleet`, `architecture/agents`), or `repo/<path>` for other files (`repo/infra/README`). The API is `GET /api/docs`, `GET /api/docs/page?id=…` and `GET /api/docs/search?q=…` (Viewer in cloud mode). The index refreshes within seconds of a file changing. Paths ignored by the root `.gitignore` (such as `eval/results/`) are excluded.

## Monitoring fleet and evaluation pages

| Page | Route | What it shows |
|---|---|---|
| **Fleet** | `/fleet` | Alerts from the [monitoring fleet](fleet.md) about Foundry and Copilot Studio agents and direct model callers, mapped to OWASP LLM, OWASP Agentic (ASI) and MITRE ATLAS. It has a 24h / 7d / 30d window, KPI tiles, and bars by severity, alert type, platform and agent. Clicking a bar filters the table. |
| **Jev vs LLM** | `/jev` | TypeSafe Jev shadow results compared with the LLM judge, Prompt Shields, Guardian and heuristic session severity: agreement, latency and cost. Fleet shadow kinds appear under "Fleet ·" tabs. See [scan-methodology.md](scan-methodology.md) and [jev.md](jev.md). |

The Fleet page has three tabs:
- **Alerts**: a filterable table (severity, type, platform, agent, session, incident) with an alert drawer showing evidence.
- **Agents**: a per-agent roll-up.
- **Session timeline**: the alerts of one monitored conversation in order.

It updates live from `gov.fleet.alerts` WebSocket messages. The data comes from `POST /api/gov/fleet/alerts`, which the fleet's dashboard sink calls ([governance-api.md](governance-api.md)).

## Settings, privacy and tuning

The **Settings** dialog (tune icon) shows collector health and setup steps, the effective detection rules, and privacy and storage status. Other UI features:
- alerts for high-severity conversations
- CSV and JSON Lines export of activity
- dark theme by default, plus a light theme
- reduced motion when the OS asks for it

**Privacy:**
- **Payload redaction is on by default.** Secrets (API keys, tokens, passwords, connection strings, private keys) are masked before payloads are stored, for example `ghp_****a1f3`. Detection runs on the raw content first, so findings are unaffected. `REDACT_PAYLOADS=off|secrets|all` controls the level; `all` also masks e-mail addresses. When you raise the level, events stored earlier are redacted in the background on the next start.
- **Findings never store raw values**, only masked samples.
- The monitoring fleet redacts secrets and PII in captured agent content before storage and before any LLM analysis ([fleet.md](fleet.md#redaction)).

**Tuning:** severity, risk and detections are advisory heuristics. You tune them in `agent-monitor.rules.json` next to the database, or at the path set by `AGENT_MONITOR_RULES`. You can:
- override, disable or add regex risk rules
- disable detectors
- ignore domains
- change severity thresholds

Edits are picked up while the server runs, and stored events are re-analyzed in the background. See [analytics.md](analytics.md#tuning--agent-monitorrulesjson).
