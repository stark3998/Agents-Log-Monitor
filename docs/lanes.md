# Lanes reference

A lane is an agent's purpose written down as enforceable policy. Lanes are YAML files in `lanes/` (or `GOVERNANCE_LANES_DIR`), edited in the dashboard, or drafted by the AI lane drafter. Every save creates a new **version**. Only one version per lane id is `active`; the others are `draft`, `proposed` or `archived`.

**File sync is proposal-first after bootstrap.** On first run, a lane file with no stored versions is imported as `active` so a fresh deployment starts working. After that, changed file content is imported as a new `proposed` version and must be activated by a PolicyAdmin in the UI/API; this prevents a governed agent that can write the lanes directory from silently changing its own active policy. GitOps deployments where the lanes directory is read-only to agents can set `GOVERNANCE_LANES_AUTO_ACTIVATE=true` to keep importing changed files as `active`. Edits made in the UI therefore persist until the file itself changes and an admin activates the proposal (or auto-activation is enabled). In hybrid deployments, lanes pulled from the cloud control plane win over local lanes with the same id.

## Example

```yaml
id: coding-agent
version: 1
name: Coding agent lane
priority: 100                     # higher wins when several lanes apply
appliesTo:
  surfaces: [claude-code, copilot-cli, vscode, copilot-cloud-agent]   # or ['*']
  agents: ['*']                   # registry id / external id / name globs
  repos: ['*']
  users: ['*']
purpose: Help a developer read, modify, build and test code in the current repository.
dos:
  - Read and edit source files in the workspace.
  - Run tests, builds, linters and local development commands.
never:
  - Read or exfiltrate secrets from home, cloud, SSH, environment or credential stores.
  - Contact metadata endpoints or internal admin endpoints.
rules:
  deny:                           # always wins
    - id: credential-paths
      path: ['~/.ssh/**', '~/.aws/**', '**/.env']
    - id: metadata-endpoints
      domain: ['169.254.169.254', 'metadata.google.internal']
    - id: critical-risks
      risk: [rm-root, pipe-to-shell, disk-wipe, disable-security, secret-egress]
  approve:                        # needs a human (native ask / dashboard / Teams)
    - id: publish-or-push
      risk: [publish, force-push]
  judge:                          # needs the LLM judge
    - id: exec-network-mcp
      category: [EXEC, NETWORK, MCP]
  allow:
    - id: read-workspace
      category: [READ]
      path: ['${workspace}/**']
defaultVerdict: allow             # allow | deny | judge — when nothing matched
mode: observe                     # observe | enforce | enforce+approval
failMode: { default: closed, READ: open }
approval: { channels: [native, dashboard, teams], timeoutSec: 120, approvers: ['group:agent-approvers'] }
judge: { model: fast, escalateBelow: 0.72, humanBelow: 0.45, dataPolicy: redacted, timeoutMs: 4000 }
limits: { actionsPerMin: 120, maxSubagents: 5, maxDepth: 2, tokenBudget: 2000000, loopThreshold: 8, maxSessionMinutes: 480 }
promptShields: { enabled: true, scan: [NETWORK, MCP], taintTtlActions: 20 }
alerts: { high: [teams, webhook], critical: [teams, email, webhook] }
sync: { dataPolicy: redacted }    # what local enforcers send to the cloud
guardian: { authority: contain }  # recommend | contain | autonomous
```

## Rule conditions

All fields present in one condition must match (AND). List values match if any item matches (OR).

| Field | Matches |
|---|---|
| `category` | `READ`, `WRITE`, `EXEC`, `NETWORK`, `AGENT`, `MCP`, `OTHER` ([classification](analytics.md#tool-classification--classifyts)) |
| `tool` | Tool name globs, checked against both the raw name (`powershell`, `mcp__github__create_issue`) and the canonical name (`Bash`) |
| `mcpServer` | MCP server name globs |
| `risk` | Risk rule ids from [analytics.md](analytics.md#risk-rules--riskts) (`cred-read`, `force-push`…), custom rule ids, or a level (`medium` matches medium and above) |
| `path` | Path globs. `~` is the home directory and `${workspace}` is the agent's working directory. Paths come from path fields and from paths inside shell commands. |
| `domain` | Host globs, **including private and link-local hosts** (e.g. `169.254.169.254`) |
| `command` | Regexes tested against the shell command text |
| `detector` | Sensitive-data detector keys (`github_token`, `aws_key`…) found in the arguments |
| `tainted` | `true` matches only while the session is tainted by detected prompt injection |
| `filesystem`, `credential`, `network`, `capability`, `mcpCategory`, `classifier`, `operation` | Preset-aware conditions shared with [policies](policies.md#rule-conditions), such as `capability: [web_outbound_send]`, `network: [paste_sites]` or `classifier: [us_ssn]` |
| `id`, `description` | Shown in decisions, the audit log and deny reasons |

## Rule buckets

| Bucket | Effect |
|---|---|
| `deny` | Always wins |
| `approve` | Needs a human |
| `judge` | Needs the LLM judge |
| `allow` | Allowed when nothing above applies |
| `alert` | Non-blocking: the rule id is recorded on the decision and a `policy` alert is routed |

## Policies

`policies: [no-exfil, pii-guard]` attaches reusable [policies](policies.md) to a lane. Global policies apply without being listed. At decision time their rules are merged into the lane's buckets with ids `policy:<policyId>/<ruleId>`, and deny wins across all sources. `GET /api/gov/policies/effective?laneId=` shows the merged rule set. Lane simulation includes applicable policies.

## Defaults

| Field | Default |
|---|---|
| `mode` | `observe` |
| `defaultVerdict` | `allow` |
| `failMode` | `{ default: closed, READ: open }`. High and critical-risk actions always fail closed. |
| `approval` | `{ channels: [dashboard], timeoutSec: 120 }` |
| `judge` | `{ escalateBelow: 0.7, dataPolicy: redacted }` |
| `appliesTo` | everything (`['*']`) |

## Judge data policy

| `dataPolicy` | Sent to the Foundry judge |
|---|---|
| `redacted` | Tool arguments with secrets and personal data masked by the built-in detectors |
| `full` | Raw arguments (same-tenant deployments only) |
| `metadata-only` | Tool, category, risk ids, hosts and paths only; no arguments |

## Built-in lanes

| Lane | Applies to | Notes |
|---|---|---|
| `default` | everything (priority -1000) | Baseline for unknown agents, in observe mode |
| `coding-agent` | Claude Code, Copilot CLI / cloud agent, VS Code | Observe mode. Switch to `enforce` once the would-deny rate looks right. |
| `monitor-guardian` | the monitor's own agents (surface `monitor`) | Prevents the Guardian from changing its own lane |

## Workflow

1. Start new agents in `observe`. Review would-deny decisions on the Governance page.
2. Tune the rules. Use **Simulate against history** (`POST /api/gov/lanes/simulate`) to replay a draft over past events.
3. Switch to `enforce`. Use `enforce+approval` where a human must sign off on escalations.
4. Let the Guardian propose lane changes from incidents. Proposals are never activated automatically.
