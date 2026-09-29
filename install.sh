#!/usr/bin/env bash
set -euo pipefail

PORT=4317
HOOK_TIMEOUT_SEC=120
COPILOT_HOOKS=0
FAIL_MODE=auto
CONTROL_PLANE_URL=""
UNINSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --hook-timeout-sec) HOOK_TIMEOUT_SEC="$2"; shift 2 ;;
    --copilot-hooks) COPILOT_HOOKS=1; shift ;;
    --fail-mode) FAIL_MODE="$2"; shift 2 ;;
    --control-plane-url) CONTROL_PLANE_URL="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$FAIL_MODE" != "auto" && "$FAIL_MODE" != "open" && "$FAIL_MODE" != "closed" ]]; then
  echo "--fail-mode must be auto, open, or closed" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_PATH="$HOME/.claude/settings.json"
LOCAL_BASE_URL="http://127.0.0.1:$PORT"
BASE_URL="${CONTROL_PLANE_URL:-$LOCAL_BASE_URL}"
BASE_URL="${BASE_URL%/}"
CLAUDE_URL="$BASE_URL/hooks/claude-code"
OLD_CLAUDE_URL="$LOCAL_BASE_URL/ingest/claude-code"

need_node() {
  command -v node >/dev/null 2>&1 || { echo "Node.js not found." >&2; exit 1; }
  command -v npm >/dev/null 2>&1 || { echo "npm not found." >&2; exit 1; }
}

patch_claude_hooks() {
  mkdir -p "$(dirname "$SETTINGS_PATH")"
  node - "$SETTINGS_PATH" "$CLAUDE_URL" "$OLD_CLAUDE_URL" "$HOOK_TIMEOUT_SEC" <<'NODE'
const fs = require('node:fs');
const [path, url, oldUrl, timeoutText] = process.argv.slice(2);
const timeout = Number(timeoutText) || 120;
const events = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'SubagentStart', 'SubagentStop', 'Stop', 'Notification'];
const blocking = new Set(['PreToolUse', 'UserPromptSubmit', 'PermissionRequest']);
let settings = {};
try { settings = JSON.parse(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '{}'); } catch { settings = {}; }
settings.hooks ||= {};
const isOurs = h => h && typeof h === 'object' && typeof h.url === 'string' && (h.url === url || h.url === oldUrl || /\/hooks\/claude-code$/.test(h.url) || /\/ingest\/claude-code$/.test(h.url));
for (const key of Object.keys(settings.hooks)) {
  settings.hooks[key] = (Array.isArray(settings.hooks[key]) ? settings.hooks[key] : [])
    .map(group => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return group;
      return { ...group, hooks: group.hooks.filter(h => !isOurs(h)) };
    })
    .filter(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks) || group.hooks.length > 0);
}
for (const event of events) {
  settings.hooks[event] ||= [];
  settings.hooks[event].push({ hooks: [{ type: 'http', url, timeout: blocking.has(event) ? timeout : 5 }] });
}
fs.writeFileSync(path, JSON.stringify(settings, null, 2));
NODE
  echo "Claude Code hooks point to $CLAUDE_URL"
}

install_copilot_hooks() {
  local copilot_home="${COPILOT_HOME:-$HOME/.copilot}"
  local hooks_dir="$copilot_home/hooks"
  local config_path="$hooks_dir/agent-governance.json"
  mkdir -p "$hooks_dir"
  local deadline=$(( HOOK_TIMEOUT_SEC > 5 ? HOOK_TIMEOUT_SEC - 5 : 1 ))
  local forward_sh="$SCRIPT_DIR/scripts/copilot-hook-forward.sh"
  node - "$config_path" "$forward_sh" "$PORT" "$deadline" "$HOOK_TIMEOUT_SEC" "$FAIL_MODE" "$CONTROL_PLANE_URL" <<'NODE'
const fs = require('node:fs');
const [path, script, port, deadline, timeout, failMode, controlPlaneUrl] = process.argv.slice(2);
const events = ['sessionStart', 'sessionEnd', 'userPromptSubmitted', 'preToolUse', 'permissionRequest', 'postToolUse', 'postToolUseFailure', 'agentStop', 'subagentStart', 'subagentStop', 'errorOccurred'];
const env = { AGENT_GOVERNANCE_FAIL_MODE: failMode, AGENT_GOVERNANCE_SURFACE: 'copilot-cli' };
if (controlPlaneUrl) env.AGENT_MONITOR_URL = controlPlaneUrl.replace(/\/$/, '');
const hook = {
  type: 'command',
  bash: `sh '${script}' --port ${port} --timeout ${deadline} --surface copilot-cli`,
  timeoutSec: Number(timeout),
  env,
};
const hooks = {};
for (const event of events) hooks[event] = [hook];
fs.writeFileSync(path, JSON.stringify({ version: 1, hooks }, null, 2));
NODE
  echo "Copilot CLI hooks written to $config_path"
}

uninstall_hooks() {
  if [[ -f "$SETTINGS_PATH" ]]; then
    node - "$SETTINGS_PATH" "$CLAUDE_URL" "$OLD_CLAUDE_URL" <<'NODE'
const fs = require('node:fs');
const [path, url, oldUrl] = process.argv.slice(2);
let settings = {};
try { settings = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { process.exit(0); }
if (settings.hooks) {
  const isOurs = h => h && typeof h === 'object' && typeof h.url === 'string' && (h.url === url || h.url === oldUrl || /\/hooks\/claude-code$/.test(h.url) || /\/ingest\/claude-code$/.test(h.url));
  for (const key of Object.keys(settings.hooks)) {
    settings.hooks[key] = (Array.isArray(settings.hooks[key]) ? settings.hooks[key] : [])
      .map(group => group && typeof group === 'object' && Array.isArray(group.hooks) ? { ...group, hooks: group.hooks.filter(h => !isOurs(h)) } : group)
      .filter(group => !group || typeof group !== 'object' || !Array.isArray(group.hooks) || group.hooks.length > 0);
  }
}
fs.writeFileSync(path, JSON.stringify(settings, null, 2));
NODE
    echo "Removed Claude Code Agent Monitor hook entries."
  fi
  rm -f "${COPILOT_HOME:-$HOME/.copilot}/hooks/agent-governance.json"
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_hooks
  exit 0
fi

need_node
(cd "$SCRIPT_DIR" && npm install --prefer-offline && npm run build)
patch_claude_hooks
if [[ "$COPILOT_HOOKS" -eq 1 ]]; then install_copilot_hooks; fi
cat > "$SCRIPT_DIR/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node dist/server.js
EOF
chmod +x "$SCRIPT_DIR/start.sh"
echo "Installation complete. Start with ./start.sh and restart active agent sessions."
