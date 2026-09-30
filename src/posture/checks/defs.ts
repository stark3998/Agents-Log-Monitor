import type { PostureCheckDef, PostureCategory, PostureSeverity } from '../types';
import { ALL_PLATFORMS } from '../utils';

function def(id: string, title: string, description: string, severity: PostureSeverity, category: PostureCategory, level: 'endpoint' | 'fleet' = 'endpoint', autoFix = false, confidence: 'confirmed' | 'heuristic' = 'confirmed', note?: string): PostureCheckDef {
  return {
    id, title, description, severity, category, level, platforms: ALL_PLATFORMS, confidence, note,
    remediation: remediation(id, autoFix),
  };
}

function remediation(id: string, autoFix: boolean): PostureCheckDef['remediation'] {
  const snippets: Record<string, { summary: string; snippet?: string; snippetLang?: PostureCheckDef['remediation']['snippetLang']; docsUrl?: string }> = {
    'file-upload-capability': { summary: 'Remove upload-capable MCP/browser extensions or restrict them to approved corporate destinations.', snippet: '{\n  "mcp.servers": { }\n}', snippetLang: 'json' },
    'ai-screen-capture-capability': { summary: 'Disable screen-capture-capable extensions and MCP servers unless explicitly approved.', snippet: 'Remove desktopCapture/tabCapture permissions or uninstall the extension.', snippetLang: 'text' },
    'ai-telemetry-may-leak-data': { summary: 'Disable prompt/content telemetry or route OTLP only to a corporate collector.', snippet: '{\n  "telemetry.telemetryLevel": "off"\n}', snippetLang: 'json' },
    'ide-agent-terminal-unrestricted': { summary: 'Require confirmation for shell execution and remove wildcard terminal allow rules.', snippet: '{\n  "chat.tools.terminal.autoApprove": {},\n  "chat.tools.terminal.ignoreDefaultAutoApproveRules": false\n}', snippetLang: 'json' },
    'antigravity-autonomous-mode-enabled': { summary: 'Set Antigravity permission mode to request review/default and keep terminal sandboxing enabled.', snippet: '{\n  "toolPermission": "request-review",\n  "artifactReviewPolicy": "asks-for-review",\n  "enableTerminalSandbox": true\n}', snippetLang: 'json' },
    'openhands-confirmation-disabled': { summary: 'Enable human confirmation for OpenHands CLI/legacy settings and avoid headless mode on endpoints.', snippet: '{\n  "confirmation_mode": true\n}', snippetLang: 'json' },
    'mentat-pr-bot-mode-active': { summary: 'Disable Mentat bot automation for local clones or require protected-branch human review.', snippet: 'Remove repo-level .mentat automation or disable the app installation.', snippetLang: 'text' },
    'vscode-global-auto-approve-enabled': { summary: 'Disable global tool auto-approval and use default permission mode.', snippet: '{\n  "chat.tools.global.autoApprove": false,\n  "chat.permissions.default": "default"\n}', snippetLang: 'json' },
    'claude-code-extension-bypass-permission-prompts': { summary: 'Disallow Claude Code bypass permissions and start conversations in default permission mode.', snippet: '{\n  "claudeCode.allowDangerouslySkipPermissions": false,\n  "claudeCode.initialPermissionMode": "default"\n}', snippetLang: 'json' },
    'claude-desktop-third-party-dxt-installed': { summary: 'Remove untrusted Claude Desktop DXT extensions or verify signed Anthropic provenance.', snippet: 'Delete the untrusted extension from Claude Extensions and restart Claude Desktop.', snippetLang: 'text' },
    'aider-yes-mode-enabled': { summary: 'Disable Aider yes-always/yes auto-confirm mode.', snippet: 'yes-always: false', snippetLang: 'yaml' },
    'auto-commits-enabled': { summary: 'Disable automatic commits so generated code is reviewed before committing.', snippet: 'auto-commits: false', snippetLang: 'yaml' },
    'known-vulnerable-software': { summary: 'Upgrade or remove the vulnerable extension/software version.', snippet: 'Update to a non-vulnerable version from the official marketplace.', snippetLang: 'text' },
    'gemini-oauth-tokens-exposed': { summary: 'Restrict Gemini OAuth token files to the current user only.', snippet: 'chmod 600 ~/.gemini/oauth_creds.json', snippetLang: 'bash' },
    'claude-history-contains-secrets': { summary: 'Delete or rotate exposed secrets found in Claude history and reduce history retention.', snippet: '{\n  "cleanupPeriodDays": 7\n}', snippetLang: 'json' },
    'gemini-cli-google-account-linked': { summary: 'Use Vertex AI or API-key auth for managed environments instead of personal Google OAuth.', snippet: '{\n  "security": { "auth": { "selectedType": "vertex-ai" } }\n}', snippetLang: 'json' },
    'plandex-auto-execute-enabled': { summary: 'Use Plandex no/basic autonomy and disable auto-exec on the server.', snippet: 'plandex set-auto none\nplandex set-config auto-exec false', snippetLang: 'bash' },
    'ide-workspace-trust-disabled': { summary: 'Enable IDE workspace trust so untrusted repos cannot execute workspace settings/tasks automatically.', snippet: '{\n  "security.workspace.trust.enabled": true\n}', snippetLang: 'json' },
    'cli-agent-running-as-root': { summary: 'Run coding agents as a regular user inside a constrained workspace/sandbox.', snippet: 'Do not start agents with sudo/root or elevated PowerShell.', snippetLang: 'text' },
    'multiple-coding-agents': { summary: 'Standardize on approved agents and remove unused coding assistants.', snippet: 'Uninstall or disable redundant AI coding agents.', snippetLang: 'text' },
    'antigravity-browser-has-corporate-sessions': { summary: 'Clear Antigravity browser cookies and avoid signing into corporate SaaS in the agent browser.', snippet: 'Clear browsing data for the Antigravity browser profile.', snippetLang: 'text' },
    'antigravity-parallel-agents': { summary: 'Limit Antigravity to one active workspace unless parallel agents are explicitly approved.', snippet: 'Close extra Antigravity agent workspaces.', snippetLang: 'text' },
    'antigravity-multiple-google-accounts': { summary: 'Keep only the approved corporate Google account linked in Antigravity.', snippet: 'Sign out extra Google accounts in Antigravity.', snippetLang: 'text' },
    'aider-api-key-in-config': { summary: 'Move API keys to environment variables or a managed secret store.', snippet: 'openai-api-key: ${OPENAI_API_KEY}', snippetLang: 'yaml' },
    'ai-clipboard-access': { summary: 'Remove clipboard-read permission from AI browser extensions or uninstall them.', snippet: 'Remove "clipboardRead" from manifest permissions.', snippetLang: 'json' },
    'ai-agent-sprawl': { summary: 'Reduce endpoint agent footprint to three or fewer approved AI coding agents.', snippet: 'Uninstall or disable unapproved AI coding agents.', snippetLang: 'text' },
    'cli-agent-scheduled-execution': { summary: 'Remove unattended scheduled execution of coding agents.', snippet: 'crontab -e  # remove agent entries', snippetLang: 'bash' },
    'kiro-third-party-power-installed': { summary: 'Remove Kiro powers installed from non-official registries.', snippet: 'Delete the third-party power or reinstall from https://kiro.dev/powers.', snippetLang: 'text' },
    'ai-agent-non-corporate-user': { summary: 'Sign agents into approved corporate accounts only.', snippet: 'Remove non-corporate accounts from the agent configuration.', snippetLang: 'text' },
    'ai-agent-version-mismatch': { summary: 'Upgrade/downgrade each agent to the fleet standard version.', snippet: 'Install the fleet-approved agent version.', snippetLang: 'text' },
  };
  return { ...snippets[id], autoFix };
}

export const POSTURE_CHECKS: PostureCheckDef[] = [
  def('ai-agent-non-corporate-user', 'AI Agent with Non-Corporate User', 'AI agent has a user from a domain outside the tenant\'s organizational domains and not in the well-known personal-mail allowlist', 'medium', 'Policy Violations', 'fleet'),
  def('file-upload-capability', 'File Upload Capability', 'AI agent with ability to upload files to external services - data exfiltration risk', 'medium', 'Configuration', 'endpoint', false, 'heuristic', 'Inferred from MCP categories/upload-like names and broad browser extension host permissions.'),
  def('ai-screen-capture-capability', 'AI Screen Capture Capability', 'AI tool with screen capture or screenshot ability - may capture sensitive displayed info', 'medium', 'Permissions', 'endpoint', false, 'heuristic', 'Inferred from browser permissions and browser/screenshot MCP server names.'),
  def('ai-telemetry-may-leak-data', 'AI Telemetry May Leak Data', 'AI agent telemetry enabled without data filtering - code may be sent to vendor', 'medium', 'Configuration'),
  def('ide-agent-terminal-unrestricted', 'IDE Agent Terminal Unrestricted', 'AI IDE with unrestricted terminal access - can run any command', 'high', 'Configuration'),
  def('antigravity-autonomous-mode-enabled', 'Antigravity Autonomous Mode Enabled', 'Google Antigravity running in fully autonomous mode without human checkpoints', 'critical', 'Configuration'),
  def('openhands-confirmation-disabled', 'OpenHands Confirmation Disabled', 'OpenHands (formerly OpenDevin) running without human-in-the-loop confirmation', 'critical', 'Configuration', 'endpoint', true),
  def('mentat-pr-bot-mode-active', 'Mentat PR Bot Mode Active', 'Mentat configured as autonomous PR Bot, responding to GitHub Issues without human approval', 'high', 'Configuration', 'endpoint', false, 'heuristic', 'Mentat bot mode has no confirmed local endpoint config; local .mentat automation is used as a proxy.'),
  def('vscode-global-auto-approve-enabled', 'VS Code Global Auto-Approve Enabled', 'VS Code configured to auto-approve ALL tool calls (file edits, MCP, terminal) without user confirmation', 'critical', 'Configuration', 'endpoint', true),
  def('claude-code-extension-bypass-permission-prompts', 'VS Code / Cursor Claude Code Extension Can Bypass Permission Prompts', 'The Claude Code IDE extension is allowed to bypass permission prompts. claudeCode.allowDangerouslySkipPermissions permits the bypass, and claudeCode.initialPermissionMode set to bypassPermissions makes every new conversation start in it.', 'high', 'Configuration', 'endpoint', true),
  def('claude-desktop-third-party-dxt-installed', 'Claude Desktop Third-Party DXT Installed', 'A third-party Claude Desktop extension is installed on this device. Listed extensions launch their own MCP server.', 'high', 'Configuration', 'endpoint', false, 'heuristic', 'Offline DXT provenance is inferred from manifest author/source/signature fields.'),
  def('aider-yes-mode-enabled', 'Aider Yes Mode Enabled', 'Aider running with --yes flag, automatically confirming all operations', 'high', 'Configuration', 'endpoint', true),
  def('auto-commits-enabled', 'Auto-Commits Enabled', 'AI agent is configured to automatically commit changes', 'medium', 'Configuration', 'endpoint', true),
  def('known-vulnerable-software', 'Known Vulnerable Software', 'Browser extension with a known severe vulnerability, curated from public security disclosures.', 'critical', 'Vulnerabilities'),
  def('gemini-oauth-tokens-exposed', 'Gemini OAuth Tokens Exposed', 'Gemini OAuth tokens stored in readable config file', 'high', 'Credential Exposure', 'endpoint', true),
  def('claude-history-contains-secrets', 'Claude History Contains Secrets', 'Claude conversation history contains patterns matching credentials or secrets', 'high', 'Data Storage'),
  def('gemini-cli-google-account-linked', 'Gemini CLI Google Account Linked', 'Google Gemini CLI linked to Google account with broad OAuth scopes', 'medium', 'Configuration'),
  def('plandex-auto-execute-enabled', 'Plandex Auto-Execute Enabled', 'Plandex configured with auto-exec enabled, executing commands without user approval', 'critical', 'Configuration', 'endpoint', false, 'heuristic', 'Plandex stores plan config server-side; shell history/process flags are used as endpoint evidence.'),
  def('ide-workspace-trust-disabled', 'IDE Workspace Trust Disabled', 'Workspace trust disabled in AI IDE - will execute code from untrusted repos', 'medium', 'Configuration', 'endpoint', true),
  def('cli-agent-running-as-root', 'CLI Agent Running as Root', 'CLI agent running with root/sudo privileges - full system access', 'critical', 'Policy Violations'),
  def('multiple-coding-agents', 'Multiple Coding Agents', 'Multiple coding AI agents detected on the same endpoint', 'low', 'Policy Violations'),
  def('antigravity-browser-has-corporate-sessions', 'Antigravity Browser Has Corporate Sessions', 'Antigravity browser profile contains cookies/sessions for corporate SaaS', 'high', 'Configuration', 'endpoint', false, 'heuristic', 'Cookie host_key values are matched against corporate SaaS domains only; values are never read.'),
  def('antigravity-parallel-agents', 'Antigravity Parallel Agents', 'Google Antigravity Manager running multiple parallel agent workspaces', 'medium', 'Configuration', 'endpoint', false, 'heuristic', 'Parallel workspaces are inferred by counting Antigravity workspace/conversation directories.'),
  def('antigravity-multiple-google-accounts', 'Antigravity Multiple Google Accounts', 'Multiple Google accounts linked in Antigravity - spans personal and work', 'medium', 'Configuration', 'endpoint', false, 'heuristic', 'Linked accounts are inferred from Antigravity state JSON/email strings.'),
  def('aider-api-key-in-config', 'Aider API Key in Config', 'Aider configuration contains hardcoded API keys instead of environment variables', 'high', 'Credential Exposure'),
  def('ai-clipboard-access', 'AI Clipboard Access', 'AI extension with clipboard read access - may capture sensitive copied data', 'low', 'Permissions', 'endpoint', false, 'heuristic', 'AI extensions are identified by AI-related names/descriptions and a small known ID set.'),
  def('ai-agent-version-mismatch', 'AI Agent Version Mismatch', 'Same AI agent running different versions across fleet endpoints', 'medium', 'Policy Violations', 'fleet'),
  def('ai-agent-sprawl', 'AI Agent Sprawl', 'Excessive number of AI agents on single endpoint (>3)', 'medium', 'Policy Violations'),
  def('cli-agent-scheduled-execution', 'CLI Agent Scheduled Execution', 'CLI agent scheduled in cron/launchd for unattended autonomous execution', 'high', 'Policy Violations'),
  def('kiro-third-party-power-installed', 'Kiro Third-Party Power Installed', 'Kiro has installed plugins (\'powers\') from a non-official registry.', 'high', 'Configuration', 'endpoint', false, 'heuristic', 'Kiro power install folders/registry files are community-sourced; non-official source URLs are flagged.'),
];

export function checkDef(id: string): PostureCheckDef {
  const found = POSTURE_CHECKS.find(c => c.id === id);
  if (!found) throw new Error(`Unknown posture check ${id}`);
  return found;
}
