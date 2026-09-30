# AgentGov Intelligence Service

FastAPI service that adds AI-assisted governance capabilities to the TypeScript control plane:

- Guardian investigator agent for incident triage and governed containment.
- AI lane drafter that proposes lane YAML in `proposed` status.
- "Ask the monitor" streaming chat over Server-Sent Events.

The implementation uses Microsoft Agent Framework for Python (`agent-framework` 1.x), Azure OpenAI / Microsoft Foundry model deployments, and `DefaultAzureCredential`. No API keys are required (the optional Jev shadow uses `TYPESAFE_API_KEY`).

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
| `TYPESAFE_API_KEY` | | Enables the Jev triage shadow (opt-in; see below). |
| `TYPESAFE_BASE_URL` | SDK default | Alternative TypeSafe-compatible API URL. |
| `JEV_MODEL` | `jev-1.13.0` | Pinned, versioned Jev model (combine thresholds are tuned per version). |
| `JEV_TIMEOUT_MS` | `2000` | Hard timeout per Jev call (no retries). |
| `JEV_SHADOW` | `on` (when key set) | Master switch for Jev shadow mode. |
| `JEV_SHADOW_GUARDIAN` | `on` | Guardian-triage shadow specifically. |

## Jev triage shadow (TypeSafe System One)

When `TYPESAFE_API_KEY` is set, every Guardian trigger is also triaged by TypeSafe **Jev** in
**shadow mode** — it never changes what Guardian does. `jev_triage.py` sends a filtered state
(trigger kind/reason, counts and flags computed in code, the last ≤20 relevant decisions with
tool/verdict/stage/reason/risk; no raw payloads, no detector severity) and four typed questions
(`TRIAGE_QUESTIONS`): `severity` (Score: low/medium/high/critical), `incident_type` (Choice),
`needs_investigation` and `likely_false_positive` (Noul). Code combines them into a severity label,
type, investigate flag and confidence.

Triage starts concurrently with the Guardian investigation and the result is posted in the
background to `POST /api/gov/jev/shadow` as a `guardian_triage` record; Jev/monitor errors and
timeouts are swallowed. Baseline mapping: `baseline.verdict` is the Guardian LLM's own assessment
from the `Severity: <level>` line it is instructed to end its report with (`info` → `low`). The
incident's pre-filled `severity` comes from the heuristic trigger detector, so it is deliberately not
used. The verdict is `investigated` when the report has no severity line and `skipped` when the
investigation failed. `agree` is set only when both sides produced a severity label.

Benchmark the question set offline (skips with exit 0 when no key):

```powershell
.\.venv\Scripts\python scripts/eval_triage.py --show-misses --json   # writes ../eval/results/triage-*.json
```

Re-run it after any wording change in `TRIAGE_QUESTIONS` or `JEV_MODEL` bump.

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
