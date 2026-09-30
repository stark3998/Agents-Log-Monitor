# Governance hook surfaces

This page records the native hook contracts used by the governance `/hooks/*` adapters. Verified 2026-09-29 against the official references linked below. Where a provider marks behavior as preview or ambiguous, the row says so explicitly.

## Contract table

| Surface | Config locations / format | Enforced events and request fields | Native decision response | Ask support | Timeout / failure behavior |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`, managed policy settings, plugin/skill/subagent hook frontmatter. Settings use PascalCase events with matcher groups: `{ "hooks": { "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "http", "url": "...", "timeout": 120 }] }] } }`. | Common fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, optional `agent_id`, `agent_type`. `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`. `UserPromptSubmit`: `prompt`. `PostToolUse`/`PostToolUseFailure`: `tool_name`, `tool_input`, `tool_result` or `error`. `SubagentStart`: subagent identity. `Stop`/`SubagentStop`: final/stop fields including assistant text where provided. | `PreToolUse`: `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow|deny|ask", "permissionDecisionReason": "..." } }`. `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop`: top-level `{ "decision": "block", "reason": "..." }` blocks/continues where the event can be blocked. Neutral is `{}` or empty body. | Yes for `PreToolUse` JSON `permissionDecision: "ask"`. Other events do not have a native ask prompt; use block/continue semantics. | Hook `timeout` defaults vary; command/http/mcp default is 600s, but `UserPromptSubmit` defaults 30s. HTTP hook failure, non-2xx, invalid body, connection failure, or timeout is non-blocking/fail-open; blocking requires a 2xx JSON decision. Command exit `2` blocks for blockable events; timed-out command `PreToolUse` fails open. Output strings are capped at 10,000 chars. |
| GitHub Copilot CLI | Policy JSON: Linux/macOS `/etc/github-copilot/policy.d/*.json`, Windows `C:\ProgramData\GitHub\Copilot\policy.d\*.json`, or Windows registry `HKLM\Software\Policies\GitHub\Copilot`. User JSON: `~/.copilot/hooks/*.json` or `%USERPROFILE%\.copilot\hooks\*.json` (or `$COPILOT_HOME/hooks`). Repository JSON: `.github/hooks/*.json`; inline `.github/copilot/settings*.json`, repository `.claude/settings*.json`, user `~/.copilot/settings.json`; plugins. Format `{ "version": 1, "hooks": { "preToolUse": [{ "type": "command", "bash": "...", "powershell": "...", "timeoutSec": 30 }] } }`. | Two payload styles. camelCase events/fields: `sessionId`, `timestamp` (epoch ms), `cwd`, `toolName`, `toolArgs`, `toolResult`, `error`, `prompt`, `transcriptPath`. PascalCase/VS Code-compatible events use `hook_event_name`, `session_id`, ISO `timestamp`, `tool_name`, `tool_input`, `tool_result`, `transcript_path`. Enforced: `preToolUse`/`PreToolUse`; observed/mapped: user prompt, post tool, stop, subagent. | `preToolUse`: a single JSON object on stdout/HTTP body: `{ "permissionDecision": "allow|deny|ask", "permissionDecisionReason": "..." }`; optional `modifiedArgs`. `permissionRequest`: `{ "behavior": "allow|deny", "message": "...", "interrupt": true? }`. `agentStop`/`subagentStop`: `{ "decision": "block|allow", "reason": "..." }`. `postToolUse`: `modifiedResult` or `additionalContext`; it is not a hard pre-action gate. | Yes for CLI `preToolUse` when a prompt can be shown. The user may add feedback to a denial. `permissionRequest` has allow/deny only. | Command hook stdout may include progress JSON lines, but the final preserved output must parse as exactly one JSON object. HTTP hooks default to HTTPS; localhost HTTP is allowed only with `COPILOT_HOOK_ALLOW_LOCALHOST=1`, and `preToolUse`/`permissionRequest` HTTP hooks must use HTTPS because they can grant permissions. Command `preToolUse` is fail-closed on non-timeout errors/exit `2`, but all command timeouts are fail-open, including policy hooks. HTTP `preToolUse` network errors, non-2xx, and timeouts are fail-open. Hook output limit is 10 MiB. |
| GitHub Copilot cloud agent | Repository-only `.github/hooks/*.json`; only Linux sandbox `bash` (or `command` fallback) is honored. The sandbox starts in `/workspace` when a repo is cloned. | Same Copilot payload shapes for supported events. Cloud fires a subset: `sessionStart`, at most one `userPromptSubmitted`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `agentStop`, `subagentStart`, `subagentStop`, `sessionEnd`, and auto `preCompact`. Cloud does not surface notifications to a user. | Same `preToolUse` JSON shape as Copilot CLI. `ask` is treated as `deny` because cloud jobs are non-interactive. Stop/subagent block can force another turn until job timeout/runaway guard. | No effective ask; native `ask` is treated as deny. | Ephemeral Linux filesystem. Outbound network is restricted to GitHub/Copilot by default; the governance control-plane host must be firewall allow-listed. Environment includes `GITHUB_COPILOT_API_TOKEN`, `GITHUB_COPILOT_GIT_TOKEN`, `COPILOT_AGENT_PROMPT`; `GITHUB_TOKEN` is not set. Hooks are non-interactive and all tool permissions are pre-granted, so use `preToolUse` for policy. |
| VS Code Local harness | `.github/hooks/*.json`, `~/.copilot/hooks/*.json`, optional Claude-format files when `chat.useClaudeHooks` is enabled, plus custom-agent frontmatter and plugins. Native Local format uses PascalCase events and command entries: `{ "hooks": { "PreToolUse": [{ "type": "command", "command": "...", "windows": "...", "timeout": 15 }] } }`. `chat.useHooks` is on by default; workspace hooks require Workspace Trust. | Common fields: ISO `timestamp`, optional `cwd`, optional `session_id`, `hook_event_name`, optional `transcript_path`. `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`. `PostToolUse`: `tool_name`, `tool_input`, `tool_use_id`, `tool_response`. `UserPromptSubmit`: `prompt`. `SubagentStart`: `agent_id`, `agent_type`. `Stop`/`SubagentStop`: `stop_hook_active`, and subagent identity. | Common: `{ "continue": false, "stopReason": "...", "systemMessage": "..." }`. `PreToolUse`: `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow|deny|ask", "permissionDecisionReason": "...", "updatedInput": {}, "additionalContext": "..." } }`. `PostToolUse`: `{ "decision": "block", "reason": "..." }`. `Stop`: `{ "hookSpecificOutput": { "hookEventName": "Stop", "decision": "block", "reason": "..." } }`. | Yes for Local `PreToolUse`. | Native timeout default is 30s. Exit code `0` processes stdout JSON; exit `2` blocks and provides stderr to the model; other exits warn and continue. The Local docs are preview and warn that Agent Host harnesses (Copilot, Claude, Codex) use provider-specific contracts even when VS Code displays the hook file. |
| Microsoft Foundry Agent Service MCP tool | Not a local hook surface. MCP tools are attached to Foundry prompt/hosted agents through `MCPTool`, Foundry Toolboxes, or `ResponseTool.CreateMcpTool`. The MCP server can be public or private; Toolbox endpoints centralize auth/versioning/policy. | Tool configuration includes `server_label`/`server_url` and `require_approval` (for example `"always"` in Python/TypeScript) or .NET `McpToolCallApprovalPolicy(GlobalMcpToolCallApprovalPolicy.AlwaysRequireApproval)`. Approval request items include server label, tool name, arguments, and approval request id. | The application/runtime sends an MCP approval response, e.g. Python `McpApprovalResponse(type="mcp_approval_response", approve=<bool>, approval_request_id=item.id)` or .NET `CreateMcpApprovalResponseItem(approvalRequestId, approved)`. | Approval is supported through Foundry's MCP approval workflow, not `ask` hook JSON. | Foundry docs recommend `allowed_tools`, requiring approval for high-risk operations, reviewing server/tool/arguments before approval, and treating tool descriptions/results as untrusted. Private MCP endpoints require Foundry private networking and a delegated MCP subnet. |

## How adapters map events to governance checkpoints

| Native event | Checkpoint |
| --- | --- |
| `PreToolUse`, `preToolUse`, `PermissionRequest`, `permissionRequest` | `pre_tool` |
| `UserPromptSubmit`, `userPromptSubmitted` | `goal` |
| `PostToolUse`, `postToolUse`, `PostToolUseFailure`, `postToolUseFailure` | `tool_result` (result or error text included) |
| `SubagentStart`, `subagentStart` | `spawn` |
| `Stop`, `agentStop`, `SubagentStop`, `subagentStop` | `response` |

Non-enforcing or lifecycle-only events such as `SessionStart`, `SessionEnd`, `Notification`, `ErrorOccurred`, and `PreCompact` are forwarded to telemetry with a neutral native response.

## How to enable enforcement per surface

### Claude Code

Run:

```powershell
.\install.ps1 -HookTimeoutSec 120
```

This removes Agent Monitor's existing Claude Code hook entries (any hook whose URL ends in `/hooks/claude-code` or `/ingest/claude-code`), adds fresh `http://127.0.0.1:<port>/hooks/claude-code` entries, keeps every other hook, and sets blocking hook timeouts to the approval budget. On macOS/Linux use `./install.sh --hook-timeout-sec 120`.

### Copilot CLI local

Use command hooks so local pre-tool decisions do not depend on the Copilot HTTP hook TLS rules:

```powershell
.\install.ps1 -CopilotHooks -FailMode open
```

For tamper-resistant machine-wide policy hooks on Windows, run an elevated PowerShell:

```powershell
.\install.ps1 -CopilotPolicyHooks -FailMode closed
```

The forwarder posts to `/hooks/copilot-cli`, prints exactly one `permissionDecision` JSON object for `preToolUse`, and applies `AGENT_GOVERNANCE_FAIL_MODE=open|closed` if the governance service is unreachable.

### Copilot cloud agent

Copy `templates/copilot-cloud-agent/.github/hooks/agent-governance.json` and `.github/hooks/agent-governance.sh` into a repository. Configure:

- `AGENT_GOVERNANCE_URL=https://<control-plane-host>` (must be allow-listed by the cloud agent firewall)
- `AGENT_GOVERNANCE_TOKEN` when the control plane requires bearer auth
- optional `AGENT_GOVERNANCE_FAIL_MODE=open|closed`

### VS Code Local harness

Use the sample at `templates/vscode/agent-governance-hooks.json`, or run:

```powershell
.\install.ps1 -VSCodeHooks
```

The sample calls the forwarder by a workspace-relative path (`./scripts/copilot-hook-forward.sh`, `.\scripts\copilot-hook-forward.ps1`), so copy `scripts/copilot-hook-forward.*` into the target workspace as well, or edit the paths to point at this repository. Ensure `chat.useHooks` is enabled and the workspace is trusted. For Copilot Agent Host sessions in VS Code, follow the Copilot CLI contract instead of the Local harness contract.

## Sources

- Claude Code Hooks reference: <https://docs.anthropic.com/en/docs/claude-code/hooks> (redirects to <https://code.claude.com/docs/en/hooks>)
- GitHub Copilot hooks reference: <https://docs.github.com/en/copilot/reference/hooks-reference>
- VS Code Configure agent hooks: <https://code.visualstudio.com/docs/agent-customization/hooks>
- VS Code Local hooks reference: <https://code.visualstudio.com/docs/agents/reference/hooks-reference>
- Microsoft Foundry Agent Service MCP tool: <https://learn.microsoft.com/en-us/azure/ai-foundry/agents/how-to/tools/model-context-protocol>
