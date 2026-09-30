# Policies

A **policy** is a reusable, versioned rule set. Lanes describe what one kind of agent is for; policies describe org-wide guardrails that many lanes share, such as "never upload to paste sites", "secrets never leave over the network", or "reading a secret manager needs a human".

- **Global** policies (`global: true`) apply to every lane, narrowed by an optional `scope`.
- **Attached** policies apply only to lanes that list them in `policies: [...]`.
- Policy rules are merged into the lane's rule buckets at decision time. **Deny always wins**, whichever source it comes from.

Policies live in `policies/` (or `GOVERNANCE_POLICIES_DIR`), in the dashboard (**Policies** page), or come from `POST /api/gov/policies`. They use the same lifecycle as lanes:

- Every save creates a new version: `draft`, `proposed`, `active` or `archived`.
- File sync is proposal-first. The first import of a file is `active`. Later file changes become `proposed` and must be activated by a PolicyAdmin, unless `GOVERNANCE_POLICIES_AUTO_ACTIVATE=true` (falls back to `GOVERNANCE_LANES_AUTO_ACTIVATE`).
- The policies directory is protected by the system guard, like the lanes directory. A governed agent cannot write it.

## Example

```yaml
id: no-exfil
name: No uploads to exfiltration destinations
enabled: true
global: true                # applies to every lane in scope
scope: { surfaces: ['*'] }  # surfaces / agents / repos / users globs
mode: inherit               # inherit | observe | enforce
severity: high              # used for policy alerts
rules:
  - id: paste-and-share
    action: deny            # deny | approve | judge | allow | alert
    network: [paste_sites, data_exfil, tunnel_endpoints]
    capability: [web_outbound_send]
  - id: secret-egress
    action: deny
    capability: [web_outbound_send]
    classifier: [aws_key, github_token, private_key]
  - id: secret-manager
    action: approve
    capability: [aws_secret_ops, vault_secret_ops]
  - id: clipboard
    action: alert           # non-blocking: recorded on the decision and routed as an alert
    capability: [clipboard_read]
```

The built-in [`policies/org-baseline.yaml`](../policies/org-baseline.yaml) covers these guardrails:

- metadata endpoints
- drive-by `curl | bash`
- exfiltration destinations
- secret egress
- OS credential stores
- secret-manager reads and infrastructure teardown (both need a human)
- alerts for persistence and screen/clipboard capture

It ships with `mode: inherit`, so it follows each lane's mode. With the built-in lanes in observe mode, it only records would-deny decisions.

## Rule conditions

All fields present in one rule must match (AND). List values match when any item matches (OR). Policy rules accept every [lane condition](lanes.md#rule-conditions), plus these preset-aware fields. The same fields also work in lane rules.

| Field | Values | Matches |
|---|---|---|
| `filesystem` | Filesystem preset ids (`user_documents`, `system_config`…) or path globs | Paths in the action. `~`, `$WORKDIR`/`${workspace}` and, on Windows, `%USERPROFILE%` / `%APPDATA%` / `%LOCALAPPDATA%` are expanded. Relative paths resolve against the workspace. |
| `credential` | Credential preset ids (`ssh_keys`, `kube_config`, `all_creds`…) or path globs | Same as `filesystem` |
| `network` | Network preset ids (`paste_sites`, `cloud_metadata`…) or host globs | Hosts and domains in the action. `*.example.com` also matches `example.com`. |
| `capability` | Capability preset ids (`shell_exec`, `web_outbound_send`, `git_destructive_ops`…) | What the action does, detected from the tool and the shell command (bash, zsh, PowerShell, cmd). A parent matches its subsets: `web_access` matches `curl_to_shell`. `*` / `all_capabilities` match every action. |
| `mcpCategory` | MCP category preset ids (`mcp_code_hosting`, `mcp_databases`…) or server-name globs | The MCP server name. It also matches the category's `identities` (`npm:<pkg>`, `pypi:<pkg>`, hosts) when the enforcer sends `meta.mcpPackage` / `meta.mcpUrl` / `meta.mcpIdentities`. |
| `classifier` | **Enforceable** [data classifier](classifiers.md) codes | Sensitive data in the tool arguments. Classifiers that are switched off for analytics still run on demand for these rules. |
| `operation` | `read`, `write`, `delete`, `execute` | Coarse operation derived from the tool category and capabilities |

The full preset catalog is at `GET /api/gov/presets`, the **Presets** tab in the dashboard, and the MCP tool `list_policy_presets`.

Validation rejects:

- unknown capability ids
- unknown or non-enforceable classifiers
- duplicate rule ids
- rules with no match fields, because they would match every action

## Modes

| `mode` | Deny / approve rules from this policy |
|---|---|
| `inherit` (default) | Follow the lane's mode |
| `enforce` | Enforce even when the lane is in `observe`. Approve rules use the native `ask` where available, otherwise the lane fail mode. |
| `observe` | Never block. In an enforcing lane, a matching deny is recorded as `wouldDeny` with the reason `observe-only policy would deny: …`, and the lane still decides the action. |

`GOVERNANCE_ENFORCE=false` still forces everything into observe mode.

## Decisions and audit

- Merged policy rules appear in decisions as `policy:<policyId>/<ruleId>`.
- The effective lane carries `meta.appliedPolicies` and a `policyStamp`, so decision caches reset when the applied policy set changes.
- Alert rules add their ids to the decision and raise a `policy` alert. Its severity comes from the policy's `severity` (default `medium`), routed by the lane's alert channels.

## Simulation

- `POST /api/gov/policies/simulate` replays one policy over recorded tool calls, ignoring scope. It returns counts per verdict, `ruleHits` per rule and samples.
- `POST /api/gov/lanes/simulate` now includes the active policies that would apply, so a lane replay matches enforcement.
- `GET /api/gov/policies/effective?laneId=` shows a lane's merged rule set.

## Permissions

- Viewers and agents may only *propose* policies (API or the MCP tool `propose_policy`).
- PolicyAdmins can save drafts and activate versions.
- Activating a policy that can apply to the monitor's own agents requires a **human** PolicyAdmin: an Entra user, or the local console admin. Agent and device principals can't. This covers any global policy whose scope includes `*` or `monitor`, and any policy attached to a monitor lane. It prevents the Guardian from loosening its own constraints.
