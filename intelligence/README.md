# AgentGov Intelligence Service

FastAPI service that adds AI-assisted governance capabilities to the TypeScript control plane:

- Guardian investigator agent for incident triage and governed containment.
- AI lane drafter that proposes lane YAML in `proposed` status.
- "Ask the monitor" streaming chat over Server-Sent Events.

The implementation uses Microsoft Agent Framework for Python (`agent-framework` 1.x), Azure OpenAI / Microsoft Foundry model deployments, and `DefaultAzureCredential`. No API keys are required.

## Configuration

In a source checkout, settings are read from the repo-root `.env` (see [`../.env.example`](../.env.example)); variables already set in the environment take precedence and empty values are ignored. Set `AGENT_MONITOR_ENV_FILE` to use another file or `none` to skip it. Installed wheels and containers use real environment variables only.

| Variable | Default | Purpose |
|---|---:|---|
| `AZURE_OPENAI_ENDPOINT` | | Azure OpenAI-compatible Foundry endpoint. |
| `FOUNDRY_PROJECT_ENDPOINT` | | Foundry project endpoint fallback. |
| `GUARDIAN_DEPLOYMENT` | `gpt-5` | Guardian model deployment. |
| `CHAT_DEPLOYMENT` | `gpt-4.1` | Chat model deployment. |
| `DRAFTER_DEPLOYMENT` | `CHAT_DEPLOYMENT` | Lane drafter deployment. |
| `MONITOR_MCP_URL` | `http://127.0.0.1:4317/mcp` | Monitor MCP streamable HTTP endpoint. |
| `MONITOR_API_URL` | `http://127.0.0.1:4317` | Monitor REST base URL. |
| `MONITOR_TOKEN` | | Bearer token for monitor REST/MCP. |
| `ENTRA_API_AUDIENCE` | | Audience for managed identity tokens to the monitor. |
| `GUARDIAN_AUTHORITY` | `recommend` | `recommend`, `contain`, or `autonomous`. |
| `GUARDIAN_POLL_SECONDS` | `30` | Polling interval. |
| `GUARDIAN_ENABLED` | `true` | Starts the background loop. |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | | Enables Azure Monitor OpenTelemetry. |

## Local development

```powershell
cd intelligence
python -m venv .venv
.\.venv\Scripts\python -m pip install -e .[dev]
.\.venv\Scripts\python -m pytest -q
.\.venv\Scripts\python -m uvicorn agentgov_intel.app:app --reload
```

## Agent Framework API references

- Microsoft Agent Framework overview: https://learn.microsoft.com/agent-framework/overview/agent-framework-overview
- Python package README: https://github.com/microsoft/agent-framework/tree/main/python
- MCP streamable HTTP tool sample: https://github.com/microsoft/agent-framework/blob/main/python/samples/02-agents/mcp/mcp_api_key_auth.py

The service imports Agent Framework lazily through `af_adapter.py`, so unit tests can run with fakes and no network.
