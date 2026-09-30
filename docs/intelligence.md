# Python intelligence service

The `intelligence/` service is a FastAPI companion to the TypeScript governance control plane. It uses Microsoft Agent Framework for Python with Microsoft Foundry / Azure OpenAI deployments and authenticates with `DefaultAzureCredential`.

## Capabilities

- **Guardian investigator** polls `/api/gov/decisions` and can also be triggered through `POST /investigate`. It opens/updates incidents, investigates via the monitor MCP server, and writes a Markdown report.
- **Lane drafter** accepts `{ agentId, description?, systemPrompt? }`, builds a recent activity baseline, drafts lane YAML, validates it, retries once on validation errors, simulates it, and creates a `proposed` lane.
- **Ask the monitor** accepts chat messages and streams Server-Sent Events: `delta`, `tool`, `citation`, and `done`. Answers are grounded in the project documentation. The service searches the monitor's docs catalog (`GET /api/docs/search?text=1`) for the latest question and attaches the top sections to the prompt. The agent can call the `search_docs` / `get_doc` MCP tools for more, and cites pages as `/docs/<id>#<anchor>` links, which become `doc` citations. It also uses the read-only monitor tools for live agents, sessions, decisions and incidents.

When `INTELLIGENCE_URL` isn't set, the monitor server answers Ask itself. The built-in docs agent (`src/docs/ask-agent.ts`) does the same docs retrieval and citation, has only the doc tools, and calls the Foundry deployment `ASK_DEPLOYMENT` (default `CHAT_DEPLOYMENT`, then `JUDGE_FAST_DEPLOYMENT`) on `FOUNDRY_OPENAI_ENDPOINT`. It authenticates with `FOUNDRY_OPENAI_API_KEY` or `DefaultAzureCredential`. Reasoning deployments (`gpt-5*`, `o*`) run with `reasoning_effort=low` unless `ASK_REASONING_EFFORT` says otherwise (`off` omits it).
- **Jev triage shadow** (opt-in via `TYPESAFE_API_KEY`) runs TypeSafe Jev next to each Guardian investigation and records a non-authoritative `guardian_triage` comparison — see below.

## Jev triage shadow

Jev (TypeSafe System One) answers four typed questions per Guardian trigger — `severity` (Score), `incident_type` (Choice), `needs_investigation` and `likely_false_positive` (Noul) — over a filtered state (counts computed in code, ≤20 decisions, no raw payloads). The triage runs concurrently with the Guardian LLM, never alters Guardian's behaviour, and is posted to `POST /api/gov/jev/shadow` with `kind: "guardian_triage"`, `baseline` = Guardian (the severity from the `Severity: <level>` line the Guardian LLM is instructed to end its report with; the incident's pre-filled heuristic severity is deliberately ignored; else `investigated`/`skipped`) and `jev` = the combined severity, score, confidence, latency, tokens and raw signals. Configure with `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEV_MODEL` (pinned `jev-1.13.0`), `JEV_TIMEOUT_MS` (2000), `JEV_SHADOW`, `JEV_SHADOW_GUARDIAN`. Benchmark offline with `intelligence/scripts/eval_triage.py` over `eval/triage-cases.jsonl`.

## Guardian authority

Authority is controlled by `GUARDIAN_AUTHORITY`:

| Mode | Tool exposure |
|---|---|
| `recommend` | Read-only MCP tools; incident report and recommendations only. |
| `contain` | Read tools plus `pause_agent`, `quarantine_session`, `create_incident`, `update_incident` for high-confidence containment. |
| `autonomous` | Containment tools plus `propose_lane_change`; proposals remain human-activated. |

The allow-list is enforced in code when constructing `MCPStreamableHTTPTool`. The Guardian must never modify the lane that governs itself (`monitor-guardian`).

## Endpoints

| Method | Path | Response |
|---|---|---|
| `GET` | `/health` | `{ ok, guardian }` |
| `POST` | `/chat` | `text/event-stream` with documented event JSON. |
| `POST` | `/lanes/draft` | `{ lane, rationale, simulation }` |
| `POST` | `/investigate` | `Incident` |

The TypeScript control plane proxies these at `/api/gov/intelligence/*`, forwarding the caller `Authorization` header. Chat requires `Viewer`; drafting and investigation require `PolicyAdmin`.

## Configuration

See `intelligence/README.md` for environment variables. The important URLs are:

- `MONITOR_API_URL` for `/api/gov` REST.
- `MONITOR_MCP_URL` for streamable HTTP MCP tools.
- `AZURE_OPENAI_ENDPOINT` or `FOUNDRY_PROJECT_ENDPOINT` for model clients.

Set `MONITOR_TOKEN` for local testing, or set `ENTRA_API_AUDIENCE` so managed identity obtains a token for the monitor API.

## Local run

```powershell
cd intelligence
python -m venv .venv
.\.venv\Scripts\python -m pip install -e .[dev]
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python -m uvicorn agentgov_intel.app:app --host 127.0.0.1 --port 4321
```

Then start the TypeScript service with `INTELLIGENCE_URL=http://127.0.0.1:4321`.
