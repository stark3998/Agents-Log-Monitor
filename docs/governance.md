# Agent governance

Agent Monitor is also an inline **governance plane** for AI agents. Every governed agent works inside a **lane**, which states what the agent is for, what it may do, and what it must never do. Actions are checked against the lane at the points where the agent acts, **before they execute**. Each check produces a decision (allow, deny, ask or escalate) with a logged reason.

The idea is that the control lives where the agent acts, not in reading the model's reasoning. See WitnessAI, "What the Hugging Face intrusion teaches about governing autonomous agents".

## Checkpoints

| Checkpoint | What happens | Where |
|---|---|---|
| `goal` | The user's prompt becomes the session goal. The judge extracts it asynchronously when Foundry is configured. | UserPromptSubmit hooks, `POST /v1/goal`, SDK `goal()` |
| `pre_tool` | **Main enforcement point.** Allow / deny / ask / escalate before the tool runs. | PreToolUse hooks, MCP gateway `tools/call`, SDK `check()` |
| `tool_result` | Untrusted results are scanned with Prompt Shields. A detected injection **taints** the session. | PostToolUse hooks, gateway responses, SDK `observeResult()` |
| `spawn` | Subagent start, counted against spawn and depth limits | SubagentStart hooks |
| `response` | Recorded | Stop hooks, SDK `checkResponse()` |
| `admin` | Governed write actions from the MCP server (approve, pause, propose lane…) | `/mcp` write tools |

## Decision pipeline

Implemented in [`src/governance/pdp.ts`](../src/governance/pdp.ts):

1. **Identify** the agent (registry, auto-discovery) and **resolve its lane**: an explicit assignment first, then the best `appliesTo` match by `priority`, then the built-in default lane.
2. **Kill switch**: a paused or quarantined agent or session is denied.
3. **Limits**: action rate, subagent count and depth, token budget, loop detection (the same action N times) and session age. Limits are in-memory locally and use Redis in the cloud.
4. **Deterministic lane rules** (target <1 ms): `deny` always wins, then `approve` (a human is required), then `judge` (the LLM is required), then `allow`.
5. **LLM judge** (Microsoft Foundry): gets the lane, the session goal, the trajectory digest and the action (shaped by the lane's `dataPolicy`). Low confidence escalates to the stronger model, and below `humanBelow` it escalates to a human. A tainted session raises the thresholds.
6. **Human approval**:
   - If the surface supports it, the agent's native permission prompt (`ask`) is used.
   - Otherwise, `enforce+approval` lanes create an approval in the dashboard or Teams and the hook waits for it, up to the lane timeout.
   - Plain `enforce` lanes have no approval workflow, so these actions fall to the fail mode.
7. **Fail mode**: used when the judge times out or errors, or an approval expires.
   - High and critical-risk actions always fail **closed**.
   - Other actions follow the lane's `failMode` per category (the default lanes are closed for EXEC/WRITE/NETWORK/MCP and open for READ).
8. **Record**: the decision is appended to the hash-chained audit log and broadcast live. Alerts are routed, and the Guardian may investigate.

When the judge is **not configured**, judge-gated actions are only failed if they are elevated (risk ≥ medium or a tainted session). Routine work like `npm test` falls through to the lane's allow rules or default.

### Modes

| Mode | Behaviour |
|---|---|
| `observe` | The full pipeline runs, but denies are returned as allow with `wouldDeny=true`. Hook adapters return a neutral/no-opinion response in observe mode (no native allow), so the agent product's normal permission prompt still applies. New and unknown agents start here. |
| `enforce` | Decisions are enforced. Escalations use the native `ask` where available, otherwise the fail mode. |
| `enforce+approval` | Enforced, and escalations and `approve` rules wait for a human (dashboard / Teams / native). |

`GOVERNANCE_ENFORCE=false` forces every lane into observe mode (a global safety switch).

## Enforcement points

| Surface | How to enable | Doc |
|---|---|---|
| Claude Code (CLI, VS Code, Desktop) | `.\install.ps1` | [governance-surfaces.md](governance-surfaces.md) |
| GitHub Copilot CLI | `.\install.ps1 -CopilotHooks` (or `-CopilotPolicyHooks` machine-wide, admin) | [governance-surfaces.md](governance-surfaces.md) |
| Copilot cloud agent | copy `templates/copilot-cloud-agent/.github/hooks` into the repo | [governance-surfaces.md](governance-surfaces.md) |
| VS Code Copilot agent mode | `.\install.ps1 -VSCodeHooks` / `templates/vscode` | [governance-surfaces.md](governance-surfaces.md) |
| Any MCP client (Foundry agents, Copilot Studio, IDEs) | route MCP servers through the gateway: `npm run gateway` | [mcp-gateway.md](mcp-gateway.md) |
| Custom agents (Agent Framework, Semantic Kernel, LangChain, OpenAI Agents) | `packages/sdk-ts`, `packages/sdk-python` | SDK READMEs |

## Querying and operating it

- **Dashboard**: Governance overview, Approvals, Agents (pause/quarantine), Lanes (editor, versions, simulate), Incidents, and "Ask the monitor".
- **MCP server**: `/mcp` (Streamable HTTP) or `npm run mcp` (stdio). Ask any MCP client "what did my agents do today, what was blocked and why?" See [mcp.md](mcp.md).
- **REST**: [governance-api.md](governance-api.md).
- **Guardian, lane drafting and chat**: [intelligence.md](intelligence.md).

## Configuration (environment)

| Variable | Purpose |
|---|---|
| `GOVERNANCE_ENFORCE` | `false` forces observe mode everywhere |
| `GOVERNANCE_LANES_DIR` | Folder of lane YAML files (default: `./lanes`) |
| `FOUNDRY_OPENAI_ENDPOINT` (+ optional `FOUNDRY_OPENAI_API_KEY`) | Enables the LLM judge. Entra auth via `DefaultAzureCredential` when no key is set. |
| `JUDGE_FAST_DEPLOYMENT`, `JUDGE_ESCALATION_DEPLOYMENT`, `INTENT_DEPLOYMENT` | Model deployment names (default `gpt-4.1-mini` / `gpt-5`) |
| `JUDGE_FAST_TIMEOUT_MS`, `JUDGE_ESCALATION_TIMEOUT_MS` | Judge budgets |
| `CONTENT_SAFETY_ENDPOINT` (+ optional key) | Enables Prompt Shields |
| `HOOK_DEADLINE_MS` | Decision deadline for blocking hooks (keep it below the hook timeout) |
| `AGENT_MONITOR_MODE=cloud`, `COSMOS_ENDPOINT`, `REDIS_URL`, `ENTRA_*` | Cloud control plane. See [cloud-mode.md](cloud-mode.md) and [security-auth.md](security-auth.md). |
| `GOVERNANCE_CONTROL_PLANE_URL`, `GOVERNANCE_DEVICE_TOKEN` | Local enforcer ↔ cloud sync |
| `TEAMS_WEBHOOK_URL`, `ALERT_WEBHOOK_URLS`, `ACS_ENDPOINT`… | Alerts. See [security-auth.md](security-auth.md). |
| `INTELLIGENCE_URL` | Python intelligence service (Guardian, drafter, chat) |

## Validation

```powershell
npm run test:gov        # governance unit tests
npm run eval:redteam    # scenario replays (credential drift, metadata endpoint, injection, runaway loops, approvals…)
npx ts-node scripts/eval-judge.ts   # judge precision/recall against eval/judge-cases.jsonl (needs Foundry)
```

## What this does not fix

Checkpoint governance does not replace infrastructure security (least privilege, network controls, secret management) or model alignment. Agents coordinating with each other and pixel-level desktop agents also remain open problems. Decisions are only as complete as the surfaces you route through an enforcement point.
