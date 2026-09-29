# Python intelligence service

The `intelligence/` service is a FastAPI companion to the TypeScript governance control plane. It uses Microsoft Agent Framework for Python with Microsoft Foundry / Azure OpenAI deployments and authenticates with `DefaultAzureCredential`.

## Capabilities

- **Guardian investigator** polls `/api/gov/decisions` and can also be triggered through `POST /investigate`. It opens/updates incidents, investigates via the monitor MCP server, and writes a Markdown report.
- **Lane drafter** accepts `{ agentId, description?, systemPrompt? }`, builds a recent activity baseline, drafts lane YAML, validates it, retries once on validation errors, simulates it, and creates a `proposed` lane.
- **Ask the monitor** accepts chat messages and streams Server-Sent Events: `delta`, `tool`, `citation`, and `done`.

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
